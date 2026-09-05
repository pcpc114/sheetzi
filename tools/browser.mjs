#!/usr/bin/env node
/**
 * Real-browser end-to-end test.
 *
 * Boots the server, launches headless Chrome (or Edge) over the DevTools Protocol, and
 * drives the actual UI: it clicks cells, types formulas with real key events, and opens
 * a SECOND tab on the same document to prove that live collaboration works between two
 * genuine browser clients.
 *
 * Every console error, every uncaught exception and every failed network request in the
 * page is collected and reported — a page that "looks fine" while throwing on every
 * keystroke fails here.
 *
 * No dependency beyond `ws` (already required by the server).
 *
 * Usage: node tools/browser.mjs [--headed]
 */
import { spawn } from 'node:child_process';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import { harnessEnv, spawnServer } from './harness-env.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.BROWSER_TEST_PORT || 39621);
const CDP_PORT = Number(process.env.CDP_PORT || 39622);
const BASE = `http://127.0.0.1:${PORT}`;
const HEADED = process.argv.includes('--headed');
const DEBUG = process.argv.includes('--debug');

const BROWSERS = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0;
const failures = [];
function check(name, cond, detail = '') {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failures.push(`${name}${detail ? ` — ${detail}` : ''}`); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
}

// --------------------------------------------------------------- CDP plumbing
class Cdp {
  constructor(wsUrl) { this.wsUrl = wsUrl; this.id = 0; this.pending = new Map(); this.listeners = []; }
  async connect() {
    this.ws = new WebSocket(this.wsUrl, { maxPayload: 64 * 1024 * 1024 });
    await new Promise((res, rej) => {
      const to = setTimeout(() => rej(new Error('CDP connect timeout')), 15000);
      this.ws.once('open', () => { clearTimeout(to); res(); });
      this.ws.once('error', (e) => { clearTimeout(to); rej(e); });
    });
    this.ws.on('message', (buf) => {
      const msg = JSON.parse(buf.toString());
      if (msg.id && this.pending.has(msg.id)) {
        const { res, rej } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? rej(new Error(`${msg.error.message} (${JSON.stringify(msg.error.data ?? '')})`)) : res(msg.result);
      } else if (msg.method) {
        for (const fn of this.listeners) fn(msg);
      }
    });
    return this;
  }
  send(method, params = {}, sessionId) {
    const id = ++this.id;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise((res, rej) => {
      this.pending.set(id, { res, rej });
      this.ws.send(JSON.stringify(payload));
      setTimeout(() => {
        if (this.pending.has(id)) { this.pending.delete(id); rej(new Error(`CDP ${method} timed out`)); }
      }, 30000);
    });
  }
  on(fn) { this.listeners.push(fn); }
  close() { try { this.ws?.close(); } catch { /* ignore */ } }
}

/** One browser tab, with its own error log. */
class Tab {
  constructor(cdp, sessionId, label) {
    this.cdp = cdp; this.sid = sessionId; this.label = label;
    this.errors = []; this.consoleErrors = []; this.failedRequests = []; this.dialogs = [];
  }
  static async open(cdp, url, label) {
    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    const tab = new Tab(cdp, sessionId, label);
    cdp.on((msg) => {
      if (msg.sessionId !== sessionId) return;
      if (msg.method === 'Runtime.exceptionThrown') {
        const d = msg.params.exceptionDetails;
        tab.errors.push(`${d.text} ${d.exception?.description || ''}`.trim().split('\n')[0]);
      } else if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
        tab.consoleErrors.push(msg.params.args.map((a) => a.value ?? a.description ?? a.type).join(' ').split('\n')[0]);
      } else if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error') {
        const e = msg.params.entry;
        (e.source === 'network' ? tab.failedRequests : tab.consoleErrors).push(`${e.text} ${e.url || ''}`.trim());
      } else if (msg.method === 'Page.javascriptDialogOpening') {
        // A native alert/confirm/prompt blocks the renderer thread, which would hang
        // every later CDP call. Dismiss it so the run continues, and record it: a
        // modal during normal operation is itself a defect worth failing on.
        tab.dialogs.push(`${msg.params.type}: ${msg.params.message}`);
        cdp.send('Page.handleJavaScriptDialog', { accept: true, promptText: '테스트' }, sessionId)
          .catch(() => {});
      }
    });
    await cdp.send('Runtime.enable', {}, sessionId);
    await cdp.send('Page.enable', {}, sessionId);
    await cdp.send('Log.enable', {}, sessionId);
    // Record every WebSocket frame the page receives, before any app code runs.
    // When collaboration misbehaves this is the only way to tell a server that never
    // sent a frame from a client that ignored one.
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
      source: `(() => {
        window.__frames = [];
        const Native = window.WebSocket;
        window.WebSocket = function (...args) {
          const ws = new Native(...args);
          ws.addEventListener('message', (e) => {
            try { window.__frames.push(String(e.data).slice(0, 400)); } catch (_) {}
          });
          window.__ws = ws;
          return ws;
        };
        window.WebSocket.prototype = Native.prototype;
        Object.assign(window.WebSocket, Native);
      })()`,
    }, sessionId);
    await cdp.send('Emulation.setDeviceMetricsOverride',
      { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false }, sessionId);
    await cdp.send('Page.navigate', { url }, sessionId);
    await tab.waitFor(() => true, 100); // let navigation start
    return tab;
  }
  async eval(expression) {
    const r = await this.cdp.send('Runtime.evaluate',
      { expression, returnByValue: true, awaitPromise: true }, this.sid);
    if (r.exceptionDetails) throw new Error(`${this.label}: ${r.exceptionDetails.text} ${r.exceptionDetails.exception?.description || ''}`.split('\n')[0]);
    return r.result.value;
  }
  /** Poll an in-page predicate until it returns truthy. */
  async waitFor(exprOrFn, timeout = 8000, label = 'condition') {
    const expr = typeof exprOrFn === 'string' ? exprOrFn : null;
    const deadline = Date.now() + timeout;
    let last;
    while (Date.now() < deadline) {
      try { last = expr ? await this.eval(expr) : true; if (last) return last; } catch (e) { last = e.message; }
      await sleep(100);
    }
    throw new Error(`${this.label}: timed out waiting for ${label} (last=${JSON.stringify(last)?.slice(0, 200)})`);
  }
  async clickCell(a1) {
    const box = await this.eval(`(() => {
      const el = document.querySelector('[data-a1="${a1}"]');
      if (!el) return null;
      const r = el.getBoundingClientRect();
      // Near the LEFT edge, not the centre: a cell whose text overflows renders as a node
      // wide enough to cover its empty neighbours, so its centre can fall in the NEXT
      // column and the click would select that one instead. The grid hit-tests by
      // coordinate, which is correct behaviour — the test just has to aim inside the
      // cell's own column.
      return { x: Math.round(r.left + Math.min(12, r.width / 2)),
               y: Math.round(r.top + r.height / 2) };
    })()`);
    if (!box) throw new Error(`${this.label}: cell ${a1} is not rendered`);
    for (const type of ['mousePressed', 'mouseReleased']) {
      await this.cdp.send('Input.dispatchMouseEvent',
        { type, x: box.x, y: box.y, button: 'left', clickCount: 1, buttons: type === 'mousePressed' ? 1 : 0 }, this.sid);
    }
    await sleep(60);
  }
  async type(text) {
    for (const ch of text) {
      await this.cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', text: ch, key: ch, unmodifiedText: ch }, this.sid);
      await this.cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: ch }, this.sid);
      await sleep(12);
    }
  }
  /**
   * A real Ctrl+<key>, the way a person presses it. document.execCommand('copy') is
   * not a substitute: in a headless context it silently does nothing, and a test built
   * on it reports a broken clipboard as working.
   */
  async ctrl(key, code, keyCode) {
    const base = { key, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode, modifiers: 2 };
    await this.cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...base }, this.sid);
    await this.cdp.send('Input.dispatchKeyEvent', { type: 'char', text: key, key, code, modifiers: 2 }, this.sid)
      .catch(() => {});
    await this.cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base }, this.sid);
    await sleep(450);
  }

  /** modifiers: CDP bitmask — Alt 1, Ctrl 2, Meta 4, Shift 8. */
  async key(key, code, keyCode, modifiers = 0) {
    const base = { key, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode, modifiers };
    await this.cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', ...base }, this.sid);
    await this.cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base }, this.sid);
    await sleep(80);
  }
  cellText(a1) {
    return this.eval(`(document.querySelector('[data-a1="${a1}"]')||{}).textContent ?? null`);
  }
  /**
   * Poll an in-page expression until it equals `expected`, and NEVER sleep a constant in
   * its place.
   *
   * A fixed sleep is a guess about how long a machine will take, and every guess is wrong
   * somewhere. An edit crosses a 60 ms send-coalescing window; a repaint waits for the next
   * frame; a cross-tab edit adds the socket, the server and the peer's own repaint on top.
   * On a loaded machine — a CI box, or this one with a build running beside it — any
   * constant chosen is occasionally too short, and the run then fails with no defect behind
   * it. Which is worse than it sounds: a suite that fails at random is a suite people rerun
   * until it passes, and that habit is how a real failure gets rerun away too.
   *
   * A poll costs nothing when the page is quick and waits when it is not. `sleep()` is
   * still right where nothing is being ASSERTED — letting the UI settle between two
   * gestures — but never between an action and the check that reads its result.
   */
  async evalBecomes(expression, expected, timeout = 8000) {
    const deadline = Date.now() + timeout;
    let seen = null;
    while (Date.now() < deadline) {
      try { seen = await this.eval(expression); } catch (e) { seen = e.message; }
      if (seen === expected) return { ok: true, seen };
      await sleep(80);
    }
    return { ok: false, seen };
  }
  /**
   * The same poll where the value being waited for is not one constant — a count that has
   * to grow, a shape that has to arrive. The LAST reading is returned either way, so the
   * assertion and its diagnostic both speak about what was actually on screen.
   */
  async evalUntil(expression, accept, timeout = 8000) {
    const deadline = Date.now() + timeout;
    let seen = null;
    for (;;) {
      try { seen = await this.eval(expression); } catch (e) { seen = e.message; }
      if (accept(seen)) return seen;
      if (Date.now() >= deadline) return seen;
      await sleep(80);
    }
  }
  /** Poll a cell until it reads `expected`. The rule above is why this exists. */
  async cellBecomes(a1, expected, timeout = 8000) {
    const deadline = Date.now() + timeout;
    let seen = null;
    while (Date.now() < deadline) {
      seen = await this.cellText(a1);
      if (seen === expected) return { ok: true, seen };
      await sleep(80);
    }
    return { ok: false, seen };
  }
  async screenshot(path) {
    // A hidden tab produces no frames, so captureScreenshot blocks until the CDP timeout.
    await this.cdp.send('Page.bringToFront', {}, this.sid).catch(() => {});
    await sleep(250);
    const { data } = await this.cdp.send('Page.captureScreenshot',
      { format: 'png', captureBeyondViewport: false }, this.sid);
    const { writeFile } = await import('node:fs/promises');
    await writeFile(path, Buffer.from(data, 'base64'));
  }
}

// ------------------------------------------------------------------- run
const exe = BROWSERS.find((p) => existsSync(p));
if (!exe) { console.error('browser: no Chrome/Edge found'); process.exit(2); }
if (!existsSync(join(ROOT, 'server.js'))) { console.error('browser: server.js missing'); process.exit(2); }

await mkdir(join(ROOT, 'data'), { recursive: true });
const profile = await mkdtemp(join(tmpdir(), 'sz-chrome-'));
const serverLog = [];
let server = null, chrome = null, cdp = null, docId = null;
const createdDocIds = [];   // documents the test itself creates, removed in finally

console.log(`browser: ${exe.split(/[\\/]/).pop()}  server :${PORT}  cdp :${CDP_PORT}\n`);

try {
  // Through tools/harness-env.mjs, never spawn() directly: this harness creates and
  // deletes documents, and server.js now reads .env at startup. The helper pins the
  // backend to the local file store so the operator's real project is never touched.
  server = spawnServer({
    env: harnessEnv({ PORT: String(PORT) }, { label: 'browser' }),
    label: 'browser',
  });
  server.stdout.on('data', (d) => serverLog.push(d.toString()));
  server.stderr.on('data', (d) => serverLog.push(d.toString()));

  const deadline = Date.now() + 20000;
  for (;;) {
    try { if ((await fetch(`${BASE}/healthz`, { signal: AbortSignal.timeout(800) })).ok) break; } catch { /* retry */ }
    if (Date.now() > deadline) throw new Error(`server never became healthy\n${serverLog.join('')}`);
    await sleep(200);
  }

  const doc = await (await fetch(`${BASE}/api/docs`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: '브라우저 테스트' }),
  })).json();
  docId = doc.id;

  chrome = spawn(exe, [
    HEADED ? '--new-window' : '--headless=new',
    '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--disable-extensions', '--disable-background-networking', '--disable-sync',
    '--disable-features=Translate,MediaRouter,OptimizationHints',
    '--force-device-scale-factor=1',
    `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profile}`,
    'about:blank',
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  chrome.stdout.on('data', () => {});
  chrome.stderr.on('data', () => {});

  let wsUrl = null;
  const cdpDeadline = Date.now() + 25000;
  while (Date.now() < cdpDeadline) {
    try {
      const v = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`, { signal: AbortSignal.timeout(800) })).json();
      wsUrl = v.webSocketDebuggerUrl; if (wsUrl) break;
    } catch { /* retry */ }
    await sleep(250);
  }
  if (!wsUrl) throw new Error('Chrome DevTools endpoint never came up');
  cdp = await new Cdp(wsUrl).connect();
  // Without this the clipboard is inert in headless Chrome and every copy/paste check
  // would pass by doing nothing at all.
  await cdp.send('Browser.grantPermissions', {
    origin: BASE, permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite'],
  }).catch(() => {});
  check('headless browser launches and exposes DevTools', true);

  // ------------------------------------------------------------ tab 1 loads
  const url = `${BASE}/edit#doc=${docId}`;
  const t1 = await Tab.open(cdp, url, 'tab1');
  await t1.waitFor('document.readyState === "complete"', 15000, 'document ready');
  await t1.waitFor('!!document.querySelector(".sz-cell")', 15000, 'grid cells to render');
  check('page loads and the grid renders cells', true);

  const counts = await t1.eval(`({
    cells: document.querySelectorAll('.sz-cell').length,
    colheads: document.querySelectorAll('.sz-colhead').length,
    rowheads: document.querySelectorAll('.sz-rowhead').length,
    toolbarBtns: document.querySelectorAll('.sz-tb-btn').length,
    fbar: !!document.querySelector('.sz-finput'),
    namebox: !!document.querySelector('.sz-namebox'),
    corner: !!document.querySelector('.sz-corner'),
  })`);
  check('column headers rendered', counts.colheads > 5, `n=${counts.colheads}`);
  check('row headers rendered', counts.rowheads > 5, `n=${counts.rowheads}`);
  check('toolbar built its buttons', counts.toolbarBtns >= 10, `n=${counts.toolbarBtns}`);
  check('formula bar and name box exist', counts.fbar && counts.namebox);
  check('select-all corner exists', counts.corner);
  check('windowed rendering keeps the node count sane', counts.cells > 0 && counts.cells < 4000, `n=${counts.cells}`);

  const wsState = await t1.waitFor(
    `(document.querySelector('#sz-status')||{}).textContent || ''`, 10000, 'status text');
  check('websocket connected (status shows 연결됨)', /연결/.test(String(wsState)) && !/오프라인/.test(String(wsState)), `status="${wsState}"`);

  // ------------------------------------------------- typing a value + formula
  await t1.clickCell('B2');
  await t1.type('12');
  await t1.key('Enter', 'Enter', 13);
  await t1.clickCell('B3');
  await t1.type('30');
  await t1.key('Enter', 'Enter', 13);
  await t1.clickCell('B4');
  await t1.type('=SUM(B2:B3)*2');
  await t1.key('Enter', 'Enter', 13);

  const b2Typed = await t1.cellBecomes('B2', '12');
  check('typed number lands in the cell', b2Typed.ok, `B2="${b2Typed.seen}"`);
  const b4Sum = await t1.cellBecomes('B4', '84');
  check('formula computes in the browser', b4Sum.ok, `B4="${b4Sum.seen}"`);

  await t1.clickCell('B4');
  const fbarText = await t1.evalBecomes(`document.querySelector('.sz-finput').value`, '=SUM(B2:B3)*2');
  check('formula bar shows the raw formula, not the result', fbarText.ok, `fbar="${fbarText.seen}"`);
  const nameBox = await t1.evalBecomes(`document.querySelector('.sz-namebox').value`, 'B4');
  check('name box shows the active reference', nameBox.ok, `namebox="${nameBox.seen}"`);

  // Korean text must survive a round trip through the editor
  await t1.clickCell('C2');
  await t1.type('한글 입력');
  await t1.key('Enter', 'Enter', 13);
  const korean = await t1.cellBecomes('C2', '한글 입력');
  check('Korean text can be typed into a cell', korean.ok, `C2="${korean.seen}"`);

  // Arrow-key navigation moves the active cell
  await t1.clickCell('B2');
  await t1.key('ArrowDown', 'ArrowDown', 40);
  await t1.key('ArrowRight', 'ArrowRight', 39);
  const moved = await t1.evalBecomes(`document.querySelector('.sz-namebox').value`, 'C3');
  check('arrow keys move the selection', moved.ok, `namebox="${moved.seen}"`);

  // Escape must abandon an edit
  await t1.clickCell('D5');
  await t1.type('버려질값');
  await t1.key('Escape', 'Escape', 27);
  // An abandoned edit puts nothing on screen, so there is no value to poll FOR. The editor
  // going idle is the event: `cancelEdit` hides and empties it (grid.js `_setEditorIdle`),
  // and a commit would leave it idle too — so this waits for the edit to be OVER, however
  // it ended, and only then asks what the cell holds. A commit is still caught: it would
  // put 버려질값 in D5 before the editor went idle.
  const escaped = await t1.evalBecomes(`document.querySelector('.sz-editor').style.opacity`, '0');
  const d5 = await t1.cellText('D5');
  check('Escape cancels an in-progress edit', escaped.ok && d5 === '',
    `editor opacity="${escaped.seen}" D5="${d5}"`);

  // Delete clears a cell
  await t1.clickCell('B2');
  await t1.key('Delete', 'Delete', 46);
  // B4 falling to 60 IS the recalculation, and it cannot happen while B2 still holds 12 —
  // so it is the event to wait for. B2 is then read once: polling a cell for the empty
  // string it held before the Delete would assert nothing at all.
  const b4Recalc = await t1.cellBecomes('B4', '60');
  const b2Cleared = await t1.cellText('B2');
  check('Delete clears the cell', b2Cleared === '', `B2="${b2Cleared}"`);
  check('dependent formula recalculates after the clear', b4Recalc.ok, `B4="${b4Recalc.seen}"`);

  // Undo restores it
  await t1.eval(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'z',ctrlKey:true,bubbles:true}))`);
  const afterUndo = await t1.cellBecomes('B2', '12');
  check('Ctrl+Z undoes the clear', afterUndo.ok, `B2="${afterUndo.seen}"`);

  // -------------------------------------------- tab 2: live collaboration
  const t2 = await Tab.open(cdp, url, 'tab2');
  await t2.waitFor('document.readyState === "complete"', 15000, 'tab2 ready');
  await t2.waitFor('!!document.querySelector(".sz-cell")', 15000, 'tab2 grid');
  await sleep(600);

  const rInit = await t2.cellBecomes('B3', '30');
  check('second tab loads the same document with existing data', rInit.ok, `B3="${rInit.seen}"`);
  const rKorean = await t2.cellBecomes('C2', '한글 입력');
  check('second tab shows the computed formula result', rKorean.ok, `C2="${rKorean.seen}"`);

  const peerCount = await t2.eval(`document.querySelectorAll('#sz-peers .sz-peer').length`);
  check('presence shows both users', peerCount >= 2, `peers=${peerCount}`);

  // tab2 edits -> tab1 must update without a reload
  await t2.clickCell('B3');
  await t2.type('100');
  await t2.key('Enter', 'Enter', 13);
  const rB3 = await t1.cellBecomes('B3', '100');
  check("tab1 sees tab2's edit live", rB3.ok, `tab1 B3="${rB3.seen}"`);
  const rB4 = await t1.cellBecomes('B4', '224');
  check('tab1 recomputes its formula from the remote edit', rB4.ok, `tab1 B4="${rB4.seen}"`);

  // tab1 edits -> tab2 must update
  await t1.clickCell('E1');
  await t1.type('왕복');
  await t1.key('Enter', 'Enter', 13);
  const rE1 = await t2.cellBecomes('E1', '왕복');
  check("tab2 sees tab1's edit live", rE1.ok, `tab2 E1="${rE1.seen}"`);

  // ------------------------------------------------- peer cursor does not obscure
  // Nudge the peer into sending a fresh cursor, then give the relay a moment.
  await t2.clickCell('D8');
  await sleep(700);
  const probe = `({
    cursors: document.querySelectorAll('.sz-peer-cursor').length,
    labels: document.querySelectorAll('.sz-peer-label').length,
    chips: document.querySelectorAll('#sz-peers .sz-peer').length,
    chipTitles: [...document.querySelectorAll('#sz-peers .sz-peer')].map(e=>e.title||e.textContent).join('/'),
    status: (document.getElementById('sz-status')||{}).textContent,
    namebox: (document.querySelector('.sz-namebox')||{}).value,
    overlay: !!document.querySelector('.sz-overlay, .sz-peer-layer'),
  })`;
  const peerDebug = await t1.eval(probe);
  const peerDebug2 = await t2.eval(probe);
  void peerDebug2;
  if (DEBUG) {
    console.log(`    [t1] ${JSON.stringify(peerDebug)}`);
    console.log(`    [t2] ${JSON.stringify(peerDebug2)}`);
    const framesT1 = await t1.eval(`(window.__frames||[]).map(f => f.slice(0,90))`);
    console.log(`    [t1 frames ${framesT1.length}]`);
    for (const f of framesT1) console.log(`        ${f}`);
  }
  const labelGeom = await t1.eval(`(() => {
    const lab = document.querySelector('.sz-peer-label');
    if (!lab) return null;
    const box = lab.parentElement;
    const l = lab.getBoundingClientRect();
    const b = box.getBoundingClientRect();
    return {
      labTop: Math.round(l.top), labBottom: Math.round(l.bottom),
      cellTop: Math.round(b.top), cellBottom: Math.round(b.bottom),
      overlapPx: Math.round(Math.min(l.bottom, b.bottom) - Math.max(l.top, b.top)),
    };
  })()`);
  check('a remote peer cursor is drawn on the grid', !!labelGeom, `no .sz-peer-label; ${JSON.stringify(peerDebug)}`);
  if (labelGeom) {
    // The chip is designed to tuck against the cell's top border (its bottom-left
    // corner is square for exactly that reason), so a couple of pixels of overlap is
    // intentional. What must never happen is the chip sitting over the cell's text.
    check('peer name label sits above the cell instead of covering its value',
      labelGeom.overlapPx <= 4, JSON.stringify(labelGeom));
  }

  // ----------------------------------------------------- toolbar interaction
  await t1.clickCell('B3');
  const boldBefore = await t1.eval(`getComputedStyle(document.querySelector('[data-a1="B3"]')).fontWeight`);
  await t1.eval(`(() => {
    const b = [...document.querySelectorAll('.sz-tb-btn')].find(x => /굵게/.test(x.title || ''));
    if (!b) return false; b.click(); return true;
  })()`);
  const WEIGHT = `getComputedStyle(document.querySelector('[data-a1="B3"]')).fontWeight`;
  const boldLocal = await t1.evalBecomes(WEIGHT, '700');
  check('toolbar bold changes the cell rendering', boldLocal.ok && boldBefore !== boldLocal.seen,
    `${boldBefore} -> ${boldLocal.seen}`);
  const boldRemote = await t2.evalBecomes(WEIGHT, boldLocal.seen);
  check('style change propagates to the other tab', boldRemote.ok, `tab2=${boldRemote.seen}`);

  // --------------------------------------------------------------- sheet tabs
  const bar = await t1.eval(`({
    bar: !!document.querySelector('.sz-sheetbar'),
    add: !!document.querySelector('.sz-sheet-add'),
    tabs: document.querySelectorAll('.sz-sheet-tab').length,
    active: (document.querySelector('.sz-sheet-tab-active')||{}).textContent,
  })`);
  check('the sheet bar renders with one tab', bar.bar && bar.add && bar.tabs >= 1,
    JSON.stringify(bar));
  check('the single sheet is the active tab', !!bar.active, JSON.stringify(bar));

  // '+' adds a sheet, and the other tab must learn about it live
  await t1.eval(`document.querySelector('.sz-sheet-add').click()`);
  const twoTabs = await t1.evalBecomes(`document.querySelectorAll('.sz-sheet-tab').length`, 2);
  check('the + button adds a sheet', twoTabs.ok, `tabs=${twoTabs.seen}`);
  const twoOnPeer = await t2.evalBecomes(`document.querySelectorAll('.sz-sheet-tab').length`, 2);
  check('the other tab sees the new sheet live', twoOnPeer.ok, `tabs=${twoOnPeer.seen}`);

  // the new sheet is active, empty, and independent of the first
  const emptyOnNew = await t1.evalBecomes(
    `(document.querySelector('[data-a1="B3"]')||{}).textContent`, '');
  check('switching to the new sheet shows an empty grid', emptyOnNew.ok, `B3="${emptyOnNew.seen}"`);

  await t1.clickCell('A1');
  await t1.type('두번째시트');
  await t1.key('Enter', 'Enter', 13);
  const typedOnNew = await t1.cellBecomes('A1', '두번째시트');
  check('typing into the second sheet works', typedOnNew.ok, `A1="${typedOnNew.seen}"`);

  // switching back must restore the first sheet's data untouched
  await t1.eval(`document.querySelectorAll('.sz-sheet-tab')[0].click()`);
  const backToFirst = await t1.cellBecomes('B3', '100');
  check('switching back restores the first sheet', backToFirst.ok, `B3="${backToFirst.seen}"`);
  const firstA1 = await t1.cellText('A1');
  check("the first sheet did not inherit the second sheet's edit", firstA1 !== '두번째시트',
    `A1="${firstA1}"`);

  // and forward again, without a refetch
  await t1.eval(`document.querySelectorAll('.sz-sheet-tab')[1].click()`);
  const forwardAgain = await t1.cellBecomes('A1', '두번째시트');
  check('switching forward again keeps the second sheet data', forwardAgain.ok, `A1="${forwardAgain.seen}"`);

  // the peer's edit on sheet 2 reaches tab1 while tab1 is on sheet 2
  await t2.eval(`document.querySelectorAll('.sz-sheet-tab')[1].click()`);
  await sleep(300);
  await t2.clickCell('A2');
  await t2.type('상대편');
  await t2.key('Enter', 'Enter', 13);
  const peerOnSheet2 = await t1.cellBecomes('A2', '상대편');
  check('a peer edit on the second sheet arrives live', peerOnSheet2.ok, `A2="${peerOnSheet2.seen}"`);

  const hashOk = await t1.eval(`/[#&]sheet=/.test(location.hash)`);
  check('the URL hash carries the active sheet', hashOk === true,
    await t1.eval(`location.hash`));

  // ------------------------------------------------------- text overflow modes
  // 넘치기 / 줄바꿈 / 자르기 must be three visibly different things. They were briefly
  // two: the spec claimed cells already spilled into empty neighbours, and they never had.
  await t1.eval(`document.querySelectorAll('.sz-sheet-tab')[0].click()`);
  await sleep(350);
  await t1.clickCell('B8');
  await t1.type('아주아주아주아주긴텍스트입니다정말로깁니다');
  await t1.key('Enter', 'Enter', 13);
  await t1.clickCell('B8');
  const baseW = await t1.eval(
    `Math.round(document.querySelector('[data-a1="B8"]').getBoundingClientRect().width)`);

  // Open the dropdown, let it build, THEN choose. Doing both inside one evaluation
  // races the menu's own construction and can click a node that is on its way out.
  const pickWrap = async (label) => {
    await t1.eval(`(() => {
      const open = [...document.querySelectorAll('.sz-tb-btn, .sz-tb-wrap')]
        .find(x => /줄바꿈/.test((x.title || '') + (x.getAttribute('aria-label') || '')));
      if (open) open.click();
    })()`);
    await sleep(300);
    return t1.eval(`(() => {
      const all = [...document.querySelectorAll('[data-drop-item="1"]')];
      const panels = [...document.querySelectorAll('.sz-tb-drop')]
        .map(p => ({ cls: p.className, hidden: p.hidden, disp: getComputedStyle(p).display }));
      const item = all.find(x => (x.textContent || '').trim() === ${JSON.stringify('PH')});
      if (!item) {
        return 'NO-ITEM items=[' + all.map(x => (x.textContent||'').trim()).join('|')
          + '] panels=' + JSON.stringify(panels);
      }
      const selBefore = (document.querySelector('.sz-namebox') || {}).value;
      window.__cmds = window.__cmds || [];
      item.click();
      const selAfter = (document.querySelector('.sz-namebox') || {}).value;
      return 'ok sel=' + selBefore + '->' + selAfter
        + ' item=' + item.className + '/' + (item.dataset.value || '?');
    })()`.replace(JSON.stringify('PH'), JSON.stringify(label)));
  };

  const spill = await pickWrap('넘치기');
  check('the wrap control offers 넘치기', String(spill).startsWith('ok'), String(spill));
  if (String(spill).startsWith('ok')) {
    const widened = await t1.evalBecomes(
      `Math.round(document.querySelector('[data-a1="B8"]').getBoundingClientRect().width) > ${baseW}`,
      true);
    check('넘치기 lets the text run past its own column', widened.ok,
      `base=${baseW}px, now=${await t1.eval(`Math.round(document.querySelector('[data-a1="B8"]').getBoundingClientRect().width)`)}px`);
  }

  // a neighbour with content must stop the spill
  await t1.clickCell('D8');
  await t1.type('막음');
  await t1.key('Enter', 'Enter', 13);
  await t1.cellBecomes('D8', '막음');
  const stopped = await t1.evalBecomes(`(() => {
    const b = document.querySelector('[data-a1="B8"]');
    const d = document.querySelector('[data-a1="D8"]');
    if (!b || !d) return 'missing';
    return Math.round(b.getBoundingClientRect().right) <= Math.round(d.getBoundingClientRect().left) + 1;
  })()`, true);
  check('the spill stops at a neighbour that holds something', stopped.ok, `${stopped.seen}`);

  // Typing into D8 moved the selection; 자르기 has to be applied to B8, not to whatever
  // the caret happens to be sitting on.
  await t1.clickCell('B8');
  await t1.evalBecomes(`document.querySelector('.sz-namebox').value`, 'B8');
  const clip = await pickWrap('자르기');
  const stored = await (await fetch(`${BASE}/api/docs/${docId}`)).json();
  const b8 = stored.sheets?.[0]?.cells?.B8;
  const clipDiag0 = { storedStyle: b8 && b8.style };
  const clipDiag = await t1.eval(`(() => {
    const b = document.querySelector('[data-a1="B8"]');
    return b ? { w: Math.round(b.getBoundingClientRect().width),
                 ws: getComputedStyle(b).whiteSpace, z: b.style.zIndex } : null;
  })()`);
  const backToBase = await t1.evalBecomes(
    `Math.round(document.querySelector('[data-a1="B8"]').getBoundingClientRect().width)`, baseW);
  check('자르기 returns the cell to its own column width', backToBase.ok,
    `pick=${clip} diag=${JSON.stringify(clipDiag)} ${JSON.stringify(clipDiag0)}`);

  // ------------------------------------------------------- format painter + zoom
  await t1.eval(`document.querySelectorAll('.sz-sheet-tab')[0].click()`);
  await sleep(350);
  await t1.clickCell('B12');
  await t1.type('원본');
  await t1.key('Enter', 'Enter', 13);
  await t1.clickCell('B12');
  await t1.eval(`(() => {
    const b = [...document.querySelectorAll('.sz-tb-btn')]
      .find(x => /굵게/.test(x.title || ''));
    if (b) b.click();
  })()`);
  await t1.evalBecomes(
    `getComputedStyle(document.querySelector('[data-a1="B12"]')).fontWeight`, '700');
  await t1.clickCell('C12');
  await t1.type('대상');
  await t1.key('Enter', 'Enter', 13);
  await t1.clickCell('D12');
  await t1.type('대상2');
  await t1.key('Enter', 'Enter', 13);

  // arm the painter from B12, then DRAG across C12:D12 — the whole range must get the
  // style, not just the anchor the mousedown emitted.
  await t1.clickCell('B12');
  const armed = await t1.eval(`(() => {
    const b = document.querySelector('.sz-tb-painter')
      || [...document.querySelectorAll('.sz-tb-btn')].find(x => /서식 복사/.test(x.title || ''));
    if (!b) return false;
    b.click();
    return true;
  })()`);
  check('the toolbar exposes a format painter', armed === true);
  if (armed) {
    const at = async (a1) => t1.eval(`(() => {
      const e = document.querySelector('[data-a1="${a1}"]');
      if (!e) return null;
      const r = e.getBoundingClientRect();
      return { x: Math.round(r.left + Math.min(12, r.width / 2)), y: Math.round(r.top + r.height / 2) };
    })()`);
    const c = await at('C12');
    const d = await at('D12');
    if (c && d) {
      await t1.cdp.send('Input.dispatchMouseEvent',
        { type: 'mousePressed', x: c.x, y: c.y, button: 'left', clickCount: 1, buttons: 1 }, t1.sid);
      await t1.cdp.send('Input.dispatchMouseEvent',
        { type: 'mouseMoved', x: d.x, y: d.y, button: 'left', buttons: 1 }, t1.sid);
      await t1.cdp.send('Input.dispatchMouseEvent',
        { type: 'mouseReleased', x: d.x, y: d.y, button: 'left', clickCount: 1, buttons: 0 }, t1.sid);
    }
    const bothBold = await t1.evalBecomes(`(() => {
      const c = document.querySelector('[data-a1="C12"]');
      const d = document.querySelector('[data-a1="D12"]');
      if (!c || !d) return 'missing';
      return getComputedStyle(c).fontWeight === '700' && getComputedStyle(d).fontWeight === '700';
    })()`, true);
    const painterDiag = await t1.eval(`(() => {
      const w = (a) => { const e = document.querySelector('[data-a1="' + a + '"]');
                         return e ? getComputedStyle(e).fontWeight : 'none'; };
      return { sel: (document.querySelector('.sz-namebox')||{}).value,
               B12: w('B12'), C12: w('C12'), D12: w('D12'),
               painting: document.querySelector('.sz-painting') ? 'on' : 'off' };
    })()`);
    check('the painter applies to the whole dragged range, not just the anchor',
      bothBold.ok, `${bothBold.seen} ${JSON.stringify(painterDiag)}`);
  }

  // zoom changes the rendered geometry but never the stored column width
  const beforeZoom = await t1.eval(
    `Math.round(document.querySelector('[data-a1="B12"]').getBoundingClientRect().width)`);
  const zoomed = await t1.eval(`(() => {
    const g = window.__szgrid;
    return false;
  })()`);
  void zoomed;
  const zoomPicked = await t1.eval(`(() => {
    const b = document.querySelector('.sz-tb-zoom')
      || [...document.querySelectorAll('.sz-tb-btn')].find(x => /확대|축소/.test(x.title || ''));
    if (!b) return 'NO-CONTROL';
    b.click();
    return 'opened';
  })()`);
  if (zoomPicked === 'opened') {
    await sleep(300);
    const chose = await t1.eval(`(() => {
      const items = [...document.querySelectorAll('[data-drop-item="1"]')];
      const it = items.find(x => (x.textContent || '').trim() === '150%');
      if (!it) return 'NO-ITEM ' + items.map(x => (x.textContent||'').trim()).join('|');
      it.click();
      return 'ok';
    })()`);
    check('the zoom control offers 150%', chose === 'ok', String(chose));
    if (chose === 'ok') {
      const bigger = await t1.evalBecomes(
        `Math.round(document.querySelector('[data-a1="B12"]').getBoundingClientRect().width) > ${beforeZoom}`,
        true);
      check('zoom scales the rendered grid', bigger.ok, `was ${beforeZoom}px`);
      const stored = await (await fetch(`${BASE}/api/docs/${docId}`)).json();
      check('zoom is a view preference and is never written to the document',
        !('zoom' in (stored.sheets?.[0] || {})) && !('zoom' in stored),
        Object.keys(stored.sheets?.[0] || {}).join(','));
      // put it back so later checks measure normal geometry
      await t1.eval(`(() => {
        const b = document.querySelector('.sz-tb-zoom');
        if (b) b.click();
      })()`);
      await sleep(300);
      await t1.eval(`(() => {
        const it = [...document.querySelectorAll('[data-drop-item="1"]')]
          .find(x => (x.textContent || '').trim() === '100%');
        if (it) it.click();
      })()`);
      await t1.evalBecomes(
        `Math.round(document.querySelector('[data-a1="B12"]').getBoundingClientRect().width)`,
        beforeZoom);
    }
  }

  // ------------------------------------------------------ filter / chart / comment
  // Build a small table on a fresh sheet so these do not fight the earlier fixtures.
  await t1.eval(`(() => { const a = document.querySelector('.sz-sheet-add'); if (a) a.click(); })()`);
  await sleep(700);
  const TABLE = [['과일', '수량'], ['사과', '3'], ['배', '1'], ['감', '2'], ['포도', '5']];
  for (let r = 0; r < TABLE.length; r++) {
    for (let c = 0; c < 2; c++) {
      await t1.clickCell(String.fromCharCode(65 + c) + (r + 1));
      await t1.type(TABLE[r][c]);
      await t1.key('Enter', 'Enter', 13);
    }
  }
  await t1.cellBecomes('A5', '포도');

  // select A1:B5, then turn a filter on
  await t1.clickCell('A1');
  const b5 = await t1.eval(`(() => {
    const e = document.querySelector('[data-a1="B5"]');
    if (!e) return null;
    const r = e.getBoundingClientRect();
    return { x: Math.round(r.left + 12), y: Math.round(r.top + r.height / 2) };
  })()`);
  if (b5) {
    for (const type of ['mousePressed', 'mouseReleased']) {
      await t1.cdp.send('Input.dispatchMouseEvent',
        { type, x: b5.x, y: b5.y, button: 'left', clickCount: 1,
          buttons: type === 'mousePressed' ? 1 : 0, modifiers: 8 }, t1.sid);
    }
  }
  await t1.evalBecomes(`document.querySelector('.sz-namebox').value`, 'A1:B5');

  const filterOn = await t1.eval(`(() => {
    const b = document.querySelector('.sz-tb-filter')
      || [...document.querySelectorAll('.sz-tb-btn')].find(x => /필터/.test(x.title || ''));
    if (!b) return 'NO-CONTROL';
    b.click();
    return 'ok';
  })()`);
  check('the toolbar exposes a filter control', filterOn === 'ok', String(filterOn));

  if (filterOn === 'ok') {
    const glyphs = await t1.evalBecomes(
      `document.querySelectorAll('.sz-filter-btn').length >= 2`, true);
    check('turning a filter on marks the header cells', glyphs.ok, String(glyphs.seen));

    // The glyph opens on MOUSEDOWN, so a synthetic .click() never reaches it.
    const gpos = await t1.eval(`(() => {
      const g = document.querySelectorAll('.sz-filter-btn')[1];
      if (!g) return null;
      const r = g.getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
    })()`);
    if (gpos) {
      for (const type of ['mousePressed', 'mouseReleased']) {
        await t1.cdp.send('Input.dispatchMouseEvent',
          { type, x: gpos.x, y: gpos.y, button: 'left', clickCount: 1,
            buttons: type === 'mousePressed' ? 1 : 0 }, t1.sid);
      }
    }
    await sleep(600);
    const sorted = await t1.eval(`(() => {
      const all = [...document.querySelectorAll('.sz-filter-panel button, .sz-filter-panel [role], [data-drop-item="1"]')];
      const it = all.find(x => /내림차순|내림/.test(x.textContent || ''));
      if (!it) return 'NO-ITEM panels=' + document.querySelectorAll('.sz-filter-panel').length
        + ' items=[' + all.map(x => (x.textContent||'').trim()).join('|') + ']';
      it.click();
      return 'ok';
    })()`);
    check('the filter menu offers a descending sort', sorted === 'ok', String(sorted));

    if (sorted === 'ok') {
      const order = await t1.evalBecomes(`(() => {
        return [...document.querySelectorAll('.sz-cell[data-a1]')]
          .filter(e => /^B[2-5]$/.test(e.dataset.a1) && e.textContent.trim())
          .sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top)
          .map(e => e.textContent.trim()).join(',');
      })()`, '5,3,2,1');
      check('sorting reorders the rows on screen', order.ok, `order="${order.seen}"`);

      const stored = await (await fetch(`${BASE}/api/docs/${docId}`)).json();
      const sh = stored.sheets[stored.sheets.length - 1];
      check('sorting is a VIEW: the stored rows are untouched',
        sh.cells && sh.cells.B2 && sh.cells.B2.input === '3'
          && sh.cells.B5 && sh.cells.B5.input === '5',
        `B2=${sh.cells && sh.cells.B2 && sh.cells.B2.input} B5=${sh.cells && sh.cells.B5 && sh.cells.B5.input}`);
      check('the filter itself is persisted', !!sh.filter, JSON.stringify(sh.filter || null));
    }
  }

  // a chart must never emit NaN geometry, not even at the edge of the double range
  await t1.clickCell('A1');
  await t1.eval(`(() => {
    const b = document.querySelector('.sz-tb-chart')
      || [...document.querySelectorAll('.sz-tb-btn')].find(x => /차트/.test(x.title || ''));
    if (b) b.click();
  })()`);
  await sleep(900);
  const svgProbe = `(() => {
    const svg = document.querySelector('.sz-chart');
    if (!svg) return 'NO-CHART';
    const bad = [...svg.querySelectorAll('*')].some(el =>
      [...el.attributes].some(a => /NaN|Infinity/.test(a.value)));
    const marks = svg.querySelectorAll('rect, path, polyline, polygon, circle').length;
    return bad ? 'NaN-IN-SVG' : (marks > 0 ? 'ok' : 'EMPTY');
  })()`;
  const chartOk = await t1.eval(svgProbe);
  check('inserting a chart draws finite geometry', chartOk === 'ok', String(chartOk));

  if (chartOk === 'ok') {
    await t1.clickCell('B2');
    await t1.type('1e308');
    await t1.key('Enter', 'Enter', 13);
    await t1.clickCell('B3');
    await t1.type('-1e308');
    await t1.key('Enter', 'Enter', 13);
    await sleep(900);
    const extreme = await t1.eval(svgProbe);
    check('a chart survives values at the edge of the double range', extreme === 'ok', String(extreme));
  }

  // a comment's author and time are stamped by the SERVER
  await t1.clickCell('A2');
  const commented = await t1.eval(`(() => {
    const b = document.querySelector('.sz-tb-comment')
      || [...document.querySelectorAll('.sz-tb-btn')].find(x => /댓글/.test(x.title || ''));
    if (!b) return 'NO-CONTROL';
    b.click();
    return 'ok';
  })()`);
  check('the toolbar exposes a comment control', commented === 'ok', String(commented));

  if (commented === 'ok') {
    await sleep(500);
    const typed = await t1.eval(`(() => {
      const ta = document.querySelector('.sz-comment-panel textarea, .sz-comment-panel input[type=text]');
      if (!ta) return 'NO-INPUT';
      const setter = Object.getOwnPropertyDescriptor(ta.constructor.prototype, 'value').set;
      setter.call(ta, '첫 댓글');
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      const send = [...document.querySelectorAll('.sz-comment-panel button')]
        .find(x => /등록|저장|추가|작성|달기/.test(x.textContent || ''));
      if (!send) return 'NO-SEND buttons=' + [...document.querySelectorAll('.sz-comment-panel button')]
        .map(x => (x.textContent || '').trim()).join('|');
      send.click();
      return 'ok';
    })()`);
    check('the comment panel accepts text', typed === 'ok', String(typed));
    if (typed === 'ok') {
      await sleep(1000);
      const doc2 = await (await fetch(`${BASE}/api/docs/${docId}`)).json();
      const sh = doc2.sheets[doc2.sheets.length - 1];
      const thread = sh.comments && sh.comments.A2;
      check('a comment is stored on its cell', !!thread,
        JSON.stringify(sh.comments || {}).slice(0, 140));
      if (thread) {
        const msg = thread.messages && thread.messages[0];
        check('the server stamped an author and a time',
          !!msg && typeof msg.author === 'string' && msg.author.length > 0
            && Number.isFinite(msg.at) && msg.at > 0,
          JSON.stringify(msg));
        check('the comment text was stored verbatim',
          !!msg && msg.text === '첫 댓글', msg && msg.text);
      }
    }
  }

  // ------------------------------------------------- copy carries the formatting
  // Copying a cell in a spreadsheet means copying how it LOOKS as well as what it says.
  // Borders are the case that exposes a shallow implementation: `bd` is the only nested
  // style value, so a copy that spreads one level shares its edges with the live cell.
  await t1.eval(`document.querySelectorAll('.sz-sheet-tab')[0].click()`);
  await sleep(350);
  await t1.clickCell('B15');
  await t1.type('서식원본');
  await t1.key('Enter', 'Enter', 13);
  await t1.clickCell('B15');
  await t1.eval(`(() => {
    const b = [...document.querySelectorAll('.sz-tb-btn')].find(x => /굵게/.test(x.title || ''));
    if (b) b.click();
  })()`);
  await t1.evalBecomes(
    `getComputedStyle(document.querySelector('[data-a1="B15"]')).fontWeight`, '700');

  // put a border on it through the 테두리 picker
  const borderApplied = await t1.eval(`(() => {
    const b = document.querySelector('.sz-tb-border')
      || [...document.querySelectorAll('.sz-tb-btn')].find(x => /테두리/.test(x.title || ''));
    if (!b) return 'NO-CONTROL';
    b.click();
    return 'opened';
  })()`);
  check('the toolbar exposes a border control', borderApplied === 'opened', String(borderApplied));
  if (borderApplied === 'opened') {
    await sleep(350);
    const picked = await t1.eval(`(() => {
      const items = [...document.querySelectorAll('.sz-tb-border-preset, [data-drop-item="1"]')]
        .filter(x => /전체/.test((x.title || '') + (x.textContent || '')));
      if (!items.length) return 'NO-PRESET';
      items[0].click();
      return 'ok';
    })()`);
    check('the border picker offers 전체 테두리', picked === 'ok', String(picked));

    if (picked === 'ok') {
      // Saves are debounced on the server, so poll rather than reading once.
      const cellAt = async (key) => {
        for (let i = 0; i < 40; i++) {
          const d = await (await fetch(`${BASE}/api/docs/${docId}`)).json();
          const c = d.sheets[0].cells && d.sheets[0].cells[key];
          if (c && c.style && c.style.bd) return c;
          await sleep(150);
        }
        const d = await (await fetch(`${BASE}/api/docs/${docId}`)).json();
        return d.sheets[0].cells && d.sheets[0].cells[key];
      };
      const cell = await cellAt('B15');
      const bdDiag = await t1.eval(`(() => {
        const items = [...document.querySelectorAll('.sz-tb-border-preset, [data-drop-item="1"]')];
        return { presets: document.querySelectorAll('.sz-tb-border-preset').length,
                 titles: items.slice(0, 14).map(x => (x.title || x.textContent || '').trim()).join('|'),
                 panelOpen: !!document.querySelector('.sz-tb-drop-border, .sz-tb-drop') };
      })()`);
      check('the border is stored on the source cell',
        !!(cell && cell.style && cell.style.bd),
        JSON.stringify(cell && cell.style) + ' ' + JSON.stringify(bdDiag));

      // copy B15, paste into D15
      await t1.clickCell('B15');
      await t1.ctrl('c', 'KeyC', 67);
      await t1.clickCell('D15');
      await t1.ctrl('v', 'KeyV', 86);
      await sleep(700);

      const dst = await cellAt('D15');
      // Asserted strictly. An earlier version of this check passed when the paste
      // produced nothing at all, which is precisely the failure it exists to catch.
      const pastedOk = !!(dst && dst.style && dst.style.bd && dst.style.b);
      check('pasting carries the formatting, borders included', pastedOk,
        `D15=${JSON.stringify(dst)}`);

      if (pastedOk) {
        // the copy must be DETACHED: clearing the source must not disturb the paste
        await t1.clickCell('B15');
        await t1.eval(`(() => {
          const b = document.querySelector('.sz-tb-border');
          if (b) b.click();
        })()`);
        await sleep(350);
        await t1.eval(`(() => {
          const it = [...document.querySelectorAll('.sz-tb-border-preset, [data-drop-item="1"]')]
            .find(x => /지우기|없음/.test((x.title || '') + (x.textContent || '')));
          if (it) it.click();
        })()`);
        await sleep(700);
        const d2 = await cellAt('D15');
        check('the pasted formatting is detached from the source cell',
          !!(d2 && d2.style && d2.style.bd), JSON.stringify(d2 && d2.style));
      }
    }
  }

  // -------------------------------- Delete keeps formatting, Ctrl+X takes it
  // These are two different operations and they used to send the same patch, so the
  // screen and the server disagreed about the cell until the next reload: a cut left
  // its border painted locally while the server had dropped the whole cell, and Delete
  // did the reverse — the formatting looked kept but was gone on the server.
  await t1.eval(`document.querySelectorAll('.sz-sheet-tab')[0].click()`);
  await sleep(350);

  const paintOf = async (a1) => t1.eval(`(() => {
    const e = document.querySelector('[data-a1="${a1}"]');
    if (!e) return null;
    const cs = getComputedStyle(e);
    return { text: e.textContent, insets: (cs.boxShadow.match(/inset/g) || []).length,
             weight: cs.fontWeight };
  })()`);
  /**
   * `paintOf`, polled to a deadline: the reading returned is the first one `ready` accepts,
   * or the last one taken. What `ready` waits for is the CHANGE the gesture makes — the
   * content going, the border arriving — and the assertions then run on that same reading,
   * so nothing here is asserted against a constant somebody guessed.
   */
  const paintWhen = async (a1, ready, timeout = 8000) => {
    const deadline = Date.now() + timeout;
    for (;;) {
      const seen = await paintOf(a1);
      if (seen && ready(seen)) return seen;
      if (Date.now() >= deadline) return seen;
      await sleep(80);
    }
  };
  const cellOn = async (key) => {
    const d = await (await fetch(`${BASE}/api/docs/${docId}`)).json();
    return d.sheets[0].cells && d.sheets[0].cells[key];
  };
  const decorate = async (a1) => {
    await t1.clickCell(a1);
    await t1.type('서식셀');
    await t1.key('Enter', 'Enter', 13);
    await t1.clickCell(a1);
    await t1.eval(`(() => {
      const b = [...document.querySelectorAll('.sz-tb-btn')].find(x => /굵게/.test(x.title || ''));
      if (b) b.click();
    })()`);
    await t1.evalBecomes(`getComputedStyle(document.querySelector('[data-a1="${a1}"]')).fontWeight`, '700');
    await t1.eval(`(() => { const b = document.querySelector('.sz-tb-border'); if (b) b.click(); })()`);
    await sleep(350);
    await t1.eval(`(() => {
      const it = [...document.querySelectorAll('.sz-tb-border-preset, [data-drop-item="1"]')]
        .find(x => /전체/.test((x.title || '') + (x.textContent || '')));
      if (it) it.click();
    })()`);
    await sleep(600);
  };

  // --- Delete: content goes, formatting stays -------------------------------
  await decorate('B18');
  const beforeDel = await paintOf('B18');
  check('a decorated cell paints its border', beforeDel && beforeDel.insets > 2,
    JSON.stringify(beforeDel));

  await t1.clickCell('B18');
  await t1.key('Delete', 'Delete', 46);
  // The content going is the event; the formatting staying is what is being asserted, so
  // the reading both checks run on is taken once the clear has actually happened.
  const afterDel = await paintWhen('B18', (p) => p.text === '');
  check('Delete clears the content', afterDel && afterDel.text === '', JSON.stringify(afterDel));
  check('Delete KEEPS the formatting on screen',
    afterDel && afterDel.insets > 2 && afterDel.weight === '700', JSON.stringify(afterDel));
  const delStored = await (async () => {
    for (let i = 0; i < 30; i++) {
      const c = await cellOn('B18');
      if (c && c.style && c.style.bd) return c;
      await sleep(200);
    }
    return await cellOn('B18');
  })();
  check('Delete keeps the formatting on the SERVER too, so a reload agrees',
    !!(delStored && delStored.style && delStored.style.bd), JSON.stringify(delStored));

  // --- Ctrl+X: everything goes ----------------------------------------------
  await decorate('B19');
  await t1.clickCell('B19');
  await t1.ctrl('x', 'KeyX', 88);
  const afterCut = await paintWhen('B19', (p) => p.text === '');
  check('Ctrl+X clears the content', afterCut && afterCut.text === '', JSON.stringify(afterCut));
  check('Ctrl+X ALSO clears the formatting on screen, with no reload',
    afterCut && afterCut.insets <= 2 && afterCut.weight !== '700', JSON.stringify(afterCut));
  const cutStored = await (async () => {
    for (let i = 0; i < 30; i++) {
      const c = await cellOn('B19');
      if (!c) return null;
      await sleep(200);
    }
    return await cellOn('B19');
  })();
  check('and the server agrees the cell is gone', !cutStored, JSON.stringify(cutStored));

  // --- and the cut formatting lands on the paste target ---------------------
  await t1.clickCell('D19');
  await t1.ctrl('v', 'KeyV', 86);
  const pastedPaint = await paintWhen('D19', (p) => p.insets > 2 && p.weight === '700');
  check('the cut formatting appears at the paste target immediately',
    pastedPaint && pastedPaint.insets > 2 && pastedPaint.weight === '700',
    JSON.stringify(pastedPaint));

  // ------------------------------------------------------------ growing a sheet
  // A sheet used to be stuck at its starting 200 x 26 with no way past it: 행 삽입 shifts
  // cells inside the sheet and never changes its extent.
  // Foreground first. Several tabs are open by now and Chrome throttles a long-
  // backgrounded tab's rAF *and* its timers to the point where a scroll-driven repaint
  // can be a minute away — which is not the state a person reading their own sheet is in,
  // and it would make this block measure the throttle rather than the grid.
  await t1.cdp.send('Page.bringToFront', {}, t1.sid).catch(() => {});
  await sleep(300);

  // On a FRESH sheet: the blocks above leave this document scrolled, zoomed, filtered
  // and merged in various places, and growth is about geometry, so it deserves a clean
  // one rather than whatever state happens to be left over.
  await t1.eval(`(() => { const a = document.querySelector('.sz-sheet-add'); if (a) a.click(); })()`);
  await sleep(800);
  const growSheetIdx = await t1.eval(`document.querySelectorAll('.sz-sheet-tab').length - 1`);

  const extentOf = async () => {
    const d = await (await fetch(`${BASE}/api/docs/${docId}`)).json();
    const sh = d.sheets[growSheetIdx] || d.sheets[d.sheets.length - 1];
    return { rows: sh.rows, cols: sh.cols };
  };
  const extent0 = await extentOf();
  check('a sheet starts at the documented size', extent0.rows === 200 && extent0.cols === 26,
    JSON.stringify(extent0));

  const growUi = await t1.eval(`(() => {
    const root = document.getElementById('sz-grow-root');
    if (!root) return 'NO-ROOT';
    const btns = [...root.querySelectorAll('button')].map(b => (b.textContent || '').trim());
    return { buttons: btns, inputs: root.querySelectorAll('input').length };
  })()`);
  check('the grow bar is mounted below the grid',
    growUi && growUi.inputs >= 2 && growUi.buttons.length >= 2, JSON.stringify(growUi));

  // press 행 추가
  const grewRows = await t1.eval(`(() => {
    const root = document.getElementById('sz-grow-root');
    // The button itself only says 개 추가; the axis lives on the group class.
    const b = root.querySelector('.sz-grow-rows .sz-grow-btn')
      || [...root.querySelectorAll('button')].find(x => /행/.test(x.title || ''));
    if (!b) return 'NO-BUTTON groups=' + [...root.children].map(e => e.className).join('|');
    b.click();
    return 'ok';
  })()`);
  check('the grow bar offers an add-rows button', grewRows === 'ok', String(grewRows));

  if (grewRows === 'ok') {
    const after = await (async () => {
      for (let i = 0; i < 40; i++) {
        const e = await extentOf();
        if (e.rows > extent0.rows) return e;
        await sleep(200);
      }
      return await extentOf();
    })();
    check('adding rows grows the sheet and persists', after.rows > extent0.rows,
      `${extent0.rows} -> ${after.rows}`);
    check('adding rows does not touch the columns', after.cols === extent0.cols,
      `cols ${extent0.cols} -> ${after.cols}`);

    // the grid must actually render the new rows
    // Scroll ONCE, then only observe. Re-issuing the scroll inside the poll would both
    // re-trigger auto-grow and read the DOM in the same tick the scroll was written,
    // before the grid had a frame to render — a loop that can never see its own effect.
    await t1.eval(`(() => {
      const v = document.querySelector('.sz-viewport');
      if (v) v.scrollTop = v.scrollHeight;
    })()`);
    const reached = await t1.evalBecomes(`(() => {
      const heads = [...document.querySelectorAll('.sz-rowhead')]
        .map(e => parseInt(e.textContent, 10)).filter(n => Number.isFinite(n));
      return heads.length ? Math.max(...heads) > 200 : false;
    })()`, true, 15000);
    const lastRow = await t1.eval(`(() => {
      const heads = [...document.querySelectorAll('.sz-rowhead')]
        .map(e => parseInt(e.textContent, 10)).filter(n => Number.isFinite(n));
      return heads.length ? Math.max(...heads) : 0;
    })()`);
    check('the grid renders rows past the old limit', reached.ok, `last visible row=${lastRow}`);

    // growing must not disturb existing data
    // A fresh sheet has no cells, so the meaningful check is that growth did not
    // disturb the OTHER sheets of this document.
    const stored = await (await fetch(`${BASE}/api/docs/${docId}`)).json();
    check('growing one sheet leaves the other sheets alone',
      !!(stored.sheets[0].cells && Object.keys(stored.sheets[0].cells).length > 0),
      `sheet1 cells=${Object.keys(stored.sheets[0].cells || {}).length}`);

    // and the extent is shown, so the size is never a mystery
    // The extent has its own element: the selection readout ellipsises, and the size is
    // exactly what a person looks for when the grid seems to stop too soon.
    const extentText = await t1.eval(`(document.getElementById('sz-extent')||{}).textContent || ''`);
    check('the status bar reports the sheet size',
      /행/.test(extentText) && /열/.test(extentText), extentText);

    // Back to the top, and WAIT for it: the next block clicks B2, which is not rendered
    // while the viewport is still parked a thousand rows down.
    await t1.eval(`(() => {
      const v = document.querySelector('.sz-viewport');
      if (v) { v.scrollTop = 0; v.scrollLeft = 0; }
    })()`);
    let backToTop = await t1.evalBecomes(
      `!!document.querySelector('[data-a1="B2"]')`, true, 4000);
    if (!backToTop.ok) {
      // A programmatic write to an offset the element is ALREADY at fires no scroll
      // event, so a grid whose cached offset drifted has nothing to resync from. A real
      // wheel tick tells us which of the two that is.
      await t1.cdp.send('Input.dispatchMouseEvent',
        { type: 'mouseWheel', x: 500, y: 400, deltaX: 0, deltaY: -400 }, t1.sid).catch(() => {});
      backToTop = await t1.evalBecomes(`!!document.querySelector('[data-a1="B2"]')`, true, 6000);
      if (backToTop.ok) console.log('    [진단] 휠 이벤트로 복구됨 — 캐시된 스크롤이 어긋나 있었음');
    }
    const topDiag = await t1.eval(`(() => {
      const v = document.querySelector('.sz-viewport');
      const heads = [...document.querySelectorAll('.sz-rowhead')]
        .map(e => parseInt(e.textContent, 10)).filter(n => Number.isFinite(n));
      const cells = [...document.querySelectorAll('.sz-cell[data-a1]')].length;
      return { scrollTop: v ? Math.round(v.scrollTop) : -1,
               scrollHeight: v ? v.scrollHeight : -1,
               clientHeight: v ? v.clientHeight : -1,
               rowsShown: heads.length ? [Math.min(...heads), Math.max(...heads)] : [],
               cells };
    })()`);
    check('scrolling back to the top re-renders the first rows', backToTop.ok,
      `B2 present=${backToTop.seen} ${JSON.stringify(topDiag)}`);
  }

  // --------------------------------------- keyboard selection updates the chrome
  // Extending a selection with Shift+Arrow has to tell the host, exactly like a mouse
  // drag does. When it does not, the name box, the 합계/평균/개수 readout and the merge
  // button all keep showing the state of the previous, smaller selection.
  await t1.eval(`document.querySelectorAll('.sz-sheet-tab')[0].click()`);
  await sleep(350);
  await t1.clickCell('B2');
  await t1.evalBecomes(`document.querySelector('.sz-namebox').value`, 'B2');
  await t1.key('ArrowDown', 'ArrowDown', 40, 8);
  await t1.key('ArrowRight', 'ArrowRight', 39, 8);
  const extended = await t1.evalBecomes(`document.querySelector('.sz-namebox').value`, 'B2:C3');
  check('Shift+Arrow updates the name box', extended.ok, `namebox="${extended.seen}"`);
  // The status bar names the selection; assert on the range it reports rather than on
  // any particular wording, so a copy change does not fail this.
  const statsShown = await t1.evalBecomes(
    `/B2:C3/.test((document.getElementById('sz-selstats')||{}).textContent || '')`, true);
  check('Shift+Arrow updates the selection statistics', statsShown.ok,
    await t1.eval(`(document.getElementById('sz-selstats')||{}).textContent`));

  // ------------------------------------------------------------ merged cells
  // Merging keeps the top-left value and clears the rest, so the feature has to hold
  // together across rendering, selection, the formula engine, replication and undo.
  //
  // The =COUNTA probe is planted BEFORE the merge on purpose. It proves two things at
  // once: that the cleared cells really are empty, and that clearing them propagates
  // through the dependency graph. It also keeps the merge on TOP of the undo stack, so
  // the Ctrl+Z below tests what it claims to.
  await t1.eval(`document.querySelectorAll('.sz-sheet-tab')[0].click()`);
  await t2.eval(`document.querySelectorAll('.sz-sheet-tab')[0].click()`);
  await sleep(400);

  await t1.clickCell('F2');
  await t1.type('병합제목');
  await t1.key('Enter', 'Enter', 13);
  await t1.clickCell('G2');
  await t1.type('버려질값');
  await t1.key('Enter', 'Enter', 13);
  await t1.clickCell('F5');
  await t1.type('=COUNTA(F2:H2)');
  await t1.key('Enter', 'Enter', 13);
  const before = await t1.cellBecomes('F5', '2');
  check('two filled cells before merging', before.ok, `F5="${before.seen}"`);

  // select F2:H2 (click F2, shift-click H2), then merge from the toolbar
  await t1.clickCell('F2');
  const h2 = await t1.eval(`(() => {
    const el = document.querySelector('[data-a1="H2"]');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  })()`);
  if (h2) {
    for (const type of ['mousePressed', 'mouseReleased']) {
      await t1.cdp.send('Input.dispatchMouseEvent',
        { type, x: h2.x, y: h2.y, button: 'left', clickCount: 1,
          buttons: type === 'mousePressed' ? 1 : 0, modifiers: 8 }, t1.sid);
    }
  }
  // The name box repaints through the coalescing scheduler, so poll rather than
  // sleeping a guessed amount and reading a stale value.
  const selLabel = await t1.evalBecomes(`document.querySelector('.sz-namebox').value`, 'F2:H2');
  check('shift-click selects the range to merge', selLabel.ok, `namebox="${selLabel.seen}"`);

  const mergeClicked = await t1.eval(`(() => {
    const b = [...document.querySelectorAll('.sz-tb-btn, .sz-tb-merge')]
      .find(x => /병합/.test((x.title || '') + (x.getAttribute('aria-label') || '')));
    if (!b) return false;
    b.click();
    return true;
  })()`);
  check('the toolbar exposes a merge control', mergeClicked === true);

  const mergedNode = await t1.evalBecomes(
    `(document.querySelector('[data-a1="F2"]') || {}).getAttribute
       ? (document.querySelector('[data-a1="F2"]').getAttribute('data-merge') || '') : ''`,
    'F2:H2');
  check('merging renders one cell spanning the range', mergedNode.ok, `data-merge=${mergedNode.seen}`);
  check('a covered cell renders no node at all',
    (await t1.eval(`!!document.querySelector('[data-a1="G2"]')`)) === false);
  check('the anchor keeps its value', (await t1.cellText('F2')) === '병합제목');

  const wide = await t1.eval(`(() => {
    const m = document.querySelector('[data-merge="F2:H2"]');
    const one = document.querySelector('[data-a1="F5"]');
    if (!m || !one) return null;
    return { merged: Math.round(m.getBoundingClientRect().width),
             single: Math.round(one.getBoundingClientRect().width) };
  })()`);
  check('the merged cell is visually wider than one column',
    wide && wide.merged > wide.single * 2, JSON.stringify(wide));

  const after = await t1.cellBecomes('F5', '1');
  check('clearing the covered cells recalculated the dependent formula', after.ok,
    `F5="${after.seen}" (the merge must empty G2 through the engine, not just visually)`);

  const onPeer = await t2.evalBecomes(`!!document.querySelector('[data-merge="F2:H2"]')`, true);
  check('the merge replicates to the other tab', onPeer.ok, `${onPeer.seen}`);

  // Undo must put BOTH halves back: the merge geometry and the cleared contents.
  await t1.eval(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'z',ctrlKey:true,bubbles:true}))`);
  const unmergedBack = await t1.evalBecomes(`!!document.querySelector('[data-merge="F2:H2"]')`, false);
  check('Ctrl+Z removes the merge', unmergedBack.ok, `still merged=${unmergedBack.seen}`);
  const restored = await t1.cellBecomes('G2', '버려질값');
  check('Ctrl+Z also restores the cell the merge cleared', restored.ok, `G2="${restored.seen}"`);
  const recalced = await t1.cellBecomes('F5', '2');
  check('and the dependent formula recalculates back', recalced.ok, `F5="${recalced.seen}"`);
  const goneOnPeer = await t2.evalBecomes(`!!document.querySelector('[data-merge="F2:H2"]')`, false);
  check('the undo replicates to the other tab too', goneOnPeer.ok, `${goneOnPeer.seen}`);

  // ------------------------------------------- undo must follow its own sheet
  // Ctrl+Z on sheet B must never silently rewrite sheet A. The history entry records
  // the sheet it belongs to and switches back before applying, so pressing undo while
  // looking at another tab has to jump to the edited sheet and undo THERE.
  await t1.eval(`document.querySelectorAll('.sz-sheet-tab')[0].click()`);
  await sleep(350);
  await t1.clickCell('D1');
  await t1.type('되돌릴값');
  await t1.key('Enter', 'Enter', 13);
  const wrote = await t1.cellBecomes('D1', '되돌릴값');
  check('a value is written on the first sheet', wrote.ok, `D1="${wrote.seen}"`);

  await t1.eval(`document.querySelectorAll('.sz-sheet-tab')[1].click()`);
  await sleep(350);
  const onSheet2 = await t1.eval(`(document.querySelector('.sz-sheet-tab-active')||{}).textContent`);
  await t1.eval(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'z',ctrlKey:true,bubbles:true}))`);
  await sleep(600);
  const backOnSheet1 = await t1.evalBecomes(
    `document.querySelectorAll('.sz-sheet-tab')[0].getAttribute('aria-selected')`, 'true');
  check('undo from another sheet jumps back to the sheet it belongs to', backOnSheet1.ok,
    `was on "${onSheet2}", aria-selected=${backOnSheet1.seen}`);
  const undone = await t1.cellBecomes('D1', '');
  check('and the undo applied to that sheet', undone.ok, `D1="${undone.seen}"`);

  // ------------------------------------------------ copy across sheets
  await t1.clickCell('B3');
  await t1.ctrl('c', 'KeyC', 67);
  await t1.eval(`document.querySelectorAll('.sz-sheet-tab')[1].click()`);
  await sleep(350);
  await t1.clickCell('D4');
  await t1.ctrl('v', 'KeyV', 86);
  await sleep(500);
  const pasted = await t1.cellBecomes('D4', '100');
  check('copying from one sheet and pasting into another carries the value',
    pasted.ok, `D4="${pasted.seen}"`);
  await t1.eval(`document.querySelectorAll('.sz-sheet-tab')[0].click()`);
  await sleep(300);

  // Capture the app in its most representative state — real data, two sheets, a peer
  // cursor — before the documents test navigates to a fresh empty document.
  await t1.eval(`document.querySelectorAll('.sz-sheet-tab')[0].click()`);
  await sleep(400);
  await mkdir(join(ROOT, 'docs', 'shots'), { recursive: true });
  await t1.screenshot(join(ROOT, 'docs', 'shots', 'app.png'));
  console.log('  screenshot: docs/shots/app.png');

  // ------------------------------------------------------------- documents menu
  const docsUi = await t1.eval(`({
    root: !!document.getElementById('sz-docs-root'),
    buttons: document.querySelectorAll('#sz-docs-root button').length,
  })`);
  check('the documents menu is mounted in the header', docsUi.root && docsUi.buttons >= 2,
    JSON.stringify(docsUi));

  // Open the panel and look at it properly. A functional check ("the button exists")
  // passes even when a module's classes have no CSS at all and every control renders as
  // a native ButtonFace box, so measure and screenshot instead of assuming.
  await t1.eval(`(() => {
    const b = [...document.querySelectorAll('#sz-docs-root button')]
      .find(x => /내 문서/.test(x.textContent || ''));
    if (b) b.click();
  })()`);
  await sleep(600);
  const panel = await t1.eval(`(() => {
    const p = document.querySelector('.sz-docs-panel');
    if (!p) return null;
    const unstyled = [];
    for (const cls of ['sz-docs-head','sz-docs-title','sz-docs-list','sz-docs-refresh',
                       'sz-docs-name','sz-docs-time','sz-docs-actions']) {
      const el = p.querySelector('.' + cls);
      if (!el) continue;
      const cs = getComputedStyle(el);
      // A button nobody styled keeps the UA's border + centred text.
      if (el.tagName === 'BUTTON' && cs.borderTopStyle !== 'none' && cs.borderTopWidth !== '0px') {
        unstyled.push(cls + ':native-border');
      }
    }
    const r = p.getBoundingClientRect();
    return {
      visible: r.width > 0 && r.height > 0,
      offscreen: r.right > innerWidth + 1 || r.bottom > innerHeight + 1,
      rows: p.querySelectorAll('.sz-docs-item').length,
      unstyled,
    };
  })()`);
  check('the documents panel opens and is on screen',
    panel && panel.visible && !panel.offscreen, JSON.stringify(panel));
  check('the documents panel lists at least this document', (panel?.rows || 0) >= 1,
    `rows=${panel?.rows}`);
  check('no control in the documents panel renders as an unstyled native button',
    (panel?.unstyled || []).length === 0, (panel?.unstyled || []).join(','));
  await t1.screenshot(join(ROOT, 'docs', 'shots', 'docs.png'));
  console.log('  screenshot: docs/shots/docs.png');
  await t1.key('Escape', 'Escape', 27);
  await sleep(300);

  // The sheet bar root must not be styled twice (index.html carries the class AND the
  // module sets it on the child it builds), which doubles padding and the top border.
  const barBox = await t1.eval(`(() => {
    const root = document.getElementById('sz-sheetbar-root');
    const inner = root && root.querySelector('.sz-sheetbar');
    if (!root) return null;
    const r = root.getBoundingClientRect();
    const i = inner ? inner.getBoundingClientRect() : null;
    return {
      rootHasClass: root.classList.contains('sz-sheetbar'),
      nested: !!inner && inner !== root,
      rootH: Math.round(r.height),
      innerH: i ? Math.round(i.height) : null,
      overflow: i ? Math.round(i.height - r.height) : 0,
    };
  })()`);
  check('the sheet bar is not double-styled by a nested duplicate class',
    barBox && barBox.overflow <= 0, JSON.stringify(barBox));

  const beforeDocs = (await (await fetch(`${BASE}/api/docs`)).json()).length;
  await t1.eval(`(() => {
    const b = [...document.querySelectorAll('#sz-docs-root button')]
      .find(x => /새 문서/.test(x.textContent || ''));
    if (b) b.click();
  })()`);
  await sleep(1200);
  const listAfter = await (await fetch(`${BASE}/api/docs`)).json();
  const afterDocs = listAfter.length;
  // Remember anything the run brought into existence: a test that leaves documents
  // behind slowly fills the user's data/ directory with junk.
  for (const d of listAfter) if (d.id !== docId && d.id !== 'start1') createdDocIds.push(d.id);
  check('새 문서 creates a document', afterDocs === beforeDocs + 1, `${beforeDocs} -> ${afterDocs}`);
  const movedOn = await t1.evalBecomes(`document.querySelectorAll('.sz-sheet-tab').length`, 1);
  check('creating a document opens it (a fresh single-sheet document)', movedOn.ok, `tabs=${movedOn.seen}`);

  // ------------------------------------------------------ scrolling stability
  await t1.eval(`(() => { const v = document.querySelector('.sz-viewport') || document.scrollingElement; v.scrollTop = 4000; v.scrollLeft = 600; })()`);
  const afterScroll = await t1.evalUntil(`document.querySelectorAll('.sz-cell').length`, (n) => n > 0);
  check('grid still renders after a large scroll', afterScroll > 0, `cells=${afterScroll}`);
  await t1.eval(`(() => { const v = document.querySelector('.sz-viewport') || document.scrollingElement; v.scrollTop = 0; v.scrollLeft = 0; })()`);
  await sleep(300);
  const backTop = await t1.evalBecomes(`!!document.querySelector('[data-a1="A1"]')`, true);
  check('scrolling back restores the top-left cell', backTop.ok, `A1 present=${backTop.seen}`);

  // ---------------------------------------------------------------- home page
  const home = await Tab.open(cdp, `${BASE}/`, 'home');
  await home.waitFor('document.readyState === "complete"', 15000, 'home ready');
  await home.waitFor('!!document.querySelector(".sz-home-card")', 10000, 'home cards');
  const homeInfo = await home.eval(`({
    title: document.title,
    cards: document.querySelectorAll('.sz-home-card').length,
    newCard: !!document.querySelector('.sz-home-card-new'),
    firstName: (document.querySelector('.sz-home-card:not(.sz-home-card-new) .sz-home-card-name')||{}).textContent,
    firstHref: (document.querySelector('.sz-home-card:not(.sz-home-card-new)')||{}).getAttribute('href'),
    meta: (document.querySelector('.sz-home-card:not(.sz-home-card-new) .sz-home-card-meta')||{}).textContent,
    search: !!document.getElementById('sz-home-search'),
    sort: !!document.getElementById('sz-home-sort'),
    hScroll: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
  })`);
  check('the site root serves the document list', /내 문서/.test(homeInfo.title || ''), homeInfo.title);
  check('the list renders a card per document plus the create card',
    homeInfo.cards >= 2 && homeInfo.newCard, JSON.stringify(homeInfo));
  check('a document card links straight into the editor',
    /^\/edit#doc=/.test(homeInfo.firstHref || ''), `href=${homeInfo.firstHref}`);
  check('a card shows its sheet count and modified time',
    /시트 \d+장/.test(homeInfo.meta || '') && /전|어제|\d{4}-/.test(homeInfo.meta || ''),
    `meta="${homeInfo.meta}"`);
  check('the home page has search and sort controls', homeInfo.search && homeInfo.sort);
  check('the home page does not scroll horizontally', !homeInfo.hScroll);

  // search filters without touching the network
  await home.eval(`(() => {
    const i = document.getElementById('sz-home-search');
    i.value = '브라우저';
    i.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  const filtered = await home.evalBecomes(
    `document.querySelectorAll('.sz-home-card:not(.sz-home-card-new)').length`, 1);
  check('search filters the list', filtered.ok, `cards=${filtered.seen}`);
  await home.eval(`(() => {
    const i = document.getElementById('sz-home-search');
    i.value = '존재하지않는이름zzz';
    i.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  const noRes = await home.evalBecomes(
    `!!document.querySelector('.sz-home-empty') && /검색 결과가 없습니다/.test(document.querySelector('.sz-home-empty').textContent)`,
    true);
  check('a search with no match shows the no-results state', noRes.ok, `${noRes.seen}`);
  await home.eval(`(() => {
    const i = document.getElementById('sz-home-search');
    i.value = '';
    i.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await sleep(300);

  // legacy '/#doc=' links must still land in the editor
  const legacy = await Tab.open(cdp, `${BASE}/#doc=${docId}`, 'legacy');
  await legacy.waitFor('document.readyState === "complete"', 15000, 'legacy ready');
  const landed = await legacy.evalBecomes(`location.pathname`, '/edit');
  check('an old /#doc= link still opens the editor', landed.ok, `pathname=${landed.seen}`);
  const legacyGrid = await legacy.evalBecomes(`!!document.querySelector('.sz-cell')`, true);
  check('and the editor actually loads there', legacyGrid.ok);

  // the editor logo goes home
  const logo = await t1.eval(`(() => {
    const a = document.querySelector('.sz-logo');
    return a ? { tag: a.tagName, href: a.getAttribute('href') } : null;
  })()`);
  check('the editor logo is a link to the document list',
    logo && logo.tag === 'A' && logo.href === '/', JSON.stringify(logo));

  await home.screenshot(join(ROOT, 'docs', 'shots', 'home.png'));
  console.log('  screenshot: docs/shots/home.png');
  for (const e of [...home.errors, ...home.consoleErrors, ...legacy.errors, ...legacy.consoleErrors]) {
    if (!/favicon/i.test(e)) failures.push(`home page error: ${e}`);
  }
  check('the home page raises no console errors',
    [...home.errors, ...home.consoleErrors].filter((e) => !/favicon/i.test(e)).length === 0,
    [...home.errors, ...home.consoleErrors].slice(0, 3).join(' | '));

  // ------------------------------------- an edit made while offline must survive
  // The server restarting under a user is ordinary — a deploy, a crash, a laptop lid.
  // Anything typed while the socket is down has to still be there afterwards. It used
  // to vanish: the reconnect adopted the server's older snapshot, then the queued edit
  // was replayed to the server but its echo was discarded as "my own", so the value
  // lived on the server and nowhere on screen.
  await t1.eval(`document.querySelectorAll('.sz-sheet-tab')[0].click()`);
  await sleep(350);
  await t1.clickCell('H20');
  await t1.type('연결중입력');
  await t1.key('Enter', 'Enter', 13);
  await t1.cellBecomes('H20', '연결중입력');

  // Cut the socket from inside the page: the client cannot tell this from a server
  // restart, and it needs no second server process.
  await t1.eval(`(() => { try { if (window.__ws) window.__ws.close(); } catch (e) {} })()`);
  await sleep(400);
  await t1.clickCell('H21');
  await t1.type('끊긴동안입력');
  await t1.key('Enter', 'Enter', 13);
  const offlineShown = await t1.cellBecomes('H21', '끊긴동안입력');
  check('an edit made while the socket is down still shows locally', offlineShown.ok,
    `H21="${offlineShown.seen}"`);

  const back = await t1.evalBecomes(
    `/연결됨/.test((document.getElementById('sz-status')||{}).textContent || '')`, true, 20000);
  check('the client reconnects on its own', back.ok, `${back.seen}`);

  const survived = await t1.cellBecomes('H21', '끊긴동안입력', 15000);
  check('the offline edit is still on screen after reconnecting', survived.ok,
    `H21="${survived.seen}"`);
  // Read the document the tab is ACTUALLY on: earlier blocks may have navigated it.
  const liveId = await t1.eval(`(/[#&]doc=([A-Za-z0-9_-]+)/.exec(location.hash) || [])[1] || ''`);
  const onServer = await (async () => {
    for (let i = 0; i < 40; i++) {
      const d = await (await fetch(`${BASE}/api/docs/${liveId}`)).json().catch(() => null);
      const hit = d && d.sheets && d.sheets.some((sh) =>
        sh.cells && sh.cells.H21 && sh.cells.H21.input === '끊긴동안입력');
      if (hit) return true;
      await sleep(200);
    }
    return false;
  })();
  const srvDiag = await (await fetch(`${BASE}/api/docs/${liveId}`)).json();
  check('and it reached the server', onServer,
    srvDiag.sheets.map((sh, i) => i + ':' + JSON.stringify({ H20: sh.cells && sh.cells.H20,
      H21: sh.cells && sh.cells.H21 })).join(' '));

  // ------------------------------------------------------------ error audit
  await sleep(300);
  const allErrors = [
    ...t1.errors.map((e) => `tab1 exception: ${e}`),
    ...t2.errors.map((e) => `tab2 exception: ${e}`),
    ...t1.consoleErrors.map((e) => `tab1 console.error: ${e}`),
    ...t2.consoleErrors.map((e) => `tab2 console.error: ${e}`),
    ...t1.failedRequests.map((e) => `tab1 network: ${e}`),
    ...t2.failedRequests.map((e) => `tab2 network: ${e}`),
    ...t1.dialogs.map((e) => `tab1 blocking dialog: ${e}`),
    ...t2.dialogs.map((e) => `tab2 blocking dialog: ${e}`),
  ].filter((e) => !/favicon/i.test(e));
  check('no uncaught exceptions, console errors or failed requests in either tab',
    allErrors.length === 0, allErrors.slice(0, 6).join(' | '));

  await mkdir(join(ROOT, 'docs', 'shots'), { recursive: true });
  await t1.screenshot(join(ROOT, 'docs', 'shots', 'new-doc.png'));
  console.log('  screenshot: docs/shots/new-doc.png (a freshly created document)');
} catch (e) {
  failures.push(`threw: ${e?.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : e}`);
  console.log(`  ✗ ${failures.at(-1)}`);
} finally {
  for (const id of [docId, ...createdDocIds].filter(Boolean)) {
    try { await fetch(`${BASE}/api/docs/${id}`, { method: 'DELETE' }); } catch { /* ignore */ }
  }
  cdp?.close();
  try { chrome?.kill(); } catch { /* ignore */ }
  try { server?.kill(); } catch { /* ignore */ }
  await sleep(400);
  await rm(profile, { recursive: true, force: true }).catch(() => {});
}

console.log('');
if (failures.length === 0) { console.log(`browser: OK — ${passed} checks passed.`); process.exit(0); }
console.log(`browser: ${failures.length} FAILED (${passed} passed)\n`);
for (const f of failures) console.log(`  - ${f}`);
if (serverLog.length) { console.log('\n--- server output ---'); console.log(serverLog.join('').slice(-2500)); }
process.exit(1);
