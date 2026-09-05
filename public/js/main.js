// main.js — 시트지: bootstrap and wiring (the composition root).
//
// Responsibilities (docs/SPEC.md sections 12 and 19):
//   - resolve the document AND the sheet from location.hash / the REST API, and keep
//     the hash (`#doc=<docId>&sheet=<sheetId>`) in sync with what is on screen
//   - hold ONE SheetEngine per sheet, created lazily and cached by sheet id, so
//     switching tabs is instant and a background sheet keeps its computed values
//   - own the display name ('sz.name'), its rename control and the presence colour
//   - construct Grid + Toolbar + SheetBar + DocsMenu + Net and wire the callbacks
//   - own the undo/redo stack, the clipboard, and every toolbar command
//   - own the connection indicator, error toasts and the fatal error panel
//   - own the five tools of SPEC 23: the format painter's armed state, the per-viewer
//     zoom preference, printing, hyperlinks and the function helper
//   - own the three data features of SPEC 24: the filter view and its column panel, the
//     chart list and its side panel, and the comment threads and their panel
//   - own the extent of a sheet (SPEC 25): the GrowBar under the grid, the grid's own
//     auto-grow and an incoming `meta` frame all reach one function, growSheetTo()
//   - own DURABILITY (SPEC 27): one persisted Outbox for the document, the save
//     indicator that reports it, and the beforeunload warning that guards it
//
// Everything that mutates cell data funnels through commitLocalEdit(), so a toolbar
// click, a grid edit, a paste and an undo all travel the exact same path:
// engine -> sheet mirror -> outbox -> history. Every frame that touches cell data
// names the sheet it belongs to; a frame without one would be applied to whatever
// sheet the recipient happens to be looking at, which is the one bug this whole
// design exists to prevent.
//
// Merging (SPEC 21) is two mutations at once — the covered cells are emptied AND the
// sheet's merge list changes — so it gets ONE function, runMerge(), that the toolbar
// commands and the grid's context menu both call. The cells half goes through
// commitLocalEdit() like every other edit; the geometry half goes out as a `meta`
// frame; and the two are wrapped in a SINGLE history entry, so one Ctrl+Z puts both
// halves back.
//
// The batch-C features (SPEC 24) deliberately stay OUT of the history stack. A filter and
// a chart change no cell — undoing one would put back a row that was never taken away —
// and a comment is stamped by the server, the only thing entitled to say who wrote it and
// when. All three are sheet state: the filter and the chart list ride the `meta` frame
// beside the merge list, and comments get a frame of their own.
//
// Growing a sheet (SPEC 25) stays out of it for a sharper reason: an undo that shrank a
// sheet could strand cells outside it. Growth is not an edit to the data at all — it adds
// empty space and touches nothing — so it rides the `meta` frame like the geometry it is,
// and Ctrl+Z never sees it.
//
// Durability (SPEC 27) is the last link in that chain and the only one that outlives the
// tab. Every frame that mutates the document — edit, struct, meta, docmeta, sheet,
// comment — leaves through sendTracked(), which persists it in the Outbox BEFORE handing
// it to the socket and drops it only when the server acknowledges that its journal line
// reached the operating system. Net's own queue still exists and still replays within one
// connection; it is a latency optimisation, not the durability story, because a closed tab
// takes it with it. What a closed tab cannot take is localStorage, which is why the outbox
// lives there and why every pending frame is re-sent after each `welcome`.

import { SheetEngine } from '/shared/formula/engine.js';
import {
  cellToA1, a1ToCell, isA1, parseRange, colToLetter,
  // SPEC 25 — the hard extent a sheet may grow to (5000 x 702, A..ZZ). The engine's
  // own limit, so what the grow control offers is exactly what growSheet() grants.
  MAX_ROWS, MAX_COLS,
} from '/shared/formula/refs.js';
import {
  normalizeMergeList, mergeRect, expandOverMerges, planMerge, planUnmerge,
  applyBorderPreset, FONT_STACKS, sanitizeLink,
  // Data features, SPEC 24. Every one of these is a PURE helper: the filter view, the
  // chart list and the comment map are validated here exactly the way the server
  // validates them, so a frame that arrived from another client can never install a
  // shape the grid is not prepared to draw.
  sanitizeFilter, filterColumnValues, computeVisibleRows,
  sanitizeChart, sanitizeChartList, sanitizeComments,
  MAX_CHARTS, MAX_COMMENT_LEN, MAX_COMMENTS_PER_SHEET,
  DEFAULT_COL_WIDTH, DEFAULT_ROW_HEIGHT, newId,
  // SPEC 25 — growing a sheet. `growSheet` is the ONLY thing in this app that may
  // change a sheet's extent, and it is pure: it clamps, it never shrinks, it never
  // touches a cell, and it hands back the very same document when nothing changed.
  growSheet, ROW_GROW_STEP, COL_GROW_STEP,
} from '/shared/model.js';
// SPEC 24.2 — the chart type vocabulary is owned by the renderer, so the picker in the
// 차트 panel offers exactly what chart.js can draw. Imported as a namespace rather than
// by name: a renderer that is still being written must not stop the editor from
// booting, and CHART_TYPES_FALLBACK below keeps the picker usable if it does.
import * as chartModule from './chart.js';
import { Grid } from './grid.js';
import { Net } from './net.js';
// The toolbar strip, and — from the same module but deliberately NOT part of it —
// the 시트 늘리기 controls that mount below the grid, beside the sheet bar (SPEC 25.4).
import { Toolbar, GrowBar } from './toolbar.js';
import { SheetBar } from './sheetbar.js';
import { DocsMenu } from './docsmenu.js';
import { History } from './history.js';
// SPEC 27.4 — the outbox that survives the tab. It is the ONLY thing between a
// keystroke and a closed lid, so it is imported like any other module and, if its
// constructor ever fails, replaced by an in-memory stand-in that keeps the save
// indicator honest rather than by nothing at all.
import { Outbox } from './outbox.js';
import { renderPeers, colorForId } from './presence.js';
import { onNextFrame } from './schedule.js';
// SPEC 26 — parseExternalHtml() reads the `text/html` flavour a paste from Excel or
// Google Sheets carries. It parses into an INERT DOMParser document and hands back only
// the facts SPEC 26.1 allows, already mapped onto this app’s closed style sets, so
// nothing from the clipboard reaches a style property as a raw string.
import {
  serializeSelection, parseClipboard, pasteInto, parseExternalHtml,
} from './clipboard.js';
import { formatValue } from './format.js';
import { printSheet } from './print.js';

// --------------------------------------------------------------- constants

const NAME_KEY = 'sz.name';
const UID_KEY = 'sz.uid';                 // stable client id, only used for the colour
const DEFAULT_NAME = '익명 사용자';
const DEFAULT_DOC_NAME = '제목 없는 스프레드시트';
const DEFAULT_SHEET_NAME = '시트1';        // mirrors shared/model.js
const DEFAULT_ROWS = 200;
const DEFAULT_COLS = 26;
const MAX_EDIT_CELLS = 20000;
// The socket refuses anything over 256 KB, and it refuses it by CLOSING rather than by
// answering, so the budget here is deliberately well under that: room for the frame's
// own envelope plus a wide margin for the UTF-8 expansion JSON.stringify's length count
// does not see.
const MAX_FRAME_BODY_BYTES = 160 * 1024;
const FRAME_OVERHEAD_BYTES = 512;             // matches the server-side per-frame cap
const MAX_COPY_CELLS = 200000;            // a Ctrl+A copy must not lock the tab
const DEFAULT_DECIMALS = { number: 2, currency: 0, percent: 0 }; // mirrors format.js
// The bounds sanitizeDoc enforces on the cell-formatting keys (SPEC 22.1). Mirrored
// here so a nonsensical command is dropped locally instead of round-tripping to the
// server only to be thrown away there.
const MIN_FONT_SIZE = 6;
const MAX_FONT_SIZE = 96;
const MAX_ROTATION = 90;
const EDIT_COALESCE_MS = 60;              // one edit frame per burst, per sheet
const CURSOR_THROTTLE_MS = 100;
const HEX_RE = /^#[0-9a-fA-F]{6}$/;
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const NEW_SHEET_WINDOW_MS = 15000;        // how long an "add" keeps the right to focus
// SPEC 27. The frame types that change the document, and therefore the ones that go
// through the outbox and wait for an ack. `cursor`, `hello` and `ping` change nothing
// that could be lost, so they are deliberately absent.
const TRACKED_FRAMES = new Set(['edit', 'struct', 'meta', 'docmeta', 'sheet', 'comment']);
const OUTBOX_PROBE_KEY = 'sz.outbox.probe';
// Mirrors MAX_OUTBOX in outbox.js (SPEC 27.4). Only the in-memory fallback below reads
// it; the real outbox enforces its own, and drops are detected from size() either way.
const MAX_OUTBOX = 2000;
const DROP_TOAST_MS = 1000;               // coalesce a burst of drops into one toast
// 확대/축소 (SPEC 23.2). A per-VIEWER view preference: it lives in localStorage, is
// never sent over the wire and is never written to the document. The bounds are the
// ones Grid.setZoom() clamps to, mirrored here so a stored or typed value that is out
// of range is corrected before the grid ever sees it.
const ZOOM_KEY = 'sz.zoom';
const MIN_ZOOM = 0.5;
const MAX_ZOOM = 2;
const DEFAULT_ZOOM = 1;

// --- data features, SPEC 24 -------------------------------------------------
// The default geometry of a freshly inserted chart, and the ceiling on how far a
// "make a filter / a chart out of what is around the cursor" guess may grow. Both
// mirror shared/model.js, which clamps whatever actually arrives.
const CHART_DEFAULT_W = 480;
const CHART_DEFAULT_H = 300;
const BLOCK_MAX_ROWS = 5000;
const BLOCK_MAX_COLS = 702;
/** The blank bucket of a filter column is the empty string; the UI labels it. */
const BLANK_LABEL = '(공백)';
/** Chart types offered when chart.js does not (yet) publish its own vocabulary. */
const CHART_TYPES_FALLBACK = [
  { id: 'column', label: '세로 막대' },
  { id: 'bar', label: '가로 막대' },
  { id: 'line', label: '꺾은선' },
  { id: 'area', label: '영역' },
  { id: 'pie', label: '원' },
  { id: 'scatter', label: '분산형' },
];
const CHART_TYPES = (Array.isArray(chartModule.CHART_TYPES) && chartModule.CHART_TYPES.length)
  ? chartModule.CHART_TYPES
  : CHART_TYPES_FALLBACK;
const CHART_LEGENDS = [
  ['right', '오른쪽'],
  ['bottom', '아래쪽'],
  ['none', '없음'],
];

// The dot itself is .sz-status::before in style.css, keyed on data-state.
const STATUS_VIEW = {
  connecting: { text: '연결 중…' },
  online: { text: '연결됨' },
  offline: { text: '오프라인' },
  // SPEC 28.3 — net.js reports this when the WebSocket UPGRADE was refused rather than
  // when the server is unreachable. Deliberately not 오프라인: the server is up, this tab
  // simply has no session, and no amount of reconnecting can produce one.
  unauthorized: { text: '로그인이 필요합니다' },
};

// SPEC 27.5 — the save indicator's vocabulary, in one place so nothing else can invent
// a fifth phrasing. `저장됨` is reachable ONLY from a state where the outbox is empty,
// which is the whole point: every word here may under-promise and none may over-promise.
const SAVE_VIEW = {
  saved: {
    text: '저장됨',
    title: '입력한 내용이 서버 디스크에 기록되었습니다.',
  },
  saving: {
    text: '저장 중…',
    title: '아직 저장되지 않은 변경이 있습니다. 서버 응답을 기다리는 중입니다.',
  },
  pending: {
    text: '저장 대기 중',
    title: '연결이 끊겨 있습니다. 변경 내용은 이 브라우저에 보관해 두었다가 연결되면 보냅니다.',
  },
  nostore: {
    text: '저장됨 (이 브라우저에는 임시 보관 불가)',
    title: '이 브라우저에서는 임시 보관을 쓸 수 없습니다. 연결이 끊긴 채로 탭을 닫으면 그동안의 변경은 사라집니다.',
  },
};

// ------------------------------------------------------------------- state

const history = new History();

const state = {
  /** @type {object|null} the whole document: { id, name, sheets:[...], rev, ... } */
  doc: null,
  docId: '',
  /** id of the sheet on screen; per-viewer, never stored in the document */
  sheetId: '',
  me: { id: null, name: DEFAULT_NAME, color: '#1a73e8' },
  peers: [],
  status: 'connecting',
  /** last internal copy/cut: { text, grid2d, range, cut } */
  clip: null,
};

/**
 * One context per sheet: { sheetId, sheet, engine, shadow }.
 *
 * `shadow` is a private mirror of that sheet's cell contents, kept in step with
 * sheet.cells. Undo entries are derived from it *before* a patch is applied, so it
 * must never be touched by anyone else. Contexts are created lazily and survive tab
 * switches — that is what makes a background sheet keep its computed values.
 *
 * @type {Map<string, {sheetId:string, sheet:object, engine:object, shadow:Map}>}
 */
const sheetCtxs = new Map();

/** The active sheet's engine. Re-pointed by activateSheet(); never null after boot. */
let engine = null;
let grid = null;
let toolbar = null;
let sheetbar = null;
/** The 맨 아래에 행 추가 / 오른쪽에 열 추가 controls under the grid (SPEC 25.4). */
let growBar = null;
let docsMenu = null;
let net = null;
let ui = null;

// ------------------------------------------------------------ tiny helpers

function lsGet(key) {
  try { return localStorage.getItem(key); } catch (e) { return null; }
}

function lsSet(key, value) {
  try { localStorage.setItem(key, value); } catch (e) { /* private mode: ignore */ }
}

function pick(selectors) {
  for (const sel of selectors) {
    let el = null;
    try { el = document.querySelector(sel); } catch (e) { el = null; }
    if (el) return el;
  }
  return null;
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function isTextField(node) {
  if (!node || node.nodeType !== 1) return false;
  const tag = node.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  return node.isContentEditable === true;
}

/**
 * The grid keeps a hidden textarea focused to capture typing, so "the target is
 * a text field" is not enough to decide that a shortcut or a clipboard event
 * belongs to someone else. Inside the grid, only an OPEN cell editor counts.
 */
function gridIsEditing() {
  return !!(grid && grid._editing);
}

function inGrid(node) {
  return !!(ui && ui.gridRoot && node && ui.gridRoot.contains(node));
}

/** True when a document-level shortcut / clipboard event is not ours to take. */
function foreignInput(target) {
  if (!isTextField(target)) return false;
  if (inGrid(target)) return gridIsEditing();
  return true;
}

function clonePatch(cells) {
  const out = {};
  for (const key of Object.keys(cells)) {
    const v = cells[key];
    if (v === null || v === undefined) { out[key] = null; continue; }
    const entry = {};
    if ('input' in v) entry.input = v.input;
    if ('style' in v) entry.style = v.style === null ? null : { ...v.style };
    // SPEC 23.4 — a hyperlink is one more field on the cell record and rides the very
    // same patch as input and style, so undo, coalescing and replication are already
    // written. A null clears it, exactly like a null input deletes the cell.
    if ('link' in v) entry.link = v.link;
    out[key] = entry;
  }
  return out;
}

async function api(path, options) {
  const opts = options || {};
  const init = { method: opts.method || 'GET', headers: { 'Content-Type': 'application/json' } };
  if (opts.body !== undefined) init.body = opts.body;
  const res = await fetch(path, init);
  // SPEC 28.3 — every REST call in this file goes through here, so this is the ONE place
  // an expired session is handled, whichever request happened to notice it first. A tab
  // left open overnight is the real case: without this it would keep failing to save and
  // never say why.
  if (res.status === 401) {
    let body = null;
    try { body = await res.json(); } catch (e) { body = null; }
    // A 401 with no readable body (a proxy that strips it, say) is treated as the gate,
    // because that is the only 401 this app's own endpoints can produce for these calls.
    const kind = (body && typeof body.error === 'string') ? body.error : 'auth_required';
    if (kind === 'auth_required') goToLogin();
    throw new Error('로그인이 필요합니다.');
  }
  if (!res.ok) {
    // The STATUS and the server's own body travel with the failure. Without them every
    // caller sees the same opaque string and has no choice but to treat "this document
    // cannot be read right now" the same as "this document is not here" — and those two
    // want opposite behaviour: one must stop, the other may go and make a new document
    // (SPEC 27.6). The message stays exactly what it was for everything else.
    let body = null;
    try { body = await res.json(); } catch (e) { body = null; }
    const server = (body && typeof body.message === 'string' && body.message) ? body.message : '';
    const err = new Error(server || (init.method + ' ' + path + ' 실패 (HTTP ' + res.status + ')'));
    err.status = res.status;
    err.code = (body && typeof body.error === 'string') ? body.error : '';
    err.body = body;
    throw err;
  }
  return res.json();
}

// ------------------------------------------------- an unreadable document (SPEC 27.6)
//
// The server refuses to open a document whose stored state it could not READ: 503 with
// `error: 'doc_unreadable'` over HTTP, `{t:'error', code:'doc_unreadable'}` over the
// socket. It is deliberately NOT a 404, because "no such document" is what would have
// this page cheerfully create a new one on top of somebody's data.
//
// Everything below treats that answer as a full stop. Nothing is fetched instead of it,
// nothing is created instead of it, and the socket is not left reconnecting into a
// refusal — the outbox keeps whatever it is holding, on this browser's disk, exactly as it
// does while the network is down.

/** True when this failure is the server saying it could not read the document. */
function isUnreadableError(err) {
  return !!(err && (err.code === 'doc_unreadable' || err.status === 503));
}

/** Shown once, and only once, however many refusals arrive. */
let unreadableShown = false;

/**
 * The words a person sees. The server sends them, so the page and the API can never
 * disagree; these are the fallback for the case where the body did not arrive — an
 * offline refusal, a proxy that ate it — and they say the same three things.
 */
const UNREADABLE_FALLBACK = {
  message: '이 문서를 지금은 열 수 없습니다.',
  steps: [
    '지금까지 입력한 내용은 서버에 그대로 남아 있습니다. 사라진 것이 아닙니다.',
    '이번에 서버가 그 파일을 읽지 못했을 뿐이라, 읽지 못한 내용을 덮어쓰지 않으려고 문서를 열지 않았습니다.',
    '서버를 다시 시작하면 대부분 그대로 다시 열립니다.',
    '다시 시작해도 같은 문제가 이어지면 백신·백업 같은 다른 프로그램이 파일을 붙잡고 있거나 디스크에 문제가 있는 것입니다. 관리자에게 알려 주세요.',
  ],
};

/** The Korean explanation carried by a 503 body or an error frame, or the fallback. */
function unreadableTextOf(source) {
  const message = (source && typeof source.message === 'string' && source.message)
    ? source.message
    : UNREADABLE_FALLBACK.message;
  const steps = (source && Array.isArray(source.steps) && source.steps.length)
    ? source.steps.filter((s) => typeof s === 'string' && s)
    : UNREADABLE_FALLBACK.steps;
  return { message, steps: steps.length ? steps : UNREADABLE_FALLBACK.steps };
}

// -------------------------------------------------------------- access gate
//
// SPEC 28. ONE shared password for the whole site: anyone who knows it reads and writes
// everything, and there are no per-user accounts. The client's half of that is small and
// deliberately lives in one place each:
//
//   * api() above turns a 401 {error:'auth_required'} into a trip to the login page,
//     so no call site has to remember to;
//   * net.js cannot read the 401 the upgrade was refused with, so it asks over HTTP and
//     reports 'unauthorized'; setStatus() below turns that into 로그인이 필요합니다 plus a
//     link, rather than a silent tab that no longer saves;
//   * the 로그아웃 button exists only when GET /api/version says the gate is on.

const LOGIN_PATH = '/login';
/** True once a navigation to the login page is under way; everything after it is noise. */
let authRedirecting = false;
/** Said once per session, when the socket turns out to be refused rather than offline. */
let authNoticed = false;

/** /login?next=<where we are>, so logging in comes back to this document and sheet. */
function loginUrl() {
  // The hash carries the document and sheet ids (SPEC 19) and never reaches the server on
  // its own, so it MUST be part of `next` — without it a login would land the user on a
  // different document than the one they were sent away from.
  const here = location.pathname + location.search + location.hash;
  return LOGIN_PATH + '?next=' + encodeURIComponent(here);
}

/**
 * The session is gone: go to the login page, once, whatever answered 401 first.
 *
 * NOTHING IS LOST TO THIS NAVIGATION, and that is a property of the code rather than a
 * hope. sendTracked() persists every document-mutating frame into the outbox —
 * localStorage, written synchronously — BEFORE it hands the frame to the socket, so
 * anything already sent, queued or unacknowledged is on this browser's disk and is
 * replayed after the next `welcome`. The single place an edit lives in memory alone is
 * the 60 ms coalescer, so it is flushed into the outbox here first, in exactly the order
 * beforeunload uses. After these two lines every keystroke is somewhere that survives
 * the navigation.
 */
function goToLogin() {
  if (authRedirecting) return;
  authRedirecting = true;
  try { flushEdits(); } catch (e) { console.warn('[main] 편집 내용을 보관하지 못했습니다', e); }
  // Net's own 60 ms edit buffer for completeness: this file does not use it, but a frame
  // sitting in it would otherwise die with the page.
  try { if (net && typeof net.flush === 'function') net.flush(); } catch (e) { /* socket gone */ }
  // `replace`, not `href`: a page that can no longer save anything is not somewhere the
  // Back button should be able to return to, and returning would only 401 again.
  try { location.replace(loginUrl()); }
  catch (e) { location.href = loginUrl(); }
}

/**
 * Show the 로그아웃 button, creating it on first use (SPEC 28.5).
 *
 * With the gate off there is no button at all — not a hidden one — because a 로그아웃
 * control on a site with no password would be a lie about what the site is. A node the
 * host page supplied itself is hidden rather than removed, since it is not ours to
 * delete; `hidden` AND display are both set, as one CSS rule (.sz-btn{display:flex})
 * would otherwise beat the attribute.
 */
function showLogout(on) {
  if (!ui) return;
  if (!on) {
    if (ui.logout) { ui.logout.hidden = true; ui.logout.style.display = 'none'; }
    return;
  }
  if (!ui.logout) {
    const btn = el('button', 'sz-btn sz-logout', '로그아웃');
    btn.type = 'button';
    btn.id = 'sz-logout';
    btn.title = '이 브라우저의 로그인 세션을 끝냅니다';
    btn.addEventListener('click', (ev) => { ev.preventDefault(); logout(); });
    if (ui.actions) ui.actions.appendChild(btn);
    else if (ui.header) ui.header.appendChild(btn);
    else document.body.appendChild(btn);
    ui.logout = btn;
  }
  ui.logout.hidden = false;
  ui.logout.style.display = '';
}

/** POST /api/logout, then to the login page (SPEC 28.5). */
async function logout() {
  // The same guarantee goToLogin() makes: the coalescer is emptied into the persisted
  // outbox before anything navigates, so signing out cannot cost the last 60 ms of typing.
  try { flushEdits(); } catch (e) { console.warn('[main] 편집 내용을 보관하지 못했습니다', e); }
  try {
    await api('/api/logout', { method: 'POST', body: '{}' });
  } catch (e) {
    // A logout that fails is still a logout as far as this tab is concerned: the cookie
    // is refused at the login page anyway, and the user asked to leave.
    console.warn('[main] 로그아웃 요청이 실패했습니다', e);
  }
  authRedirecting = true;
  try { if (net) net.close(); } catch (e) { /* leaving anyway */ }
  location.replace(LOGIN_PATH);
}

/**
 * Is the gate on at all? Fire-and-forget: the editor is fully usable before the answer
 * arrives and the only thing the answer changes is one button. A 401 here needs no
 * special case — api() sends the user to the login page, which is precisely right.
 */
function refreshAuthMode() {
  return api('/api/version').then(
    (info) => showLogout(!!(info && info.auth)),
    // No answer (offline, or a build without the endpoint): show nothing rather than a
    // button that cannot work.
    () => showLogout(false),
  );
}

// ------------------------------------------------------------------- toast

function toast(message, tone) {
  if (!ui || !ui.toasts) { console.warn('[main]', message); return; }
  // style.css owns the look: .sz-toast (+ .sz-toast-error / .sz-toast-ok) and
  // the .sz-toast-out exit transition.
  const cls = 'sz-toast' + (tone === 'error' ? ' sz-toast-error' : (tone === 'ok' ? ' sz-toast-ok' : ''));
  const box = el('div', cls, String(message));
  ui.toasts.appendChild(box);
  setTimeout(() => {
    box.classList.add('sz-toast-out');
    setTimeout(() => { if (box.parentNode) box.parentNode.removeChild(box); }, 260);
  }, 4200);
}

// ------------------------------------------------------------ sheet access

function sheetsOf() {
  return state.doc && Array.isArray(state.doc.sheets) ? state.doc.sheets : [];
}

function sheetById(sheetId) {
  if (!sheetId) return null;
  for (const s of sheetsOf()) if (s.id === sheetId) return s;
  return null;
}

function firstSheet() {
  const list = sheetsOf();
  return list.length ? list[0] : null;
}

function activeSheet() {
  return sheetById(state.sheetId) || firstSheet();
}

/** Build a sheet's private mirror from its plain cells object. */
function buildShadow(sheet) {
  const shadow = new Map();
  const cells = (sheet && sheet.cells) || {};
  for (const key of Object.keys(cells)) {
    const c = cells[key] || {};
    const entry = {};
    if (typeof c.input === 'string' && c.input !== '') entry.input = c.input;
    if (c.style && typeof c.style === 'object' && Object.keys(c.style).length) {
      entry.style = { ...c.style };
    }
    // A link is attacker-controlled text (SPEC 23.4), so it is re-validated on the way
    // IN as well as on the way out: only http / https / mailto survive sanitizeLink,
    // and a document that reached the disk before that gate existed cannot smuggle a
    // javascript: URL in front of a viewer.
    if (typeof c.link === 'string') {
      const link = sanitizeLink(c.link);
      if (link) entry.link = link;
    }
    if (entry.input !== undefined || entry.style || entry.link) shadow.set(key, entry);
  }
  return shadow;
}

/** The plain cells object a shadow describes (used when re-seeding a sheet). */
function cellsFromShadow(shadow) {
  const out = {};
  for (const [key, entry] of shadow) {
    const cell = {};
    if (entry.input !== undefined) cell.input = entry.input;
    if (entry.style) cell.style = { ...entry.style };
    if (entry.link) cell.link = entry.link;
    out[key] = cell;
  }
  return out;
}

/**
 * The context for a sheet, created on first use. An engine is never rebuilt for a
 * sheet that already has one: that is exactly what keeps a background sheet's values
 * alive across a tab switch.
 */
function ctxOf(sheetId) {
  const sheet = sheetById(sheetId);
  if (!sheet) return null;
  let ctx = sheetCtxs.get(sheet.id);
  if (!ctx) {
    let eng = null;
    try {
      eng = new SheetEngine({ rows: sheet.rows, cols: sheet.cols, cells: sheet.cells });
    } catch (e) {
      console.error('[main] 시트를 엔진에 적재하지 못했습니다: ' + sheet.name, e);
      eng = new SheetEngine({ rows: sheet.rows, cols: sheet.cols });
    }
    ctx = { sheetId: sheet.id, sheet, engine: eng, shadow: buildShadow(sheet) };
    sheetCtxs.set(sheet.id, ctx);
  }
  ctx.sheet = sheet;                     // always the live object, never a stale copy
  return ctx;
}

function activeCtx() {
  const sheet = activeSheet();
  return sheet ? ctxOf(sheet.id) : null;
}

// ------------------------------------------------------- selection helpers

function fallbackSelection() {
  return { active: 'A1', range: { s: { row: 0, col: 0 }, e: { row: 0, col: 0 } } };
}

/** The grid's current selection, always in the documented shape. */
function selOf() {
  let sel = null;
  try { sel = grid && typeof grid.getSelection === 'function' ? grid.getSelection() : null; }
  catch (e) { sel = null; }
  if (!sel || typeof sel !== 'object') return fallbackSelection();
  const active = typeof sel.active === 'string' && sel.active ? sel.active : 'A1';
  const r = sel.range;
  if (!r || !r.s || !r.e) {
    let rc;
    try { rc = a1ToCell(active); } catch (e) { rc = { row: 0, col: 0 }; }
    return { active, range: { s: { row: rc.row, col: rc.col }, e: { row: rc.row, col: rc.col } } };
  }
  return { active, range: r };
}

/** Normalised inclusive bounds of a selection. */
function bounds(sel) {
  const r = sel.range;
  return {
    r1: Math.min(r.s.row, r.e.row), r2: Math.max(r.s.row, r.e.row),
    c1: Math.min(r.s.col, r.e.col), c2: Math.max(r.s.col, r.e.col),
  };
}

/** A1 keys covered by a selection, or null when it exceeds `cap` cells. */
function selectionKeys(sel, cap) {
  const b = bounds(sel);
  const limit = cap || MAX_EDIT_CELLS;
  const area = (b.r2 - b.r1 + 1) * (b.c2 - b.c1 + 1);
  if (!isFinite(area) || area <= 0 || area > limit) return null;
  const keys = [];
  for (let r = b.r1; r <= b.r2; r++) {
    for (let c = b.c1; c <= b.c2; c++) keys.push(cellToA1(r, c));
  }
  return keys;
}

/** 'B2' for a single cell, 'B2:D9' for a block. */
function selectionLabel(sel) {
  const b = bounds(sel);
  if (b.r1 === b.r2 && b.c1 === b.c2) return cellToA1(b.r1, b.c1);
  return cellToA1(b.r1, b.c1) + ':' + cellToA1(b.r2, b.c2);
}

/** 합계 / 평균 / 개수 over the numeric cells of the selection. */
function selectionStats(sel) {
  const b = bounds(sel);
  const area = (b.r2 - b.r1 + 1) * (b.c2 - b.c1 + 1);
  let sum = 0;
  let count = 0;
  const visit = (a1) => {
    let v;
    try { v = engine.getValue(a1); } catch (e) { return; }
    if (typeof v === 'number' && isFinite(v)) { sum += v; count += 1; }
  };
  if (area <= MAX_EDIT_CELLS) {
    for (let r = b.r1; r <= b.r2; r++) {
      for (let c = b.c1; c <= b.c2; c++) visit(cellToA1(r, c));
    }
  } else {
    // Huge (whole column/row) selections: only populated cells can contribute.
    const ctx = activeCtx();
    const shadow = ctx ? ctx.shadow : new Map();
    for (const key of shadow.keys()) {
      let rc;
      try { rc = a1ToCell(key); } catch (e) { continue; }
      if (rc.row >= b.r1 && rc.row <= b.r2 && rc.col >= b.c1 && rc.col <= b.c2) visit(key);
    }
  }
  return { sum, avg: count ? sum / count : 0, count };
}

function activeStyle() {
  try { return engine.getStyle(selOf().active) || {}; } catch (e) { return {}; }
}

// ------------------------------------------------- engine / model mutation

/** engine.setStyle(a1, null) is not in the contract; clear key by key instead. */
function setStyleSafe(eng, a1, style) {
  if (style === null || style === undefined) {
    let cur = null;
    try { cur = eng.getStyle(a1); } catch (e) { cur = null; }
    if (!cur) return;
    const clear = {};
    for (const key of Object.keys(cur)) clear[key] = null;
    if (Object.keys(clear).length) eng.setStyle(a1, clear);
    return;
  }
  eng.setStyle(a1, style);
}

/** Apply a cells patch to one sheet's engine. -> Set of A1 keys needing a repaint. */
/**
 * Does this sheet's engine already hold exactly what `cells` says?
 *
 * The server echoes every edit back to its author. Normally that echo is redundant —
 * the value went on screen the moment it was typed — so re-applying it would be wasted
 * parsing and recalculation. After a RECONNECT it is not redundant at all: onWelcome
 * replaces every engine with the server's snapshot, and an edit made while the socket
 * was down is replayed only afterwards. Skipping that echo leaves the value stored on
 * the server and missing from the screen, which is exactly what "the text I just typed
 * disappeared" looks like.
 *
 * Comparing the stored input strings is far cheaper than re-parsing, so this is what
 * decides whether the echo can be skipped, rather than who sent it.
 */
function engineAgrees(cells, ctx) {
  const eng = ctx && ctx.engine;
  if (!eng) return false;
  for (const key of Object.keys(cells)) {
    const v = cells[key];
    const wanted = (v === null || v === undefined) ? ''
      : (v && typeof v === 'object' && 'input' in v)
        ? (v.input === undefined || v.input === null ? '' : String(v.input))
        : null;
    if (wanted === null) continue;          // a style-only patch says nothing about input
    let have = '';
    try { have = eng.getInput(key) || ''; } catch (e) { return false; }
    if (have !== wanted) return false;
  }
  return true;
}

function applyToEngine(cells, ctx) {
  const eng = ctx.engine;
  const changed = new Set();
  const inputs = {};
  let hasInput = false;

  for (const key of Object.keys(cells)) {
    const v = cells[key];
    if (v === null || v === undefined) { inputs[key] = null; hasInput = true; continue; }
    if (typeof v === 'object' && 'input' in v) {
      inputs[key] = v.input === undefined ? null : v.input;
      hasInput = true;
    }
  }
  if (hasInput) {
    try {
      const touched = eng.setInputs(inputs);
      if (touched) for (const key of touched) changed.add(key);
    } catch (e) {
      console.error('[main] 셀 입력을 적용하지 못했습니다', e);
    }
  }
  for (const key of Object.keys(cells)) {
    const v = cells[key];
    try {
      if (v === null || v === undefined) setStyleSafe(eng, key, null);
      else if (typeof v === 'object' && 'style' in v) setStyleSafe(eng, key, v.style);
    } catch (e) {
      console.error('[main] 셀 서식을 적용하지 못했습니다: ' + key, e);
    }
    changed.add(key);
  }
  return changed;
}

/** Mirror one shadow entry into sheet.cells (kept object-identical for the grid). */
function syncSheetCell(a1, ctx) {
  const cells = ctx.sheet.cells || (ctx.sheet.cells = {});
  const cur = ctx.shadow.get(a1);
  if (!cur) { delete cells[a1]; return; }
  const out = {};
  if (cur.input !== undefined) out.input = cur.input;
  if (cur.style) out.style = { ...cur.style };
  if (cur.link) out.link = cur.link;      // what the grid renders the <a> from
  cells[a1] = out;
}

/** Apply a cells patch to a sheet's shadow + cells (never to the engine). */
function applyPatchToModel(cells, ctx) {
  for (const key of Object.keys(cells)) {
    const v = cells[key];
    if (v === null || v === undefined) {
      ctx.shadow.delete(key);
      syncSheetCell(key, ctx);
      continue;
    }
    const prev = ctx.shadow.get(key);
    const next = {
      input: prev ? prev.input : undefined,
      style: prev && prev.style ? { ...prev.style } : undefined,
      link: prev ? prev.link : undefined,
    };
    if ('input' in v) {
      next.input = (v.input === null || v.input === undefined || v.input === '')
        ? undefined : String(v.input);
    }
    if ('style' in v) {
      if (v.style === null || v.style === undefined) next.style = undefined;
      else {
        const merged = { ...(next.style || {}) };
        for (const sk of Object.keys(v.style)) {
          const sv = v.style[sk];
          if (sv === null || sv === undefined) delete merged[sk];
          else merged[sk] = sv;
        }
        next.style = Object.keys(merged).length ? merged : undefined;
      }
    }
    if ('link' in v) {
      // null clears it; anything sanitizeLink rejects is dropped rather than stored,
      // so the mirror can only ever hold a link the grid is allowed to render.
      next.link = (v.link === null || v.link === undefined)
        ? undefined
        : (sanitizeLink(v.link) || undefined);
    }
    if (next.input === undefined && !next.style && !next.link) ctx.shadow.delete(key);
    else ctx.shadow.set(key, next);
    syncSheetCell(key, ctx);
  }
}

/** The patch that puts every touched cell of `ctx` back the way it is right now. */
function inverseOf(cells, ctx) {
  const inv = {};
  for (const key of Object.keys(cells)) {
    const v = cells[key];
    const old = ctx.shadow.get(key);
    if (!old) { inv[key] = null; continue; }           // the cell did not exist
    if (v === null || v === undefined) {
      inv[key] = {
        input: old.input === undefined ? null : old.input,
        style: old.style ? { ...old.style } : null,
        link: old.link === undefined ? null : old.link,
      };
      continue;
    }
    const entry = {};
    if ('input' in v) entry.input = old.input === undefined ? null : old.input;
    if ('style' in v) {
      if (v.style === null || v.style === undefined) {
        entry.style = old.style ? { ...old.style } : null;
      } else {
        const back = {};
        for (const sk of Object.keys(v.style)) {
          back[sk] = (old.style && old.style[sk] !== undefined) ? old.style[sk] : null;
        }
        entry.style = back;
      }
    }
    if ('link' in v) entry.link = old.link === undefined ? null : old.link;
    inv[key] = Object.keys(entry).length ? entry : null;
  }
  return inv;
}

function safeRefresh(keys) {
  if (!grid) return;
  try { grid.refreshCells(Array.from(keys)); }
  catch (e) {
    try { grid.render(); } catch (e2) { console.error('[main] 다시 그리기 실패', e2); }
  }
}

// -------------------------------------------------------------- durability
//
// SPEC 27. The promise is absolute — once a person types something, it survives — and
// this section is the client's half of keeping it. Three rules hold it together:
//
//   1. A frame is PERSISTED BEFORE IT IS SENT. sendTracked() writes it to the outbox
//      first and hands it to the socket second, so there is no instant in which the
//      only copy of a keystroke is a value in a local variable.
//   2. A frame is dropped ONLY on an ack, and an ack means the server's journal line
//      reached the operating system (SPEC 27.3). "Received" is not good enough.
//   3. The save indicator is computed from those two facts and nothing else. It may
//      say less than the truth; it may never say more.
//
// Everything else — the coalescer below, Net's per-connection queue — is about
// latency. This is about not losing work.

/**
 * The stand-in used when the real Outbox cannot be built at all (an exception out of
 * its constructor, or a build where the module resolved to something unexpected).
 *
 * It keeps frames in memory only, which is what a private-mode browser gets anyway, and
 * its whole reason to exist is that the alternative — no outbox — would leave size()
 * permanently 0 and the indicator permanently reading 저장됨 while frames were still in
 * flight. A wrong 저장됨 is the one outcome SPEC 27.5 forbids outright, so the fallback
 * is a working outbox that simply cannot survive the tab.
 */
class MemoryOutbox {
  constructor(docId) {
    this.docId = docId;
    this.persistent = false;
    this._seq = 0;
    /** @type {Map<string, object>} opId -> frame, in insertion order */
    this._frames = new Map();
  }

  add(frame) {
    this._seq += 1;
    const opId = 'm' + Date.now().toString(36) + this._seq.toString(36);
    this._frames.set(opId, { ...frame, opId });
    // The same cap the real outbox obeys (SPEC 27.4): oldest first, and the caller
    // notices the drop by watching size(), exactly as it does for the real one.
    while (this._frames.size > MAX_OUTBOX) {
      const oldest = this._frames.keys().next();
      if (oldest.done) break;
      this._frames.delete(oldest.value);
    }
    return opId;
  }

  ack(opId) { this._frames.delete(opId); }
  pending() { return Array.from(this._frames.values()); }
  size() { return this._frames.size; }
  clear() { this._frames.clear(); }
}

/** @type {{add:Function, ack:Function, pending:Function, size:Function, clear:Function}|null} */
let saveOutbox = null;
/** Did localStorage accept a write at boot? Only consulted if the outbox has no opinion. */
let storageProbeOk = false;
/** True once the outbox is reporting its own evictions, so size() need not guess at them. */
let outboxReportsDrops = false;
let saveOutboxWarned = false;
let droppedFrames = 0;
let dropToastTimer = null;
let savePainted = '';

/**
 * Can this browser actually keep something for us? Written the way the outbox writes:
 * a real setItem, because a browser can expose localStorage and still throw on write
 * (private mode, a full quota, a blocked third-party context).
 */
function storageWorks() {
  try {
    localStorage.setItem(OUTBOX_PROBE_KEY, '1');
    localStorage.removeItem(OUTBOX_PROBE_KEY);
    return true;
  } catch (e) {
    return false;
  }
}

/**
 * Build the document's outbox and work out whether it is genuinely durable.
 *
 * An instance is allowed to answer that question itself (a `persistent`-style flag);
 * otherwise we probe localStorage directly, which is what the outbox is backed by. The
 * answer only ever weakens the indicator, so guessing wrong can cost a caveat that was
 * not needed — never a 저장됨 that was not earned.
 */
function makeOutbox(docId) {
  storageProbeOk = storageWorks();
  const onDrop = (frames, info) => {
    outboxReportsDrops = true;
    const count = (info && Number.isFinite(info.count)) ? info.count
      : (Array.isArray(frames) ? frames.length : 1);
    noticeDroppedFrames(count);
  };

  let box = null;
  try {
    // The options object is how the outbox reports an eviction at the cap, INCLUDING one
    // that happens while loading a previous tab's queue — which is why it is passed to the
    // constructor rather than assigned afterwards.
    if (typeof Outbox === 'function') box = new Outbox(docId, { onDrop });
  } catch (e) {
    console.warn('[main] 임시 보관함을 만들지 못했습니다', e);
    box = null;
  }
  if (box && typeof box.onDrop !== 'function') {
    try { box.onDrop = onDrop; } catch (e) { /* a frozen instance reports through size() */ }
  }
  if (!box || typeof box.add !== 'function' || typeof box.size !== 'function'
      || typeof box.ack !== 'function' || typeof box.pending !== 'function') {
    box = new MemoryOutbox(docId);
  }
  saveOutbox = box;
  if (!outboxPersists()) noticeNoStorage();
}

/**
 * Is the outbox genuinely surviving this tab right now?
 *
 * Asked on every paint rather than answered once at boot, because it can change under
 * us: a quota that fills mid-session turns a persisted outbox into a memory-only one,
 * and the indicator has to start admitting that the moment it happens. The instance's
 * own flag wins when it has one — it knows about a failed write, which no probe here
 * could see — and the boot probe is only the fallback for an outbox that says nothing.
 */
function outboxPersists() {
  const box = saveOutbox;
  if (!box || box instanceof MemoryOutbox) return false;
  for (const key of ['available', 'persistent', 'durable', 'persisted']) {
    if (typeof box[key] === 'boolean') return box[key];
  }
  return storageProbeOk;
}

function outboxSize() {
  if (!saveOutbox) return 0;
  try { return saveOutbox.size() | 0; } catch (e) { return 0; }
}

/** Is the socket actually up? Falls back to the reported status if Net cannot say. */
function socketIsOpen() {
  if (!net) return false;
  if (typeof net.isOpen === 'function') {
    try { return !!net.isOpen(); } catch (e) { /* fall through to the status */ }
  }
  return state.status === 'online';
}

/**
 * The one door every document-mutating frame leaves by.
 *
 * Order is the whole point: add() persists first and returns the `opId` the server will
 * echo, and only then does the frame reach the socket. A crash between the two costs a
 * duplicate send at worst — frames are idempotent, last-write-wins per cell — where the
 * reverse order would cost the edit itself.
 *
 * @param {object} frame a complete wire frame, minus the opId
 * @returns {boolean} true when the frame is safely somebody's responsibility
 */
function sendTracked(frame) {
  if (!frame || typeof frame !== 'object') return false;
  let wire = frame;
  let held = false;                       // the outbox has a durable copy of this frame
  if (saveOutbox && TRACKED_FRAMES.has(frame.t)) {
    const before = outboxSize();
    let opId = null;
    try {
      opId = saveOutbox.add(frame);
    } catch (e) {
      console.warn('[main] 임시 보관에 실패했습니다', e);
      opId = null;
    }
    if (typeof opId === 'string' && opId) { wire = { ...frame, opId }; held = true; }
    // A full outbox drops its oldest frames (SPEC 27.4). An outbox that reports its own
    // evictions has already said so; one that does not is measured instead — an add that
    // did not grow it by one means that many frames went over the side, whatever the
    // implementation chose to throw away. Never both, or a drop would be counted twice.
    if (!outboxReportsDrops) {
      const dropped = before + 1 - outboxSize();
      if (dropped > 0) noticeDroppedFrames(dropped);
    }
  }
  // While the socket is up, straight out. While it is down, a frame the outbox is
  // already holding must NOT also go into Net's per-connection queue: that queue
  // replays on `open` and this file replays after `welcome`, so the frame would be
  // delivered twice. A cell edit survives that — it is last-write-wins — but 시트 추가
  // and 댓글 달기 do not, and would leave the user with two sheets or two comments.
  // One holder, one delivery: whoever is keeping the frame is the one who sends it.
  let sent = false;
  if (net && (socketIsOpen() || !held)) {
    try { net.send(wire); sent = true; }
    catch (e) { console.warn('[main] 프레임 전송 실패', e); }
  }
  paintSave();
  // True when the frame is somebody's responsibility now: on the wire, in Net's queue,
  // or in the outbox. Only a frame nothing accepted is a failure worth reporting.
  return held || sent;
}

/**
 * Re-send everything still unacknowledged, in the order it was written.
 *
 * Runs after EVERY `welcome`, first connection and reconnect alike, because a reconnect
 * is the only moment at which a frame written by a previous tab can reach the server at
 * all. Replaying a frame the server already applied is harmless: the protocol is
 * last-write-wins per cell, and a repeated `opId` simply acks again.
 */
function replayOutbox() {
  if (!saveOutbox || !net) return;
  let list = [];
  try { list = saveOutbox.pending() || []; } catch (e) { list = []; }
  if (!Array.isArray(list) || list.length === 0) { paintSave(); return; }
  for (const entry of list) {
    // If the socket drops mid-replay, stop: what is left stays in the outbox and goes
    // out after the next `welcome`. Pushing the rest into Net's queue instead would
    // hand the same frames to two senders, which is the one thing to avoid here.
    if (!socketIsOpen()) break;
    const wire = replayFrameOf(entry);
    if (!wire) continue;
    try { net.send(wire); }
    catch (e) { console.warn('[main] 보관된 변경을 다시 보내지 못했습니다', e); }
  }
  paintSave();
}

/**
 * Normalise one stored entry into a sendable frame. `pending()` returns frames, but a
 * stored record that wraps one ({opId, frame}) is unwrapped rather than sent as-is: the
 * ack has to match the id the outbox is holding, so the id travels with the frame no
 * matter which shape it was kept in.
 */
function replayFrameOf(entry) {
  if (!entry || typeof entry !== 'object') return null;
  let frame = entry;
  if (typeof entry.t !== 'string' && entry.frame && typeof entry.frame === 'object') {
    frame = entry.frame;
  }
  if (typeof frame.t !== 'string' || !TRACKED_FRAMES.has(frame.t)) return null;
  const opId = (typeof entry.opId === 'string' && entry.opId) ? entry.opId : frame.opId;
  if (typeof opId === 'string' && opId && frame.opId !== opId) frame = { ...frame, opId };
  // A frame carried across from an earlier session belongs to THIS document; anything
  // else would be applied to a document the user is not looking at.
  if (frame.docId !== state.docId) frame = { ...frame, docId: state.docId };
  return frame;
}

/** SPEC 27.3 — the server has this on disk. Only now may we forget it. */
function onAckFrame(msg) {
  const opId = msg && msg.opId;
  if (typeof opId !== 'string' || !opId) return;
  if (saveOutbox) {
    try { saveOutbox.ack(opId); } catch (e) { console.warn('[main] 보관 해제 실패', e); }
  }
  paintSave();
}

/**
 * The save indicator (SPEC 27.5). Two inputs, and deliberately no third: how many frames
 * the outbox is still holding, and whether the socket is up.
 *
 * The ONLY path to 저장됨 runs through `pending === 0`, which is true only once every
 * frame has been acknowledged. There is no timer, no optimism and no "probably fine"
 * branch, because this is the one thing on screen a person will trust. When the outbox
 * cannot persist, 저장됨 carries the caveat that says so — and while anything is pending
 * the caveat moves to the tooltip, because the text has to report the pending work first.
 */
function paintSave() {
  if (!ui || !ui.save) return;
  // Before the outbox exists there is no honest answer, so the indicator stays silent
  // rather than guessing. boot() builds it and paints immediately afterwards.
  if (!saveOutbox) return;
  const pending = outboxSize();
  const persists = outboxPersists();
  if (!persists) noticeNoStorage();       // guarded: said once, whenever it becomes true
  let key;
  if (pending > 0) key = state.status === 'online' ? 'saving' : 'pending';
  else key = persists ? 'saved' : 'nostore';
  const view = SAVE_VIEW[key];
  const text = key === 'pending' ? view.text + ' (' + pending + ')' : view.text;
  const title = (pending > 0 && !persists)
    ? view.title + ' ' + SAVE_VIEW.nostore.title
    : view.title;
  const stamp = key + '|' + text;
  if (stamp === savePainted) return;      // no DOM write when nothing moved
  savePainted = stamp;
  ui.save.dataset.state = key;
  ui.save.textContent = text;
  ui.save.title = title;
}

/**
 * The outbox hit its cap and threw work away. SPEC 27.4 is explicit that this may not be
 * silent, so it is a toast — coalesced over a second, because the drops arrive one per
 * frame and a hundred toasts would hide the message instead of delivering it.
 */
function noticeDroppedFrames(count) {
  if (!(count > 0)) return;
  droppedFrames += count;
  if (dropToastTimer !== null) return;
  dropToastTimer = setTimeout(() => {
    dropToastTimer = null;
    const total = droppedFrames;
    droppedFrames = 0;
    toast('임시 보관함이 가득 차 오래된 변경 ' + total + '건을 보관하지 못했습니다. '
      + '연결이 복구될 때까지 편집을 잠시 멈춰 주세요.', 'error');
  }, DROP_TOAST_MS);
}

/** Said once per session: this browser cannot hold unsent work for us (SPEC 27.4). */
function noticeNoStorage() {
  if (saveOutboxWarned) return;
  saveOutboxWarned = true;
  toast('이 브라우저에서는 변경 내용을 임시 보관할 수 없습니다. '
    + '연결이 끊긴 채로 탭을 닫으면 보내지 못한 변경은 사라집니다.', 'error');
}

// -------------------------------------------------------- the edit coalescer
//
// Edits are coalesced per sheet and flushed as one 'edit' frame each, so a burst of
// keystrokes costs one frame — and a frame can never mix two sheets' cells. This buffer
// is the ONE place a keystroke is briefly held in memory alone, which is why the window
// is 60 ms and why beforeunload flushes it first: past this point the edit is in the
// outbox and is no longer at risk.

/** @type {Map<string, object>} sheetId -> merged cells patch waiting to go out */
const editBuffers = new Map();
let editBufferTimer = null;

function queueEdit(sheetId, cells) {
  if (!sheetId) return;
  let buf = editBuffers.get(sheetId);
  if (!buf) { buf = {}; editBuffers.set(sheetId, buf); }
  for (const key of Object.keys(cells)) {
    const next = cells[key];
    if (next === null || next === undefined) { buf[key] = null; continue; }
    const prev = buf[key];
    buf[key] = (prev && typeof prev === 'object') ? { ...prev, ...next } : { ...next };
  }
  if (editBufferTimer !== null) return;
  editBufferTimer = setTimeout(() => { editBufferTimer = null; flushEdits(); }, EDIT_COALESCE_MS);
}

function flushEdits() {
  if (editBufferTimer !== null) { clearTimeout(editBufferTimer); editBufferTimer = null; }
  if (editBuffers.size === 0) return;
  const pending = Array.from(editBuffers.entries());
  editBuffers.clear();
  for (const [sheetId, buf] of pending) {
    for (const chunk of chunkCells(buf)) {
      // Into the outbox first, the socket second: a flush while the socket is down still
      // persists the edit, which is the whole point of SPEC 27.4.
      sendTracked({ t: 'edit', docId: state.docId, sheetId, cells: chunk });
    }
  }
}

/**
 * Split a cells patch into frames the server will actually accept.
 *
 * Two limits, not one. The cell cap is the obvious one; the BYTE cap is the dangerous
 * one. The socket is created with `maxPayload: 256 KB`, and an oversized frame is killed
 * by the WebSocket layer before any handler runs — so no error, no `opId`, nothing comes
 * back. The frame is already in the outbox, so every reconnect replays it and kills the
 * socket again, for ever, surviving even a reload because the outbox is persisted. One
 * wide paste could put a document permanently beyond saving.
 *
 * Cells are measured as they are added and a chunk is closed before it can cross the
 * budget. A single cell larger than the budget on its own is still emitted alone — the
 * server will refuse it with an error carrying its opId, which is recoverable, whereas
 * silently dropping the user's data here is not.
 */
function* chunkCells(buf) {
  const keys = Object.keys(buf);
  let chunk = {};
  let count = 0;
  let bytes = FRAME_OVERHEAD_BYTES;
  for (const key of keys) {
    let size = 0;
    try {
      size = JSON.stringify(buf[key]).length + key.length + 4;
    } catch (e) {
      size = MAX_FRAME_BODY_BYTES; // unserialisable: give it a frame of its own
    }
    if (count > 0 && (count >= MAX_EDIT_CELLS || bytes + size > MAX_FRAME_BODY_BYTES)) {
      yield chunk;
      chunk = {};
      count = 0;
      bytes = FRAME_OVERHEAD_BYTES;
    }
    chunk[key] = buf[key];
    count += 1;
    bytes += size;
  }
  if (count > 0) yield chunk;
}

let cursorTimer = null;
let cursorLast = 0;

/** Tell the server where we are — and, just as importantly, WHICH SHEET we are on. */
function sendCursor(immediate) {
  if (!net || !state.sheetId) return;
  const now = Date.now();
  const waited = now - cursorLast;
  if (immediate || waited >= CURSOR_THROTTLE_MS) {
    if (cursorTimer !== null) { clearTimeout(cursorTimer); cursorTimer = null; }
    cursorLast = now;
    const sel = selOf();
    try {
      net.send({
        t: 'cursor',
        docId: state.docId,
        sheetId: state.sheetId,
        active: sel.active,
        range: sel.range,
      });
    } catch (e) { /* offline: the frame is pointless once stale */ }
    return;
  }
  if (cursorTimer !== null) return;
  cursorTimer = setTimeout(() => {
    cursorTimer = null;
    sendCursor(true);
  }, CURSOR_THROTTLE_MS - waited);
}

// ------------------------------------------------------ the mutation funnel

/**
 * The single funnel for every local cell mutation.
 * @param {object} cells  { A1: {input}|{style}|null }
 * @param {{alreadyApplied?:boolean, record?:boolean, label?:string, sheetId?:string}} [options]
 */
function commitLocalEdit(cells, options) {
  const opts = options || {};
  if (!cells || typeof cells !== 'object') return;
  const keys = Object.keys(cells);
  if (keys.length === 0) return;
  if (keys.length > MAX_EDIT_CELLS) {
    toast('한 번에 편집할 수 있는 칸은 ' + MAX_EDIT_CELLS + '개까지입니다.', 'error');
    return;
  }

  const sheetId = opts.sheetId || state.sheetId;
  const ctx = ctxOf(sheetId);
  if (!ctx) return;                       // the sheet was deleted under us
  const record = opts.record !== false;
  const inverse = record ? inverseOf(cells, ctx) : null;

  if (!opts.alreadyApplied) {
    const changed = applyToEngine(cells, ctx);
    applyPatchToModel(cells, ctx);
    if (sheetId === state.sheetId) safeRefresh(changed);
  } else {
    // The grid wrote to the engine and already repainted the cells whose value
    // changed; only the private mirror and the wire are still owed.
    applyPatchToModel(cells, ctx);
  }

  queueEdit(sheetId, clonePatch(cells));
  // A filter is a view over VALUES, so any write can change which rows survive it
  // (SPEC 24.1). Only the cached count is dropped here; it is recomputed lazily, and a
  // sheet with no filter never computes one at all.
  invalidateFilterView(sheetId);

  if (record) {
    const forward = clonePatch(cells);
    const backward = inverse;
    const label = opts.label || '편집';
    // An undo entry belongs to the sheet it was recorded on. Applying it while the
    // user looks at another sheet would edit cells nobody can see, so the entry
    // switches to its own sheet first.
    const apply = (patch) => {
      if (!sheetById(sheetId)) {
        toast('삭제된 시트의 작업은 되돌릴 수 없습니다.', 'error');
        return;
      }
      activateSheet(sheetId);
      commitLocalEdit(patch, { record: false, label, sheetId });
    };
    history.push({
      label,
      undo: () => apply(backward),
      redo: () => apply(forward),
    });
  }

  refreshToolbar();
}

// ------------------------------------------------------------ toolbar view

let toolbarPending = false;

function refreshToolbar() {
  if (!toolbar || toolbarPending) return;
  toolbarPending = true;
  onNextFrame(() => {
    toolbarPending = false;
    paintToolbar();
  });
}

function paintToolbar() {
  // The extent readout and the grow control describe the SHEET, not the selection,
  // so they are painted before the guard below: they stay right even in the moments
  // when there is no toolbar to paint (SPEC 25.4).
  paintGrowState();
  if (!toolbar || !engine) return;
  const sel = selOf();
  let style = {};
  let formula = '';
  let value = '';
  try { style = engine.getStyle(sel.active) || {}; } catch (e) { style = {}; }
  try { formula = engine.getInput(sel.active) || ''; } catch (e) { formula = ''; }
  try { value = formatValue(engine.getValue(sel.active), style); } catch (e) { value = ''; }
  const label = selectionLabel(sel);
  const stats = selectionStats(sel);
  const sheetNow = activeSheet();
  toolbar.setState({
    style, value, formula, selectionLabel: label, stats,
    // Flips the merge button between 셀 병합 and 병합 해제 (SPEC 21.5).
    merged: selectionHasMerge(sel),
    // The six cell-formatting values of the active cell (SPEC 22.4), so 글꼴,
    // 글꼴 크기, 테두리, 세로 정렬, 텍스트 줄바꿈 and 텍스트 회전 each show what is
    // actually in force. Passing them explicitly — rather than letting the toolbar
    // dig them out of `style` — keeps this the single place that decides what the
    // controls reflect.
    ff: style.ff, fs: style.fs, va: style.va,
    wrap: style.wrap, rot: style.rot, bd: style.bd,
    // The tools' own state (SPEC 23): whether the format painter is armed, the zoom
    // in force as a percentage, and the active cell's link — which is what prefills
    // the link panel and lights the 링크 button.
    painting: painter.on,
    zoom: Math.round(zoomFactor * 100),
    link: activeLink(),
    // The data features (SPEC 24): whether this sheet carries a filter — which is what
    // flips 필터 만들기 to 필터 끄기 — whether it holds any chart, and whether the ACTIVE
    // CELL already has a comment thread.
    filtered: !!filterOf(sheetNow),
    hasChart: chartsOf(sheetNow).length > 0,
    hasComment: !!threadAt(sheetNow, sel.active),
  });
  paintSelStats(sel, label, stats);
}

/**
 * The footer readout (#sz-selstats). The toolbar already shows 합계/평균/개수,
 * so this one carries what that cannot: the sheet and the extent of the selection.
 */
function paintSelStats(sel, label, stats) {
  if (!ui || !ui.selStats) return;
  const b = bounds(sel);
  const rows = b.r2 - b.r1 + 1;
  const cols = b.c2 - b.c1 + 1;
  const sheet = activeSheet();
  let text = (sheet && sheet.name ? sheet.name + ' · ' : '') + '선택 ' + label;
  if (rows > 1 || cols > 1) text += ' · ' + rows + '행 × ' + cols + '열';
  if (stats && stats.count) text += ' · 숫자 ' + stats.count + '칸';
  // SPEC 24.1 — how much of the filter range is showing, but only while the filter is
  // actually hiding something: a filter that hides nothing has nothing to report.
  const counts = filterCounts();
  if (counts && counts.visible < counts.total) {
    text += ' · ' + counts.total + '개 중 ' + counts.visible + '개 표시';
  }
  ui.selStats.textContent = text;
}

/**
 * The sheet's extent — `200행 x 26열` beside the selection readout (SPEC 25.4) — and
 * the grow control's view of it. Both answer the same question, "how big is this
 * sheet", so they are painted from one place and can never disagree.
 *
 * It gets its own element rather than being appended to the selection readout: that
 * one is `text-overflow: ellipsis`, so a size tacked onto its end would be the first
 * thing to disappear on a narrow window — and the size is the very thing a user goes
 * looking for when they wonder why the grid stops where it does.
 */
function paintGrowState() {
  const sheet = activeSheet();
  const rows = sheet && Number.isFinite(sheet.rows) ? sheet.rows : DEFAULT_ROWS;
  const cols = sheet && Number.isFinite(sheet.cols) ? sheet.cols : DEFAULT_COLS;
  if (ui && ui.extent) {
    const text = rows + '행 x ' + cols + '열';
    if (ui.extent.textContent !== text) ui.extent.textContent = text;
  }
  if (growBar) {
    try {
      growBar.setState({ rows, cols, maxRows: MAX_ROWS, maxCols: MAX_COLS });
    } catch (e) {
      console.error('[main] 시트 크기 컨트롤 갱신 실패', e);
    }
  }
}

// ------------------------------------------------------------ doc plumbing

function normalizeSheet(raw, index) {
  const s = raw && typeof raw === 'object' ? raw : {};
  const id = typeof s.id === 'string' && s.id ? s.id : 'sheet' + (index + 1);
  const name = typeof s.name === 'string' && s.name
    ? s.name
    : (index === 0 ? DEFAULT_SHEET_NAME : '시트' + (index + 1));
  const rows = Number.isFinite(s.rows) ? s.rows : DEFAULT_ROWS;
  const cols = Number.isFinite(s.cols) ? s.cols : DEFAULT_COLS;
  return {
    id,
    name,
    color: typeof s.color === 'string' && HEX_RE.test(s.color) ? s.color.toLowerCase() : null,
    rows,
    cols,
    cells: s.cells && typeof s.cells === 'object' ? s.cells : {},
    colWidths: s.colWidths && typeof s.colWidths === 'object' ? s.colWidths : {},
    rowHeights: s.rowHeights && typeof s.rowHeights === 'object' ? s.rowHeights : {},
    frozenRows: Number.isFinite(s.frozenRows) ? s.frozenRows : 0,
    frozenCols: Number.isFinite(s.frozenCols) ? s.frozenCols : 0,
    // Always an array, never undefined, so the grid and the merge helpers can iterate
    // it without a guard. A malformed list from the wire is dropped, not trusted.
    merges: normalizeMergeList(s.merges, rows, cols),
    // Batch C (SPEC 24), same contract: null / [] / {} rather than undefined, so every
    // consumer reads them without a guard, and re-validated on the way IN as well as on
    // the way out — comment text and chart titles are user input from another client.
    filter: sanitizeFilter(s.filter, rows, cols),
    charts: sanitizeChartList(s.charts, rows, cols),
    comments: sanitizeComments(s.comments, rows, cols),
  };
}

function normalizeDoc(raw) {
  const d = raw && typeof raw === 'object' ? raw : {};
  let list = Array.isArray(d.sheets) ? d.sheets.filter((s) => s && typeof s === 'object') : [];
  if (!list.length) {
    // A document from before sheets existed (the server migrates these, but a stripped
    // payload must still open): everything at the top level becomes the single sheet.
    list = [{
      id: typeof d.sheetId === 'string' ? d.sheetId : 'sheet1',
      name: DEFAULT_SHEET_NAME,
      rows: d.rows, cols: d.cols, cells: d.cells,
      colWidths: d.colWidths, rowHeights: d.rowHeights,
      frozenRows: d.frozenRows, frozenCols: d.frozenCols,
    }];
  }
  const seen = new Set();
  const sheets = [];
  list.forEach((s, i) => {
    const sheet = normalizeSheet(s, i);
    if (seen.has(sheet.id)) return;       // a duplicate id would break the engine cache
    seen.add(sheet.id);
    sheets.push(sheet);
  });
  return {
    id: String(d.id || ''),
    name: typeof d.name === 'string' && d.name ? d.name : DEFAULT_DOC_NAME,
    sheets,
    createdAt: d.createdAt || Date.now(),
    updatedAt: d.updatedAt || Date.now(),
    rev: Number.isFinite(d.rev) ? d.rev : 0,
  };
}

/**
 * Install a document the server sent.
 *
 * Sheets that survive keep their JavaScript identity (their contents are copied into
 * the object that is already there), because the grid holds a reference to the active
 * sheet: swapping the object under it would force a full rebind and throw away the
 * user's scroll position for no reason.
 *
 * @param {object} raw
 * @param {{keepEngines?:boolean}} [options]
 *   keepEngines — the frame changed the sheet LIST, not any cell, so every surviving
 *   sheet keeps its engine (and therefore its computed values). Engines belonging to
 *   sheets that are gone are dropped either way.
 */
function adoptDoc(raw, options) {
  const opts = options || {};
  const next = normalizeDoc(raw);
  if (!next.id) next.id = state.docId;
  const prev = state.doc;

  if (prev) {
    const byId = new Map(prev.sheets.map((s) => [s.id, s]));
    next.sheets = next.sheets.map((sheet) => {
      const old = byId.get(sheet.id);
      if (!old) return sheet;
      Object.assign(old, sheet);
      return old;
    });
  }
  state.doc = next;
  state.docId = next.id || state.docId;

  const live = new Set(next.sheets.map((s) => s.id));
  for (const id of Array.from(sheetCtxs.keys())) {
    if (!live.has(id)) sheetCtxs.delete(id);
  }

  for (const sheet of next.sheets) {
    const ctx = sheetCtxs.get(sheet.id);
    if (!ctx) continue;                   // no engine yet: it will be built from these cells
    ctx.sheet = sheet;
    if (opts.keepEngines) {
      // The engine is authoritative for a sheet we already opened; re-seed the plain
      // mirror from it so the two can never drift.
      sheet.cells = cellsFromShadow(ctx.shadow);
      continue;
    }
    try {
      ctx.engine.rows = sheet.rows;
      ctx.engine.cols = sheet.cols;
      ctx.engine.bulkLoad(sheet.cells);
    } catch (e) {
      console.error('[main] 문서를 엔진에 적재하지 못했습니다', e);
    }
    ctx.shadow = buildShadow(sheet);
  }

  // The row counts behind "N개 중 M개 표시" describe cells that have just been
  // replaced wholesale, so every one of them is stale (SPEC 24.1).
  invalidateFilterView();
  // A panel bound to a sheet this document no longer has must not stay on screen.
  if (!sheetById(filterPanel.sheetId)) closeFilterPanel();
  if (!sheetById(state.sheetId)) { closeChartPanel(); closeCommentPanel(); }

  // The sheet on screen may be gone. Leaving the id dangling would be worse than
  // clearing it: an empty id makes the next activateSheet() a real rebind rather than
  // a no-op, so the grid can never keep showing a sheet the document no longer has.
  if (!sheetById(state.sheetId)) state.sheetId = '';

  setDocTitle(next.name);
  if (docsMenu) docsMenu.setState({ currentId: state.docId });
}

/**
 * Point the whole app at one sheet. Switching tabs never refetches and never
 * recomputes: the engine is already there, waiting, with its values intact.
 *
 * @param {string} sheetId
 * @param {{repaint?:boolean, announce?:boolean}} [options]
 */
function activateSheet(sheetId, options) {
  const opts = options || {};
  const sheet = sheetById(sheetId) || firstSheet();
  if (!sheet) return;
  const swap = sheet.id !== state.sheetId;
  // The painter is armed with ONE sheet's style and applies to a selection; carrying
  // it across a tab switch would repaint cells in a sheet the user never aimed at
  // (SPEC 23.1).
  if (swap) disarmPainter();
  // Every data panel is bound to one sheet's filter column, chart or comment thread
  // (SPEC 24), so none of them may outlive the tab they were opened on.
  if (swap) closeDataPanels();
  state.sheetId = sheet.id;

  const ctx = ctxOf(sheet.id);
  if (ctx) engine = ctx.engine;
  writeHash(state.docId, state.sheetId);

  if (grid && ctx) {
    try {
      if (swap) grid.setSheet(ctx.engine, sheet);
      else if (opts.repaint) grid.render();
    } catch (e) {
      console.error('[main] 그리드 갱신 실패', e);
    }
  }
  paintSheetBar();
  paintPeers();
  refreshToolbar();
  if (swap || opts.announce) sendCursor(true);
}

function setDocTitle(name) {
  const text = name || DEFAULT_DOC_NAME;
  document.title = text + ' — 시트지';
  if (!ui || !ui.docName) return;
  if (ui.docName.tagName === 'INPUT' || ui.docName.tagName === 'TEXTAREA') {
    if (document.activeElement !== ui.docName) ui.docName.value = text;
  } else {
    ui.docName.textContent = text;
  }
}

/** Document-level metadata: the name, and nothing that belongs to a sheet. */
function applyDocMeta(patch, options) {
  if (!patch || typeof patch !== 'object' || !state.doc) return;
  const opts = options || {};
  if (typeof patch.name === 'string') {
    state.doc.name = patch.name;
    setDocTitle(state.doc.name);
  }
  if (opts.send && net) {
    sendTracked({ t: 'docmeta', docId: state.docId, patch: { name: state.doc.name } });
  }
}

/**
 * Sheet-level metadata: column widths, row heights, freeze counts, merges.
 *
 * `merges` is the one member that REPLACES rather than merges (SPEC 21.3): it is
 * geometry, not a key/value map, and a key-by-key merge would make "unmerge"
 * inexpressible. It is re-normalized against this sheet's own rows/cols, so a list
 * from the wire can never install an overlapping or out-of-bounds rectangle here
 * even if the server ever stopped checking.
 *
 * @param {string} sheetId
 * @param {object} patch
 * @param {{send?:boolean, rerender?:boolean}} [options]
 */
function applySheetMeta(sheetId, patch, options) {
  if (!patch || typeof patch !== 'object') return;
  const opts = options || {};
  const sheet = sheetById(sheetId);
  if (!sheet) return;

  const wire = {};
  // SPEC 25.2 — the extent, FIRST: everything below is validated against the sheet's
  // rows/cols, so a frame that grows the sheet and installs a merge in the new area
  // has to grow before that merge is normalized or the merge would be dropped as
  // out of bounds. `rows` / `cols` are the ABSOLUTE new size, and this route can only
  // ever grow: growSheetTo() ignores a value at or below the current extent, so a
  // frame asking for fewer rows can never take one away.
  if (Number.isFinite(patch.rows) || Number.isFinite(patch.cols)) {
    // repaint: applySheetMeta's own re-render below covers the case it is asked for,
    // so the growth path only schedules one when nobody else will.
    if (growSheetTo(sheetId, patch, { repaint: !opts.rerender })) {
      // The whole extent goes on the wire, not just the axis that moved: it is one
      // geometry, the server clamps both into [current, MAX], and a peer that missed
      // an earlier frame is corrected by this one.
      wire.rows = sheet.rows;
      wire.cols = sheet.cols;
    }
  }
  if (patch.colWidths && typeof patch.colWidths === 'object') {
    sheet.colWidths = { ...(sheet.colWidths || {}), ...patch.colWidths };
    wire.colWidths = patch.colWidths;
  }
  if (patch.rowHeights && typeof patch.rowHeights === 'object') {
    sheet.rowHeights = { ...(sheet.rowHeights || {}), ...patch.rowHeights };
    wire.rowHeights = patch.rowHeights;
  }
  if (Number.isFinite(patch.frozenRows)) {
    sheet.frozenRows = Math.max(0, patch.frozenRows | 0);
    wire.frozenRows = sheet.frozenRows;
  }
  if (Number.isFinite(patch.frozenCols)) {
    sheet.frozenCols = Math.max(0, patch.frozenCols | 0);
    wire.frozenCols = sheet.frozenCols;
  }
  if (Array.isArray(patch.merges)) {
    sheet.merges = normalizeMergeList(patch.merges, sheet.rows, sheet.cols);
    wire.merges = sheet.merges.slice();
  }
  // SPEC 24.1 / 24.2 — the filter view and the chart list travel on this same frame,
  // and both REPLACE rather than merge, for the reason `merges` does: they are whole
  // objects, and a key-by-key merge would make "turn the filter off" inexpressible.
  // `filter: null` is a real value here, so membership is what decides, not truthiness.
  if ('filter' in patch) {
    sheet.filter = patch.filter == null
      ? null
      : sanitizeFilter(patch.filter, sheet.rows, sheet.cols);
    wire.filter = sheet.filter;
    invalidateFilterView(sheetId);
  }
  if (Array.isArray(patch.charts)) {
    sheet.charts = sanitizeChartList(patch.charts, sheet.rows, sheet.cols);
    wire.charts = sheet.charts.map((c) => ({ ...c }));
  }

  if (opts.send && Object.keys(wire).length) {
    sendTracked({ t: 'meta', docId: state.docId, sheetId, patch: wire });
  }
  if (opts.rerender && sheetId === state.sheetId && grid) {
    try { grid.render(); } catch (e) { console.error('[main] 그리드 갱신 실패', e); }
  }
}

/**
 * Structural edits are authoritative on the server, which answers with a full
 * document that adoptDoc() installs. The grid applies its own context-menu edits
 * locally first (and rewrites the sheet's cells wholesale), so that sheet's private
 * mirror has to be rebuilt and the undo stack dropped: every recorded inverse patch
 * refers to cell addresses that no longer mean the same thing.
 * While offline the frame waits in the outbox and is replayed after the next `welcome`,
 * so it survives not just the disconnection but the tab (SPEC 27.4).
 */
function sendStructural(edit) {
  if (!edit || typeof edit.kind !== 'string') return;
  const sheetId = state.sheetId;
  const payload = {
    kind: edit.kind,
    index: Math.max(0, Number(edit.index) || 0),
    count: Math.max(1, Number(edit.count) || 1),
  };
  const ctx = ctxOf(sheetId);
  if (ctx) ctx.shadow = buildShadow(ctx.sheet);
  history.clear();
  sendTracked({ t: 'struct', docId: state.docId, sheetId, edit: payload });
  if (state.status !== 'online') toast('오프라인 상태입니다. 연결되면 반영됩니다.');
}

// ---------------------------------------------------------- growing a sheet
//
// SPEC 25. A sheet starts at 200 x 26 and may grow to 5000 x 702. Three things ask
// for that — the two buttons under the grid (25.4) and the grid reaching its own
// edge (25.3) — and all three funnel through growSheetTo(), for the same reason
// every cell edit funnels through commitLocalEdit(): one path, one set of rules.
//
//   * growSheet() from shared/model.js does the arithmetic. It is pure, it clamps to
//     the maximum, it never shrinks, and it returns the SAME document when nothing
//     would change — which is exactly the "already at the limit" test.
//   * growth is strictly ADDITIVE: the extent is the only thing that changes. Cells,
//     merges, filters, charts and comments are carried across untouched, so growing
//     cannot corrupt a formula or move anything.
//   * it is NOT recorded on the undo stack. Growth is not an edit to the data, and an
//     undo that shrank a sheet could strand cells outside it — the one shape of
//     corruption this whole feature has to stay clear of.
//   * it travels on the ordinary `meta` frame carrying the absolute extent, which is
//     the same shape a peer's growth arrives in, so the incoming and the outgoing
//     paths are the one function.

/**
 * Adopt the document growSheet() returned.
 *
 * It replaced exactly one sheet — a copy carrying the new `rows`/`cols` — and shares
 * every other sheet by reference. The grid, the engine cache and every open panel
 * hold the LIVE sheet objects, so the two numbers are copied onto the live object
 * and the new document is re-pointed at the objects already on screen. Swapping the
 * object under the grid instead would cost a full rebind and the user's scroll
 * position, for a change of two integers.
 *
 * @param {object} next   the document growSheet() produced
 * @param {string} sheetId
 */
function adoptGrowth(next, sheetId) {
  const live = sheetById(sheetId);
  const grown = Array.isArray(next.sheets)
    ? next.sheets.find((s) => s && s.id === sheetId)
    : null;
  if (!live || !grown) return;

  const byId = new Map(sheetsOf().map((s) => [s.id, s]));   // before state.doc moves
  live.rows = grown.rows;
  live.cols = grown.cols;
  next.sheets = next.sheets.map((s) => (s && byId.get(s.id)) || s);
  state.doc = next;

  // The engine evaluates whole-column and whole-row ranges against its own extent
  // (`A:A` stops at the last row), so an engine that already exists for this sheet
  // has to learn the new size — and recompute, or COUNTBLANK(A:A) would keep
  // answering for the sheet's old height. Nothing is written: recalc reads inputs
  // and updates values, so this cannot change a single cell's contents.
  const ctx = sheetCtxs.get(sheetId);
  if (!ctx) return;
  ctx.sheet = live;
  try {
    ctx.engine.rows = live.rows;
    ctx.engine.cols = live.cols;
    ctx.engine.recalcAll();
  } catch (e) {
    console.error('[main] 시트를 넓힌 뒤 재계산하지 못했습니다', e);
  }
}

let growRepaintPending = false;

/**
 * Repaint after growth, on the NEXT frame rather than now: auto-grow fires from
 * inside the grid's own scroll and key handling, and re-entering render() from
 * there would repaint underneath the code that is still running. Coalesced, so a
 * frame that grows both axes costs one repaint.
 */
function repaintGrownSheet(sheetId) {
  if (sheetId !== state.sheetId || !grid || growRepaintPending) return;
  growRepaintPending = true;
  onNextFrame(() => {
    growRepaintPending = false;
    if (!grid) return;
    try { grid.render(); } catch (e) { console.error('[main] 그리드 갱신 실패', e); }
  });
}

/**
 * Grow one sheet to an extent. The ONE path a sheet ever grows through.
 *
 * @param {string} sheetId
 * @param {{rows?:number, cols?:number}} want  the ABSOLUTE new extent (SPEC 25.2);
 *   an axis that is absent, or at or below the current size, asks for nothing
 * @param {{repaint?:boolean}} [options]
 * @returns {boolean} true when the sheet actually grew
 */
function growSheetTo(sheetId, want, options) {
  const opts = options || {};
  const sheet = sheetById(sheetId);
  if (!sheet || !state.doc || !want || typeof want !== 'object') return false;

  // The wire carries the extent, not the number of rows to add, so the delta is
  // computed here — and a request at or below what the sheet already has yields a
  // delta of zero, which is how "shrink" is refused rather than applied.
  const addRows = Number.isFinite(want.rows) ? Math.floor(want.rows) - sheet.rows : 0;
  const addCols = Number.isFinite(want.cols) ? Math.floor(want.cols) - sheet.cols : 0;
  if (addRows <= 0 && addCols <= 0) return false;

  const next = growSheet(state.doc, sheetId, { rows: addRows, cols: addCols });
  if (next === state.doc) return false;      // already at MAX_ROWS / MAX_COLS
  adoptGrowth(next, sheetId);
  if (opts.repaint !== false) repaintGrownSheet(sheetId);
  // The extent readout and the grow control both describe a sheet that just changed
  // size; the toolbar repaint is what carries them (see paintToolbar).
  refreshToolbar();
  return true;
}

/**
 * 맨 아래에 행 [n] 개 추가 / 오른쪽에 열 [n] 개 추가 (SPEC 25.4).
 *
 * The count is whatever the control asked for, falling back to one step; growSheet()
 * clamps it to what remains, so asking for more than the sheet may have grows it to
 * exactly the maximum instead of failing.
 *
 * @param {'rows'|'cols'} axis
 * @param {number} rawCount
 */
function growActiveSheet(axis, rawCount) {
  const sheet = activeSheet();
  if (!sheet) return;
  const isCols = axis === 'cols';
  const unit = isCols ? '열' : '행';
  const asked = Number(rawCount);
  const count = Number.isFinite(asked) && asked > 0
    ? Math.floor(asked)
    : (isCols ? COL_GROW_STEP : ROW_GROW_STEP);

  const before = isCols ? sheet.cols : sheet.rows;
  applySheetMeta(sheet.id, isCols ? { cols: before + count } : { rows: before + count },
    { send: true });
  const after = isCols ? sheet.cols : sheet.rows;

  if (after === before) {
    // growSheet() handed back the same document: there was nothing left to add.
    toast('최대 크기입니다.');
    return;
  }
  toast(unit + ' ' + (after - before) + '개를 추가했습니다. 이제 ' + after + unit + '입니다.', 'ok');
}

// ------------------------------------------------------------ merged cells
//
// SPEC 21. A merge is presentation only: the anchor keeps its contents and every
// other covered cell is genuinely emptied, which is exactly why nothing under
// shared/formula/ knows merges exist. Both halves of that — the cleared cells and
// the geometry — are applied here, by ONE function, so the toolbar buttons and the
// grid's context menu can never drift apart.

/** A sheet's merge list, always an array. */
function mergesOf(sheet) {
  return sheet && Array.isArray(sheet.merges) ? sheet.merges : [];
}

/** Ordered, clamped rect for the active sheet. */
function orderRect(r1, c1, r2, c2) {
  const sheet = activeSheet();
  const maxRow = Math.max(0, ((sheet && sheet.rows) | 0) - 1);
  const maxCol = Math.max(0, ((sheet && sheet.cols) | 0) - 1);
  const clamp = (v, hi) => Math.max(0, Math.min(hi, Math.round(Number(v) || 0)));
  const a = clamp(Math.min(r1, r2), maxRow);
  const b = clamp(Math.max(r1, r2), maxRow);
  const c = clamp(Math.min(c1, c2), maxCol);
  const d = clamp(Math.max(c1, c2), maxCol);
  return { r1: a, c1: c, r2: b, c2: d };
}

/**
 * Whatever the caller had -> {r1,c1,r2,c2}. The grid may hand over a plain rect or a
 * range/selection; nothing at all means "the active selection".
 */
function toMergeRect(input) {
  const src = input && typeof input === 'object' ? input : null;
  if (src) {
    if (Number.isFinite(src.r1) && Number.isFinite(src.c1)
      && Number.isFinite(src.r2) && Number.isFinite(src.c2)) {
      return orderRect(src.r1, src.c1, src.r2, src.c2);
    }
    const r = (src.range && typeof src.range === 'object') ? src.range : src;
    if (r && r.s && r.e && Number.isFinite(r.s.row) && Number.isFinite(r.e.row)
      && Number.isFinite(r.s.col) && Number.isFinite(r.e.col)) {
      return orderRect(r.s.row, r.s.col, r.e.row, r.e.col);
    }
  }
  const b = bounds(selOf());
  return orderRect(b.r1, b.c1, b.r2, b.c2);
}

/** True when any merge in `list` overlaps `rect`. */
function rectHitsMerge(list, rect) {
  if (!list || !list.length) return false; // the common case costs nothing
  for (const key of list) {
    const r = mergeRect(key);
    if (!r) continue;
    if (r.r1 <= rect.r2 && r.r2 >= rect.r1 && r.c1 <= rect.c2 && r.c2 >= rect.c1) return true;
  }
  return false;
}

/** True when the selection overlaps at least one merge (the toolbar's `merged`). */
function selectionHasMerge(sel) {
  const list = mergesOf(activeSheet());
  if (!list.length) return false;
  const b = bounds(sel);
  return rectHitsMerge(list, { r1: b.r1, c1: b.c1, r2: b.r2, c2: b.c2 });
}

/** 'all' | 'horizontal' | 'vertical' | 'none', however the caller spelled it. */
function mergeMode(mode) {
  const m = String(mode == null ? '' : mode).toLowerCase();
  if (m === 'none' || m === 'unmerge' || m === 'off') return 'none';
  if (m === 'horizontal' || m === 'vertical') return m;
  return 'all';
}

/**
 * The single merge/unmerge path. Called by the four toolbar commands and by the
 * grid's onMerge(mode, rect).
 *
 * @param {string} rawMode  'all' | 'horizontal' | 'vertical' | 'none'
 * @param {object} [rectLike]  a rect, a range or a selection; omitted = the selection
 */
function runMerge(rawMode, rectLike) {
  if (!engine || !state.doc) return;
  const sheet = activeSheet();
  if (!sheet) return;
  const sheetId = sheet.id;
  const ctx = ctxOf(sheetId);
  if (!ctx) return;

  const mode = mergeMode(rawMode);
  const before = mergesOf(sheet).slice();
  // Every merge command works on WHOLE rectangles: a selection that clips a merge
  // grows until it contains it (SPEC 21.4), so geometry and contents cannot disagree.
  const rect = expandOverMerges(before, toMergeRect(rectLike));

  const plan = mode === 'none' ? planUnmerge(before, rect) : planMerge(before, rect, mode);
  const after = Array.isArray(plan.merges) ? plan.merges : before;
  const clearKeys = (mode === 'none' || !Array.isArray(plan.clear)) ? [] : plan.clear;

  // Only cells that actually hold something need emptying: a null for a cell that is
  // already blank is a no-op on every hop and would only bloat the frame.
  const cells = {};
  let clearCount = 0;
  for (const key of clearKeys) {
    if (!ctx.shadow.has(key)) continue;
    cells[key] = null;
    clearCount += 1;
  }

  const sameMerges = after.length === before.length && after.every((m, i) => m === before[i]);
  if (sameMerges && clearCount === 0) {
    // Nothing would change. Say WHY, because the three reasons need different fixes.
    if (mode === 'none') {
      toast('병합된 셀이 없습니다.');
    } else if (mode === 'horizontal' ? rect.c1 === rect.c2
      : mode === 'vertical' ? rect.r1 === rect.r2
        : (rect.r1 === rect.r2 && rect.c1 === rect.c2)) {
      toast('병합하려면 두 칸 이상 선택하세요.');
    } else if (rectHitsMerge(before, rect)) {
      toast('이미 병합된 셀입니다.');
    } else {
      toast('병합을 더 추가할 수 없습니다.', 'error');
    }
    return;
  }
  if (clearCount > MAX_EDIT_CELLS) {
    toast('한 번에 병합할 수 있는 칸은 ' + MAX_EDIT_CELLS + '개까지입니다.', 'error');
    return;
  }

  const label = mode === 'none' ? '병합 해제' : '셀 병합';
  const forward = clonePatch(cells);
  // The inverse MUST be taken before anything is applied: it is the only record of the
  // formulas and styles the merge is about to throw away.
  const backward = clearCount ? inverseOf(cells, ctx) : {};
  const beforeList = before.slice();
  const afterList = after.slice();

  /**
   * Put the sheet into one of the two states. Cells first, geometry second: the meta
   * step ends in a full re-render, so a cell repaint that could not reach its node
   * (because a merge was covering it) is corrected before this returns.
   */
  const applyBoth = (mergesList, cellPatch) => {
    if (!sheetById(sheetId)) {
      toast('삭제된 시트의 작업은 되돌릴 수 없습니다.', 'error');
      return;
    }
    activateSheet(sheetId);
    if (cellPatch && Object.keys(cellPatch).length) {
      commitLocalEdit(cellPatch, { record: false, label, sheetId });
    }
    applySheetMeta(sheetId, { merges: mergesList.slice() }, { send: true, rerender: true });
    refreshToolbar();
  };

  applyBoth(afterList, forward);

  // A clipped selection grew to whole rectangles above; move the on-screen selection
  // with it so what is highlighted is what was actually merged.
  const b = bounds(selOf());
  if (grid && (b.r1 !== rect.r1 || b.c1 !== rect.c1 || b.r2 !== rect.r2 || b.c2 !== rect.c2)) {
    try {
      grid.setSelection({
        active: cellToA1(rect.r1, rect.c1),
        range: { s: { row: rect.r1, col: rect.c1 }, e: { row: rect.r2, col: rect.c2 } },
      });
    } catch (e) { /* the grid keeps whatever it had */ }
  }

  // ONE history entry for both halves: Ctrl+Z has to restore the merge list AND the
  // cell contents the merge cleared, or half the document comes back.
  history.push({
    label,
    undo: () => applyBoth(beforeList, backward),
    redo: () => applyBoth(afterList, forward),
  });
}


// ------------------------------------------------------------------- tools
//
// SPEC 23. Five tools; four of them never touch a cell.
//
//   서식 복사   copies a STYLE and replays it onto the next selection
//   확대/축소   a per-viewer view preference, stored in localStorage
//   인쇄        builds a separate print document from the sheet's used range
//   링크        one more field on the cell record, on the ordinary cell patch
//   함수 도우미  writes a formula into a cell, like any other edit
//
// Not one of them invents a transport: everything that changes cell data still goes
// through commitLocalEdit(), so all five are undoable and replicated by code that was
// already here, and a document that uses none of them behaves exactly as before.

// ------------------------------------------------------- 서식 복사 (SPEC 23.1)

/**
 * The format painter's whole state.
 *   on      armed, waiting for a selection to paint
 *   sticky  a double click: stay armed after painting instead of disarming
 *   style   the SOURCE cell's style, copied at arm time — never its input, never its
 *           link, never merge geometry
 *   sheetId the sheet it was armed on; leaving that sheet gives it up
 */
const painter = { on: false, sticky: false, style: null, sheetId: '' };

/** The grid draws the painting cursor from a class it owns; it may predate setPainting. */
function setGridPainting(on) {
  if (!grid || typeof grid.setPainting !== 'function') return;
  try { grid.setPainting(!!on); }
  catch (e) { console.error('[main] 서식 복사 표시 실패', e); }
}

function armPainter(sticky) {
  const wasSticky = painter.on && painter.sticky;
  painter.on = true;
  painter.sticky = !!sticky;
  painter.style = { ...activeStyle() };
  painter.sheetId = state.sheetId;
  setGridPainting(true);
  refreshToolbar();
  // Only the sticky mode is announced: a plain arm is already visible as a pressed
  // button and a changed cursor, and a toast per click would be noise.
  if (sticky && !wasSticky) toast('서식 복사를 계속 적용합니다. Esc를 누르면 해제됩니다.');
}

function disarmPainter() {
  if (!painter.on) return;
  painter.on = false;
  painter.sticky = false;
  painter.style = null;
  painter.sheetId = '';
  setGridPainting(false);
  refreshToolbar();
}

/**
 * `painter:toggle`. The toolbar reports the double click in the payload rather than
 * as a second command, so the two modes share one entry point: a plain click toggles,
 * and a sticky click always arms (it is the SECOND click of a double click, and the
 * first one already armed).
 */
function togglePainter(payload) {
  const sticky = !!(payload && typeof payload === 'object' && payload.sticky);
  if (sticky) { armPainter(true); return; }
  if (painter.on) { disarmPainter(); return; }
  armPainter(false);
}

/**
 * Paint the current selection with the copied style, then disarm unless sticky.
 * Called whenever the selection changes while the painter is armed.
 *
 * A key the SOURCE does not carry is written as null on the target, which deletes it:
 * "copy this cell's format" has to mean the target ends up looking like the source,
 * not wearing a mixture of both. It is an ordinary style patch, so one Ctrl+Z undoes
 * it and every other viewer gets it through the usual edit frame.
 */
function applyPainterToSelection() {
  if (!painter.on || !engine) return;
  if (painter.sheetId && painter.sheetId !== state.sheetId) { disarmPainter(); return; }
  const src = painter.style || {};
  const keys = selectionKeys(selOf());
  if (!keys) {
    toast('선택 범위가 너무 넓습니다. ' + MAX_EDIT_CELLS + '칸 이하로 선택하세요.', 'error');
    disarmPainter();
    return;
  }
  const cells = {};
  let touched = 0;
  for (const key of keys) {
    let current = {};
    try { current = engine.getStyle(key) || {}; } catch (e) { current = {}; }
    const patch = { ...src };
    for (const k of Object.keys(current)) {
      if (!(k in patch)) patch[k] = null;      // clear what the source does not have
    }
    if (!Object.keys(patch).length) continue;  // both ends unstyled: nothing to do
    cells[key] = { style: patch };
    touched += 1;
  }
  if (touched) commitLocalEdit(cells, { label: '서식 복사' });
  if (!painter.sticky) disarmPainter();
}

// ------------------------------------------------------- 확대/축소 (SPEC 23.2)
//
// The grid owns the arithmetic — Grid.setZoom() multiplies every pixel it measures in
// one place — so this is only about remembering the number. It is never sent over the
// wire and never written to the document: the person beside you keeps their own zoom.

let zoomFactor = DEFAULT_ZOOM;

/**
 * Whatever the caller had -> a factor in 0.5 .. 2.
 * Both spellings are accepted: the toolbar command carries a PERCENTAGE (`zoom:150`)
 * while the grid's own API speaks factors (1.5), and localStorage may hold either if
 * it was written by an older build. Nothing but magnitude can tell them apart, and no
 * real zoom is 2% while no real factor is 50.
 */
function toZoomFactor(raw) {
  let n = typeof raw === 'number'
    ? raw
    : Number(String(raw == null ? '' : raw).trim().replace(/%$/, ''));
  if (!isFinite(n) || n <= 0) return DEFAULT_ZOOM;
  if (n > 5) n /= 100;
  return Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, n));
}

function applyZoomToGrid() {
  if (!grid || typeof grid.setZoom !== 'function') return;
  try { grid.setZoom(zoomFactor); }
  catch (e) { console.error('[main] 확대/축소를 적용하지 못했습니다', e); }
}

/** `zoom:<n>` from the toolbar. `persist` is false only for the boot-time restore. */
function applyZoom(raw, persist) {
  const next = toZoomFactor(raw);
  const changed = next !== zoomFactor;
  zoomFactor = next;
  applyZoomToGrid();
  if (persist !== false && changed) lsSet(ZOOM_KEY, String(zoomFactor));
  refreshToolbar();
}

// ------------------------------------------------------------ 인쇄 (SPEC 23.3)

/**
 * The grid renders only the cells in the viewport, so printing the live DOM would
 * print one screen of cells. print.js builds a self-contained document from the
 * sheet's used range and prints THAT, in a hidden same-origin iframe.
 */
function runPrint() {
  const sheet = activeSheet();
  if (!sheet || !engine) { toast('인쇄할 시트가 없습니다.', 'error'); return; }
  const fail = (e) => {
    console.error('[main] 인쇄에 실패했습니다', e);
    toast('인쇄에 실패했습니다.', 'error');
  };
  try {
    const done = printSheet(sheet, engine, {
      docName: (state.doc && state.doc.name) || DEFAULT_DOC_NAME,
      sheetName: sheet.name || DEFAULT_SHEET_NAME,
      orientation: 'portrait',
      gridlines: true,
    });
    // Building the document has to wait for the iframe to load, so printSheet may
    // hand back a promise; a rejection is reported exactly like a throw.
    if (done && typeof done.catch === 'function') done.catch(fail);
  } catch (e) {
    fail(e);
  }
}

// ------------------------------------------------------- 링크 삽입 (SPEC 23.4)

/** The active cell's link, or null. It lives in the mirror, not in the engine. */
function activeLink() {
  const ctx = activeCtx();
  if (!ctx) return null;
  const cell = ctx.shadow.get(selOf().active);
  return (cell && typeof cell.link === 'string' && cell.link) ? cell.link : null;
}

/**
 * `link:set` / `link:clear`. sanitizeLink() is the single gate — http, https and
 * mailto only — and running it here as well as on the server is what lets a rejected
 * URL be explained to the person who typed it instead of vanishing silently.
 */
function setActiveLink(raw) {
  if (!engine) return;
  const a1 = selOf().active;
  const current = activeLink();
  if (raw === null || raw === undefined || raw === '') {
    if (!current) { toast('이 셀에는 링크가 없습니다.'); return; }
    commitLocalEdit({ [a1]: { link: null } }, { label: '링크 제거' });
    toast('링크를 제거했습니다.');
    return;
  }
  const url = sanitizeLink(raw);
  if (!url) {
    toast('링크 주소를 사용할 수 없습니다. http, https, mailto 주소만 넣을 수 있습니다.', 'error');
    return;
  }
  if (url === current) return;
  commitLocalEdit({ [a1]: { link: url } }, { label: '링크 삽입' });
}

// ------------------------------------------------------ 함수 도우미 (SPEC 23.5)

/** The five shortcut commands the Σ button and its menu emit. */
const FX_NAMES = { sum: 'SUM', average: 'AVERAGE', count: 'COUNT', max: 'MAX', min: 'MIN' };

/** A function name safe to type into a cell (the list only ever offers engine names). */
const FX_NAME_RE = /^[A-Z][A-Z0-9_.]{0,30}$/;

function cellIsEmpty(a1) {
  let input = '';
  try { input = engine.getInput(a1) || ''; } catch (e) { input = ''; }
  return input === '';
}

function cellIsNumber(a1) {
  let v;
  try { v = engine.getValue(a1); } catch (e) { return false; }
  return typeof v === 'number' && isFinite(v);
}

/**
 * Where a Σ formula goes, and what it adds up.
 *
 * Direction is DOWN, except for a selection that is a single row of several columns,
 * which goes RIGHT — the rule a spreadsheet user already expects.
 *
 * The target is the first EMPTY cell in that direction. A single-cell selection starts
 * that search at the selected cell itself, because the ordinary gesture is "park the
 * cursor in the blank cell under a column of numbers and press Σ"; a MULTI-cell
 * selection starts strictly past itself, because its own range is the argument and a
 * formula inside its own range would be a circular reference.
 *
 * The argument is that selection when there is more than one cell, and otherwise the
 * contiguous run of numbers immediately above (or left of) the target. No run means no
 * guess — the caller opens an editor rather than writing =SUM() with nothing in it.
 *
 * @returns {{target:string, range:string}|null} null when there is no room at all
 */
function planFunctionInsert() {
  const sheet = activeSheet();
  if (!sheet || !engine) return null;
  const maxRow = Math.max(0, (sheet.rows | 0) - 1);
  const maxCol = Math.max(0, (sheet.cols | 0) - 1);
  const b = bounds(selOf());
  const multi = b.r1 !== b.r2 || b.c1 !== b.c2;
  const right = b.r1 === b.r2 && b.c1 !== b.c2;

  let row = b.r2;
  let col = b.c1;
  if (right) { row = b.r1; col = b.c2 + 1; }
  else if (multi) { row = b.r2 + 1; col = b.c1; }

  let target = '';
  while (row <= maxRow && col <= maxCol && row >= 0 && col >= 0) {
    const a1 = cellToA1(row, col);
    if (cellIsEmpty(a1)) { target = a1; break; }
    if (right) col += 1; else row += 1;
  }
  if (!target) return null;                 // the sheet runs out before a blank does

  if (multi) {
    return { target, range: cellToA1(b.r1, b.c1) + ':' + cellToA1(b.r2, b.c2) };
  }

  // The run of numbers that ends immediately before the target.
  let r = row;
  let c = col;
  let count = 0;
  if (right) {
    while (c - 1 >= 0 && cellIsNumber(cellToA1(r, c - 1))) { c -= 1; count += 1; }
  } else {
    while (r - 1 >= 0 && cellIsNumber(cellToA1(r - 1, c))) { r -= 1; count += 1; }
  }
  if (!count) return { target, range: '' };
  const first = cellToA1(r, c);
  const last = right ? cellToA1(row, col - 1) : cellToA1(row - 1, col);
  return { target, range: count === 1 ? first : first + ':' + last };
}

/** Move the selection onto one cell and tell everyone about it. */
function selectCell(a1) {
  if (!grid) return;
  let rc;
  try { rc = a1ToCell(a1); } catch (e) { return; }
  try {
    grid.setSelection({
      active: a1,
      range: { s: { row: rc.row, col: rc.col }, e: { row: rc.row, col: rc.col } },
    });
  } catch (e) { /* the grid keeps whatever it had */ }
  sendCursor(true);
  refreshToolbar();
}

/** Open the in-cell editor on `a1` with `text` already typed. */
function beginEditAt(a1, text) {
  if (!grid) return;
  try { grid.focusCell(a1); } catch (e) { /* focus is best effort */ }
  try { grid.beginEdit(text); }
  catch (e) { console.error('[main] 편집을 시작하지 못했습니다', e); }
}

/** `fx:sum` and friends — write the whole call, guessing the range. */
function insertFunction(kind) {
  const name = FX_NAMES[String(kind == null ? '' : kind).toLowerCase()];
  if (!name || !engine) return;
  const plan = planFunctionInsert();
  if (!plan) { toast('함수를 넣을 빈 칸을 찾지 못했습니다.', 'error'); return; }
  if (!plan.range) {
    // Nothing to guess: hand over an open editor with '=NAME(' typed, so the user can
    // point at a range instead of being given an =SUM() to repair.
    beginEditAt(plan.target, '=' + name + '(');
    return;
  }
  commitLocalEdit(
    { [plan.target]: { input: '=' + name + '(' + plan.range + ')' } },
    { label: '함수 삽입' },
  );
  selectCell(plan.target);
}

/** `fx:insert` — start an edit in the ACTIVE cell with '=NAME(' already typed. */
function beginFunctionEdit(rawName) {
  const name = String(rawName == null ? '' : rawName).trim().toUpperCase();
  if (!FX_NAME_RE.test(name)) return;       // never type an arbitrary string into a cell
  beginEditAt(selOf().active, '=' + name + '(');
}

// ------------------------------------------------------------ data features
//
// SPEC 24. Three features that work on a RANGE rather than on a cell, and one rule
// that ties them together: not one of them ever rewrites the document's rows.
//
//   정렬/필터  a VIEW. computeVisibleRows / computeSortOrder decide which rows the grid
//             paints and in what order; sheet.cells is untouched, so a sort can never
//             move a formula out from under a reference that points at it.
//   차트       a range plus geometry, drawn as inline SVG over the grid. It rides the
//             existing `meta` frame exactly the way the merge list does.
//   댓글       the one feature with a frame of its own, because the SERVER — never the
//             client — stamps the author and the time onto every message.
//
// Everything a user types here (a comment, a chart title, a filter value) reaches the
// DOM through textContent or an input's .value. Nothing below builds markup out of it,
// and nothing below trusts an `author` or an `at` that arrived from a client.
//
// Panel class names owned by the spec: .sz-filter-panel / .sz-filter-list,
// .sz-chart-panel, .sz-comment-panel / .sz-comment-thread / .sz-comment-msg.
// The .sz-panel-* names are layout-only helpers shared by all three.

// --- panel chrome -----------------------------------------------------------

/**
 * Minimal structural styling for the three panels, PREPENDED to <head> so
 * public/css/style.css — linked later in the document — always overrides it. It is the
 * same arrangement toolbar.js uses for its own controls: the panels stay usable in a
 * host page whose stylesheet has not loaded, and add nothing to the cascade when it has.
 */
const PANEL_CSS = [
  '.sz-filter-panel,.sz-chart-panel,.sz-comment-panel{position:fixed;z-index:2147483000;',
  'box-sizing:border-box;display:flex;flex-direction:column;border:1px solid rgba(0,0,0,.18);',
  'border-radius:10px;background:#fff;color:#202124;box-shadow:0 8px 28px rgba(0,0,0,.24);',
  "font-size:13px;font-family:'Pretendard','Apple SD Gothic Neo','Malgun Gothic',",
  "'Segoe UI',system-ui,sans-serif}",
  '.sz-filter-panel[hidden],.sz-chart-panel[hidden],.sz-comment-panel[hidden]{display:none}',
  '.sz-filter-panel{width:274px;max-height:72vh}',
  '.sz-chart-panel,.sz-comment-panel{top:96px;right:16px;bottom:56px;width:324px;max-width:92vw}',
  '.sz-panel-head{display:flex;align-items:center;gap:8px;padding:9px 11px;',
  'border-bottom:1px solid rgba(0,0,0,.12);font-weight:600}',
  '.sz-panel-title{flex:1 1 auto;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
  '.sz-panel-body{flex:1 1 auto;min-height:0;overflow-y:auto;padding:9px 11px}',
  '.sz-panel-foot{display:flex;justify-content:flex-end;gap:6px;padding:8px 10px;',
  'border-top:1px solid rgba(0,0,0,.12)}',
  '.sz-panel-btn{min-height:28px;padding:4px 10px;border:1px solid rgba(0,0,0,.22);',
  'border-radius:6px;background:#fff;color:inherit;cursor:pointer;font:inherit;white-space:nowrap}',
  '.sz-panel-btn:hover{background:rgba(60,64,67,.10)}',
  '.sz-panel-btn-primary{border-color:#1a73e8;background:#1a73e8;color:#fff}',
  '.sz-panel-btn-danger{color:#c5221f}',
  '.sz-panel-close{min-width:26px;padding:2px 7px}',
  '.sz-panel-row{display:flex;align-items:center;gap:6px;margin:0 0 9px}',
  '.sz-panel-row-wrap{flex-wrap:wrap}',
  '.sz-panel-field{width:100%;box-sizing:border-box;min-height:28px;padding:5px 8px;',
  'border:1px solid rgba(0,0,0,.28);border-radius:5px;background:#fff;color:inherit;font:inherit}',
  '.sz-panel-label{display:block;margin:0 0 3px;font-size:11px;opacity:.72}',
  '.sz-panel-check{display:flex;align-items:center;gap:7px;margin:0 0 8px;cursor:pointer}',
  '.sz-panel-empty{padding:10px 2px;font-size:12px;opacity:.7}',
  '.sz-filter-list{flex:1 1 auto;min-height:96px;max-height:220px;overflow-y:auto;',
  'margin:7px 0;padding:2px;border:1px solid rgba(0,0,0,.14);border-radius:6px}',
  '.sz-filter-opt{display:flex;align-items:center;gap:7px;padding:3px 6px;border-radius:4px;',
  'cursor:pointer}',
  '.sz-filter-opt:hover{background:rgba(60,64,67,.08)}',
  '.sz-filter-opt-text{flex:1 1 auto;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
  '.sz-filter-opt-count{flex:0 0 auto;font-size:11px;opacity:.6}',
  '.sz-comment-thread{margin:0 0 12px;padding:9px;border:1px solid rgba(0,0,0,.14);',
  'border-radius:8px}',
  '.sz-comment-thread-active{border-color:#1a73e8;box-shadow:0 0 0 1px rgba(26,115,232,.35)}',
  '.sz-comment-thread-resolved{opacity:.62}',
  '.sz-comment-msg{margin:0 0 9px}',
  '.sz-comment-meta{display:flex;gap:7px;font-size:11px;opacity:.66}',
  '.sz-comment-author{font-weight:600;opacity:.85}',
  '.sz-comment-text{margin-top:2px;white-space:pre-wrap;overflow-wrap:anywhere}',
  '.sz-comment-box{width:100%;box-sizing:border-box;min-height:56px;resize:vertical;',
  'padding:6px 8px;border:1px solid rgba(0,0,0,.28);border-radius:5px;background:#fff;',
  'color:inherit;font:inherit}',
  '@media (prefers-color-scheme:dark){',
  '.sz-filter-panel,.sz-chart-panel,.sz-comment-panel{background:#2a2c2f;color:#e8eaed;',
  'border-color:rgba(255,255,255,.16)}',
  '.sz-panel-btn,.sz-panel-field,.sz-comment-box{background:#202124;color:#e8eaed;',
  'border-color:rgba(255,255,255,.28)}',
  '.sz-panel-btn-primary{background:#1a73e8;border-color:#1a73e8;color:#fff}',
  '.sz-panel-btn-danger{color:#f28b82}',
  '.sz-panel-btn:hover{background:rgba(255,255,255,.10)}',
  '.sz-filter-opt:hover{background:rgba(255,255,255,.08)}}',
].join('');

let panelCssInjected = false;

function injectPanelCss() {
  if (panelCssInjected || !document.head) return;
  panelCssInjected = true;
  const node = document.createElement('style');
  node.id = 'sz-panel-fallback';
  node.textContent = PANEL_CSS;
  document.head.prepend(node);              // first in <head> => style.css still wins
}

/**
 * The shell every data panel shares: a titled head with a close button, a scrolling
 * body, and an optional footer. Escape closes it, and every key event is stopped at the
 * panel root so typing a comment can never reach the grid's or the document's shortcuts.
 */
function buildPanel(className, titleText, onClose) {
  injectPanelCss();
  const root = el('div', className);
  root.hidden = true;
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-label', titleText);

  const head = el('div', 'sz-panel-head');
  const title = el('div', 'sz-panel-title', titleText);
  const close = el('button', 'sz-panel-btn sz-panel-close', '✕');
  close.type = 'button';
  close.title = '닫기';
  close.setAttribute('aria-label', '닫기');
  close.addEventListener('click', () => onClose());
  head.appendChild(title);
  head.appendChild(close);

  const body = el('div', 'sz-panel-body');
  const foot = el('div', 'sz-panel-foot');

  root.addEventListener('keydown', (ev) => {
    ev.stopPropagation();
    if (ev.key === 'Escape' || ev.key === 'Esc') {
      ev.preventDefault();
      onClose();
    }
  });

  root.appendChild(head);
  root.appendChild(body);
  root.appendChild(foot);
  document.body.appendChild(root);
  return { root, head, title, body, foot };
}

/** A panel button. `variant` adds sz-panel-btn-primary / -danger. */
function panelButton(label, variant, onClick) {
  const b = el('button', 'sz-panel-btn' + (variant ? ' sz-panel-btn-' + variant : ''), label);
  b.type = 'button';
  b.addEventListener('click', onClick);
  return b;
}

/**
 * Place a popover under its anchor, kept inside the viewport.
 *
 * `anchor` may be an element or a plain rectangle: the grid's batch-C callbacks hand
 * over a copied {left,top,right,bottom,width,height} rather than a live DOMRect, which
 * would be read-only and would go stale the moment the grid repainted.
 */
function placeNear(root, anchor) {
  root.style.left = '0px';
  root.style.top = '0px';
  let r = null;
  try {
    if (anchor && typeof anchor.getBoundingClientRect === 'function') {
      r = anchor.getBoundingClientRect();
    } else if (anchor && typeof anchor === 'object' && isFinite(Number(anchor.left))) {
      r = anchor;
    }
  } catch (e) { r = null; }
  const w = root.offsetWidth || 274;
  const h = root.offsetHeight || 320;
  if (!r) {
    root.style.left = Math.max(4, Math.round((window.innerWidth - w) / 2)) + 'px';
    root.style.top = '96px';
    return;
  }
  const left = Math.min(Math.max(4, Number(r.left) || 0),
    Math.max(4, window.innerWidth - w - 6));
  let top = (Number(r.bottom) || 0) + 4;
  if (top + h > window.innerHeight - 6) top = Math.max(4, (Number(r.top) || 0) - h - 4);
  root.style.left = Math.round(left) + 'px';
  root.style.top = Math.round(top) + 'px';
}

/** Empty a node without touching innerHTML. */
function clearNode(node) {
  if (node) node.textContent = '';
}

// --- range / value helpers --------------------------------------------------

function filterOf(sheet) {
  return (sheet && sheet.filter && typeof sheet.filter === 'object') ? sheet.filter : null;
}

function chartsOf(sheet) {
  return (sheet && Array.isArray(sheet.charts)) ? sheet.charts : [];
}

function commentsOf(sheet) {
  return (sheet && sheet.comments && typeof sheet.comments === 'object') ? sheet.comments : {};
}

function threadAt(sheet, a1) {
  if (!a1) return null;
  const map = commentsOf(sheet);
  const hit = map[String(a1).toUpperCase()];
  return (hit && typeof hit === 'object') ? hit : null;
}

/** {r1,c1,r2,c2} -> 'A1:C10'. */
function rectToRange(rect) {
  return cellToA1(rect.r1, rect.c1) + ':' + cellToA1(rect.r2, rect.c2);
}

/** A reader the pure model helpers can use: computed values, never raw inputs. */
function valueReaderFor(ctx) {
  const eng = ctx && ctx.engine;
  if (!eng) return () => null;
  return (row, col) => {
    try { return eng.getValue(cellToA1(row, col)); } catch (e) { return null; }
  };
}

function readValue(ctx, row, col) {
  try { return ctx.engine.getValue(cellToA1(row, col)); } catch (e) { return null; }
}

/** True when the cell holds an input of its own (the mirror, not the engine). */
function cellHasText(ctx, row, col) {
  const entry = ctx.shadow.get(cellToA1(row, col));
  return !!(entry && entry.input !== undefined && entry.input !== '');
}

function bandHasData(ctx, fixed, from, to, isRow) {
  for (let i = from; i <= to; i++) {
    if (isRow ? cellHasText(ctx, fixed, i) : cellHasText(ctx, i, fixed)) return true;
  }
  return false;
}

/**
 * The contiguous block of data around one cell — what "make a filter here" means when
 * the user has selected a single cell rather than a range, exactly as in Sheets. It
 * grows one row or column at a time and stops at the first empty edge, so it can never
 * swallow an unrelated table further down the sheet.
 */
function usedBlockAround(ctx, sheet, row, col) {
  const maxRow = Math.min(sheet.rows || DEFAULT_ROWS, BLOCK_MAX_ROWS) - 1;
  const maxCol = Math.min(sheet.cols || DEFAULT_COLS, BLOCK_MAX_COLS) - 1;
  const rect = { r1: row, c1: col, r2: row, c2: col };
  for (let guard = 0; guard < BLOCK_MAX_ROWS; guard++) {
    let grew = false;
    if (rect.r1 > 0 && bandHasData(ctx, rect.r1 - 1, rect.c1, rect.c2, true)) { rect.r1--; grew = true; }
    if (rect.r2 < maxRow && bandHasData(ctx, rect.r2 + 1, rect.c1, rect.c2, true)) { rect.r2++; grew = true; }
    if (rect.c1 > 0 && bandHasData(ctx, rect.c1 - 1, rect.r1, rect.r2, false)) { rect.c1--; grew = true; }
    if (rect.c2 < maxCol && bandHasData(ctx, rect.c2 + 1, rect.r1, rect.r2, false)) { rect.c2++; grew = true; }
    if (!grew) break;
  }
  return rect;
}

/**
 * The rectangle a data command works on: the selection when it spans more than one
 * cell, otherwise the block of data around the cursor.
 */
function dataRectFromSelection() {
  const sheet = activeSheet();
  const ctx = activeCtx();
  if (!sheet || !ctx) return null;
  const b = bounds(selOf());
  let rect = { r1: b.r1, c1: b.c1, r2: b.r2, c2: b.c2 };
  if (rect.r1 === rect.r2 && rect.c1 === rect.c2) rect = usedBlockAround(ctx, sheet, rect.r1, rect.c1);
  rect.r1 = Math.max(0, rect.r1);
  rect.c1 = Math.max(0, rect.c1);
  rect.r2 = Math.min(rect.r2, (sheet.rows || DEFAULT_ROWS) - 1);
  rect.c2 = Math.min(rect.c2, (sheet.cols || DEFAULT_COLS) - 1);
  if (rect.r2 < rect.r1 || rect.c2 < rect.c1) return null;
  return rect;
}

/** Sheet-space x of a column's left edge, in unzoomed document pixels. */
function sheetXOf(sheet, col) {
  const widths = (sheet && sheet.colWidths) || {};
  let x = 0;
  for (let c = 0; c < col; c++) {
    const w = Number(widths[String(c)]);
    x += (isFinite(w) && w > 0) ? w : DEFAULT_COL_WIDTH;
  }
  return x;
}

/** Sheet-space y of a row's top edge, in unzoomed document pixels. */
function sheetYOf(sheet, row) {
  const heights = (sheet && sheet.rowHeights) || {};
  let y = 0;
  for (let r = 0; r < row; r++) {
    const h = Number(heights[String(r)]);
    y += (isFinite(h) && h > 0) ? h : DEFAULT_ROW_HEIGHT;
  }
  return y;
}

/** A short id in the shape shared/model.js mints and validates ('ch…' / 'cm…'). */
function mintId(prefix) {
  return prefix + newId(Date.now() + Math.floor(Math.random() * 100000)).slice(0, 6);
}

// --- 정렬 / 필터 (SPEC 24.1) --------------------------------------------------
//
// The filter is sheet state that travels on the `meta` frame, so turning one on is one
// frame and no new transport. What it costs locally is one O(rows) pass to answer
// "N개 중 M개 표시", and that answer is CACHED per sheet: the status bar repaints on
// every cursor move, and a filter over a few thousand rows must not be re-evaluated
// each time the user presses an arrow key.

/** @type {Map<string, {total:number, visible:number}>} sheetId -> row counts */
const filterViewCache = new Map();

function invalidateFilterView(sheetId) {
  if (sheetId) filterViewCache.delete(sheetId);
  else filterViewCache.clear();
}

/** { total, visible } over the active sheet's filter range, or null with no filter. */
function filterCounts() {
  const sheet = activeSheet();
  const filter = filterOf(sheet);
  if (!sheet || !filter) return null;
  const cached = filterViewCache.get(sheet.id);
  if (cached) return cached;

  const rect = mergeRect(filter.range);
  if (!rect) return null;
  const rows = sheet.rows || DEFAULT_ROWS;
  const first = rect.r1 + (filter.header ? 1 : 0);
  const last = Math.min(rect.r2, rows - 1);
  const total = Math.max(0, last - first + 1);
  let visible = total;
  const ctx = ctxOf(sheet.id);
  if (total > 0 && ctx) {
    let survivors = null;
    try {
      survivors = computeVisibleRows(sheet.cells, filter, valueReaderFor(ctx), rows);
    } catch (e) {
      console.error('[main] 필터 결과를 계산하지 못했습니다', e);
      survivors = null;
    }
    if (survivors) {
      visible = 0;
      for (let row = first; row <= last; row++) if (survivors.has(row)) visible += 1;
    }
  }
  const counts = { total, visible };
  filterViewCache.set(sheet.id, counts);
  return counts;
}

/** Install a filter locally and put it on the wire (SPEC 24.1 — the `meta` frame). */
function writeFilter(filter) {
  const sheet = activeSheet();
  if (!sheet) return;
  applySheetMeta(sheet.id, { filter }, { send: true, rerender: true });
  refreshToolbar();
}

/** `filter:on` — build a filter over the selection and apply it here and now. */
function turnFilterOn() {
  const sheet = activeSheet();
  if (!sheet) return;
  const rect = dataRectFromSelection();
  if (!rect) { toast('필터를 만들 범위를 선택하세요.', 'error'); return; }
  if (rect.r2 === rect.r1) {
    toast('머리글 행과 데이터 행이 함께 있어야 필터를 만들 수 있습니다.', 'error');
    return;
  }
  const filter = sanitizeFilter(
    { range: rectToRange(rect), header: true, sort: null, hidden: {} },
    sheet.rows, sheet.cols,
  );
  if (!filter) { toast('필터를 만들 수 없는 범위입니다.', 'error'); return; }
  writeFilter(filter);
  toast('필터를 만들었습니다. 머리글의 필터 단추로 정렬하거나 값을 걸러낼 수 있습니다.');
}

/** `filter:off` — drop the sheet's filter view. No row was ever moved, so nothing to undo. */
function turnFilterOff() {
  const sheet = activeSheet();
  if (!sheet || !filterOf(sheet)) { toast('적용된 필터가 없습니다.'); return; }
  closeFilterPanel();
  writeFilter(null);
  toast('필터를 껐습니다.');
}

/** The panel's own state. `col` is RELATIVE to the filter range, like filter.hidden. */
const filterPanel = {
  root: null, body: null, title: null, foot: null,
  sheetId: '', col: -1, rows: [], search: null, listEl: null, open: false,
};

/**
 * Which column the grid asked about, as an index RELATIVE to the filter range — the
 * spelling `filter.sort.col` and the keys of `filter.hidden` use.
 *
 * `grid.onFilterMenu(col, rect)` passes the ABSOLUTE column and a rectangle that also
 * carries `col` and `relCol`, so the relative index is normally read straight off it.
 * The other spellings are read too, and a bare number is taken as ABSOLUTE, because
 * that is the coordinate system the grid speaks everywhere else.
 */
function filterColumnFrom(info, anchor, filter) {
  const rect = mergeRect(filter.range);
  if (!rect) return -1;
  const width = rect.c2 - rect.c1 + 1;
  const num = (v) => {
    if (typeof v === 'number' && isFinite(v)) return Math.round(v);
    if (typeof v === 'string' && v.trim() !== '' && isFinite(Number(v))) return Math.round(Number(v));
    return null;
  };
  const sources = [];
  if (info && typeof info === 'object') sources.push(info);
  if (anchor && typeof anchor === 'object') sources.push(anchor);

  let rel = -1;
  for (const src of sources) {
    for (const key of ['relCol', 'rel']) {
      const n = num(src[key]);
      if (n !== null) { rel = n; break; }
    }
    if (rel >= 0) break;
  }
  if (rel < 0) {
    for (const src of sources) {
      for (const key of ['absCol', 'col', 'column']) {
        const n = num(src[key]);
        if (n !== null) { rel = n - rect.c1; break; }
      }
      if (rel >= 0) break;
    }
  }
  if (rel < 0) {
    const n = num(info);
    if (n !== null) rel = n - rect.c1;
  }
  if (rel < 0 && anchor && anchor.dataset) {
    const n = num(anchor.dataset.col);
    if (n !== null) rel = n - rect.c1;
  }
  return (rel >= 0 && rel < width) ? rel : -1;
}

/** The header text of one filter column, or 'C열' when the range has no header row. */
function filterColumnLabel(sheet, filter, rel) {
  const rect = mergeRect(filter.range);
  if (!rect) return '';
  const abs = rect.c1 + rel;
  if (filter.header) {
    const ctx = ctxOf(sheet.id);
    if (ctx) {
      let text = '';
      try {
        const a1 = cellToA1(rect.r1, abs);
        text = formatValue(ctx.engine.getValue(a1), ctx.engine.getStyle(a1) || {});
      } catch (e) { text = ''; }
      if (text) return String(text);
    }
  }
  return colToLetter(abs) + '열';
}

function ensureFilterPanel() {
  if (filterPanel.root) return filterPanel;
  const shell = buildPanel('sz-filter-panel', '필터', () => closeFilterPanel());
  filterPanel.root = shell.root;
  filterPanel.body = shell.body;
  filterPanel.title = shell.title;
  filterPanel.foot = shell.foot;
  return filterPanel;
}

/** `grid.onFilterMenu` and nothing else opens this. */
function openFilterPanel(info, anchor) {
  const sheet = activeSheet();
  const filter = filterOf(sheet);
  if (!sheet || !filter) return;
  const rel = filterColumnFrom(info, anchor, filter);
  if (rel < 0) { toast('필터를 열 열을 찾지 못했습니다.', 'error'); return; }

  const panel = ensureFilterPanel();
  panel.sheetId = sheet.id;
  panel.col = rel;
  renderFilterPanel();
  panel.root.hidden = false;
  panel.open = true;
  placeNear(panel.root, anchor);
  bindFilterOutside();
  if (panel.search) {
    try { panel.search.focus(); } catch (e) { /* focus is a nicety */ }
  }
}

function closeFilterPanel() {
  if (!filterPanel.root || !filterPanel.open) return;
  filterPanel.open = false;
  filterPanel.root.hidden = true;
  filterPanel.rows = [];
  filterPanel.col = -1;
  filterPanel.sheetId = '';
  unbindFilterOutside();
}

let filterOutsideHandler = null;

function bindFilterOutside() {
  if (filterOutsideHandler) return;
  filterOutsideHandler = (ev) => {
    if (!filterPanel.open || !filterPanel.root) return;
    const target = ev.target;
    if (filterPanel.root.contains(target)) return;
    // A press on a filter glyph belongs to the grid, which reopens the panel on the
    // column that was clicked; closing it here first would only make it flicker.
    if (target && target.closest && target.closest('.sz-filter-btn')) return;
    closeFilterPanel();
  };
  document.addEventListener('mousedown', filterOutsideHandler, true);
}

function unbindFilterOutside() {
  if (!filterOutsideHandler) return;
  document.removeEventListener('mousedown', filterOutsideHandler, true);
  filterOutsideHandler = null;
}

function renderFilterPanel() {
  const sheet = activeSheet();
  const filter = filterOf(sheet);
  const panel = filterPanel;
  if (!panel.root) return;
  if (!sheet || !filter || panel.col < 0) { closeFilterPanel(); return; }

  const rel = panel.col;
  const label = filterColumnLabel(sheet, filter, rel);
  panel.title.textContent = label ? ('필터 · ' + label) : '필터';
  panel.root.setAttribute('aria-label', panel.title.textContent);
  clearNode(panel.body);
  clearNode(panel.foot);
  panel.rows = [];

  // 정렬. Applying immediately and closing matches every spreadsheet: a sort is a
  // one-shot choice, not something you tick alongside the value list.
  const sortRow = el('div', 'sz-panel-row sz-panel-row-wrap');
  sortRow.appendChild(panelButton('오름차순 정렬', '', () => sortFilterColumn(rel, 'asc')));
  sortRow.appendChild(panelButton('내림차순 정렬', '', () => sortFilterColumn(rel, 'desc')));
  panel.body.appendChild(sortRow);

  const search = el('input', 'sz-panel-field');
  search.type = 'search';
  search.placeholder = '값 검색';
  search.setAttribute('aria-label', '값 검색');
  search.autocomplete = 'off';
  search.spellcheck = false;
  search.addEventListener('input', () => filterPanelSearch());
  panel.search = search;
  panel.body.appendChild(search);

  const pickRow = el('div', 'sz-panel-row sz-panel-row-wrap');
  pickRow.appendChild(panelButton('전체 선택', '', () => setFilterChecks(true)));
  pickRow.appendChild(panelButton('선택 해제', '', () => setFilterChecks(false)));
  panel.body.appendChild(pickRow);

  const list = el('div', 'sz-filter-list');
  list.setAttribute('role', 'group');
  list.setAttribute('aria-label', '표시할 값');
  panel.listEl = list;

  const ctx = ctxOf(sheet.id);
  let data = { values: [], counts: new Map() };
  try {
    data = filterColumnValues(sheet.cells, filter.range, rel, filter.header, valueReaderFor(ctx));
  } catch (e) {
    console.error('[main] 필터 값을 읽지 못했습니다', e);
  }
  const hiddenList = (filter.hidden && filter.hidden[String(rel)]) || [];
  const hidden = new Set(Array.isArray(hiddenList) ? hiddenList : []);

  for (const value of data.values) {
    const row = el('label', 'sz-filter-opt');
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = !hidden.has(value);
    const text = el('span', 'sz-filter-opt-text', value === '' ? BLANK_LABEL : value);
    text.title = value === '' ? BLANK_LABEL : value;
    const count = data.counts.get(value);
    row.appendChild(input);
    row.appendChild(text);
    if (Number.isFinite(count)) row.appendChild(el('span', 'sz-filter-opt-count', String(count)));
    list.appendChild(row);
    panel.rows.push({ value, input, node: row, search: String(value).toLowerCase() });
  }
  if (!data.values.length) {
    list.appendChild(el('div', 'sz-panel-empty', '이 열에는 값이 없습니다.'));
  }
  panel.body.appendChild(list);

  panel.foot.appendChild(panelButton('취소', '', () => closeFilterPanel()));
  panel.foot.appendChild(panelButton('확인', 'primary', () => applyFilterPanel()));
}

function filterPanelSearch() {
  const q = filterPanel.search ? String(filterPanel.search.value || '').trim().toLowerCase() : '';
  for (const row of filterPanel.rows) {
    row.node.hidden = !!q && row.search.indexOf(q) < 0;
  }
}

/** 전체 선택 / 선택 해제 — over what the search is currently showing, as in Sheets. */
function setFilterChecks(on) {
  for (const row of filterPanel.rows) {
    if (row.node.hidden) continue;
    row.input.checked = !!on;
  }
}

function sortFilterColumn(rel, dir) {
  const sheet = activeSheet();
  const filter = filterOf(sheet);
  if (!sheet || !filter || rel < 0) return;
  const next = sanitizeFilter(
    { range: filter.range, header: filter.header, sort: { col: rel, dir }, hidden: filter.hidden },
    sheet.rows, sheet.cols,
  );
  closeFilterPanel();
  if (!next) return;
  writeFilter(next);
  toast(dir === 'asc' ? '오름차순으로 정렬했습니다.' : '내림차순으로 정렬했습니다.');
}

/** 확인 — the UNCHECKED values become that column's hidden list. */
function applyFilterPanel() {
  const sheet = activeSheet();
  const filter = filterOf(sheet);
  const rel = filterPanel.col;
  if (!sheet || !filter || rel < 0) { closeFilterPanel(); return; }
  const off = [];
  for (const row of filterPanel.rows) if (!row.input.checked) off.push(row.value);
  const hidden = {};
  for (const key of Object.keys(filter.hidden || {})) {
    if (key !== String(rel)) hidden[key] = (filter.hidden[key] || []).slice();
  }
  if (off.length) hidden[String(rel)] = off;
  const next = sanitizeFilter(
    { range: filter.range, header: filter.header, sort: filter.sort, hidden },
    sheet.rows, sheet.cols,
  );
  closeFilterPanel();
  if (!next) return;
  writeFilter(next);
}

// --- 차트 (SPEC 24.2) ---------------------------------------------------------
//
// A chart is pure sheet state — a range, a type and a rectangle — so it rides the
// `meta` frame the merge list already uses. The DRAWING belongs to chart.js and the
// grid's overlay layer; everything here is about choosing what to draw and remembering
// where it sits.

/** The chart list is replaced wholesale, like the merge list (SPEC 24.2). */
function writeCharts(list, options) {
  const opts = options || {};
  const sheet = activeSheet();
  if (!sheet) return;
  applySheetMeta(sheet.id, { charts: list }, { send: true, rerender: opts.rerender !== false });
  refreshToolbar();
}

function chartById(sheet, id) {
  if (!id) return null;
  for (const c of chartsOf(sheet)) if (c && c.id === id) return c;
  return null;
}

/** A cheap look at a rectangle's first row / column to guess the header toggles. */
function looksLikeHeader(ctx, rect, isRow) {
  const scanRows = Math.min(rect.r2, rect.r1 + 40);
  const scanCols = Math.min(rect.c2, rect.c1 + 40);
  if (isRow ? rect.r2 <= rect.r1 : rect.c2 <= rect.c1) return false;

  let filled = 0;
  let text = 0;
  if (isRow) {
    for (let c = rect.c1; c <= scanCols; c++) {
      const v = readValue(ctx, rect.r1, c);
      if (v === null || v === '') continue;
      filled += 1;
      if (typeof v === 'string') text += 1;
    }
  } else {
    for (let r = rect.r1; r <= scanRows; r++) {
      const v = readValue(ctx, r, rect.c1);
      if (v === null || v === '') continue;
      filled += 1;
      if (typeof v === 'string') text += 1;
    }
  }
  if (!filled || text < filled) return false;

  // A band of text is only a header when there are numbers behind it to plot.
  const r0 = isRow ? rect.r1 + 1 : rect.r1;
  const c0 = isRow ? rect.c1 : rect.c1 + 1;
  for (let r = r0; r <= scanRows; r++) {
    for (let c = c0; c <= scanCols; c++) {
      if (typeof readValue(ctx, r, c) === 'number') return true;
    }
  }
  return false;
}

/** `chart:add` — one chart from the selection, with defaults worth keeping. */
function addChartFromSelection() {
  const sheet = activeSheet();
  const ctx = activeCtx();
  if (!sheet || !ctx) return;
  const list = chartsOf(sheet);
  if (list.length >= MAX_CHARTS) {
    toast('차트는 시트당 ' + MAX_CHARTS + '개까지 넣을 수 있습니다.', 'error');
    return;
  }
  const rect = dataRectFromSelection();
  if (!rect) { toast('차트로 만들 범위를 선택하세요.', 'error'); return; }

  // It lands just to the right of its own data, at that data's top edge, so a fresh
  // chart never covers the numbers it was made from.
  const chart = sanitizeChart({
    id: mintId('ch'),
    type: 'column',
    range: rectToRange(rect),
    title: '',
    headerRow: looksLikeHeader(ctx, rect, true),
    headerCol: looksLikeHeader(ctx, rect, false),
    x: sheetXOf(sheet, Math.min(rect.c2 + 1, (sheet.cols || DEFAULT_COLS) - 1)) + 12,
    y: sheetYOf(sheet, rect.r1),
    w: CHART_DEFAULT_W,
    h: CHART_DEFAULT_H,
    legend: 'right',
  }, sheet.rows, sheet.cols);
  if (!chart) { toast('차트를 만들 수 없는 범위입니다.', 'error'); return; }

  writeCharts(list.concat([chart]));
  openChartPanel(chart.id);
  toast('차트를 넣었습니다.');
}

/**
 * Merge a patch into one chart and write the list back.
 * Everything goes through sanitizeChart, so a hand-typed range or a dragged rectangle
 * is clamped here, once, exactly the way the server will clamp it.
 */
function updateChart(id, patch, options) {
  const opts = options || {};
  const sheet = activeSheet();
  if (!sheet || !id || !patch) return null;
  const list = chartsOf(sheet);
  let updated = null;
  const next = list.map((c) => {
    if (!c || c.id !== id) return c;
    const merged = sanitizeChart({ ...c, ...patch, id: c.id }, sheet.rows, sheet.cols);
    updated = merged || c;
    return updated;
  });
  if (!updated) return null;
  writeCharts(next, { rerender: opts.rerender !== false });
  if (opts.repaint !== false) renderChartPanel();
  return updated;
}

function deleteChart(id) {
  const sheet = activeSheet();
  if (!sheet || !id) return;
  const list = chartsOf(sheet);
  const next = list.filter((c) => c && c.id !== id);
  if (next.length === list.length) return;
  if (chartPanel.chartId === id) chartPanel.chartId = next.length ? next[0].id : '';
  writeCharts(next);
  if (!next.length) closeChartPanel();
  else renderChartPanel();
  toast('차트를 지웠습니다.');
}

/**
 * `grid.onChartChange` — the geometry a drag or a resize produced.
 *
 * Both call shapes are accepted, because the grid is free to report either the whole
 * chart or just the id and the box: (chartLike) or (id, {x,y,w,h}). Only the four
 * geometry fields are taken from it — a drag can move a chart, never redefine it — and
 * the grid has already drawn the new rectangle, so no re-render is asked for.
 */
function persistChartGeometry(a, b) {
  let id = '';
  let src = null;
  if (typeof a === 'string') {
    id = a;
    src = (b && typeof b === 'object') ? b : null;
  } else if (a && typeof a === 'object') {
    id = typeof a.id === 'string' ? a.id : '';
    src = (b && typeof b === 'object') ? b : a;
  }
  if (!id || !src) return;
  const geom = {};
  for (const key of ['x', 'y', 'w', 'h']) {
    const n = Number(src[key]);
    if (isFinite(n)) geom[key] = Math.round(n);
  }
  if (!Object.keys(geom).length) return;
  updateChart(id, geom, { rerender: false, repaint: true });
}

/** The 차트 side panel's own state. */
const chartPanel = { root: null, body: null, title: null, foot: null, chartId: '', open: false };

function ensureChartPanel() {
  if (chartPanel.root) return chartPanel;
  const shell = buildPanel('sz-chart-panel', '차트', () => closeChartPanel());
  chartPanel.root = shell.root;
  chartPanel.body = shell.body;
  chartPanel.title = shell.title;
  chartPanel.foot = shell.foot;
  return chartPanel;
}

function openChartPanel(id) {
  const sheet = activeSheet();
  if (!sheet) return;
  const list = chartsOf(sheet);
  if (!list.length) { toast('이 시트에는 차트가 없습니다.'); return; }
  ensureChartPanel();
  chartPanel.chartId = (id && chartById(sheet, id)) ? id : list[list.length - 1].id;
  chartPanel.root.hidden = false;
  chartPanel.open = true;
  renderChartPanel();
}

function closeChartPanel() {
  if (!chartPanel.root || !chartPanel.open) return;
  chartPanel.open = false;
  chartPanel.root.hidden = true;
  chartPanel.chartId = '';
}

/** One labelled control row. */
function panelField(labelText, control) {
  const wrap = el('div', 'sz-panel-row');
  wrap.style.display = 'block';
  const label = el('label', 'sz-panel-label', labelText);
  const id = 'sz-f' + Math.random().toString(36).slice(2, 8);
  control.id = id;
  label.setAttribute('for', id);
  wrap.appendChild(label);
  wrap.appendChild(control);
  return wrap;
}

function panelCheck(labelText, checked, onChange) {
  const wrap = el('label', 'sz-panel-check');
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.checked = !!checked;
  input.addEventListener('change', () => onChange(input.checked));
  wrap.appendChild(input);
  wrap.appendChild(el('span', null, labelText));
  return wrap;
}

function renderChartPanel() {
  if (!chartPanel.root || !chartPanel.open) return;
  const sheet = activeSheet();
  const list = chartsOf(sheet);
  if (!sheet || !list.length) { closeChartPanel(); return; }
  let chart = chartById(sheet, chartPanel.chartId);
  if (!chart) {
    chart = list[list.length - 1];
    chartPanel.chartId = chart.id;
  }

  chartPanel.title.textContent = chart.title ? ('차트 · ' + chart.title) : '차트';
  chartPanel.root.setAttribute('aria-label', chartPanel.title.textContent);
  clearNode(chartPanel.body);
  clearNode(chartPanel.foot);

  // Which chart, when the sheet has more than one.
  if (list.length > 1) {
    const which = document.createElement('select');
    which.className = 'sz-panel-field';
    list.forEach((c, i) => {
      const opt = document.createElement('option');
      opt.value = c.id;
      opt.textContent = (c.title || ('차트 ' + (i + 1))) + ' · ' + c.range;
      if (c.id === chart.id) opt.selected = true;
      which.appendChild(opt);
    });
    which.addEventListener('change', () => {
      chartPanel.chartId = which.value;
      renderChartPanel();
    });
    chartPanel.body.appendChild(panelField('차트 선택', which));
  }

  const type = document.createElement('select');
  type.className = 'sz-panel-field';
  for (const entry of CHART_TYPES) {
    const id = entry && (entry.id || entry.value || entry.type);
    if (typeof id !== 'string' || !id) continue;
    const opt = document.createElement('option');
    opt.value = id;
    opt.textContent = (entry && (entry.label || entry.name)) || id;
    if (id === chart.type) opt.selected = true;
    type.appendChild(opt);
  }
  type.addEventListener('change', () => updateChart(chart.id, { type: type.value }));
  chartPanel.body.appendChild(panelField('종류', type));

  const title = el('input', 'sz-panel-field');
  title.type = 'text';
  title.value = chart.title || '';           // user text: a value, never markup
  title.maxLength = 200;
  title.placeholder = '제목 없음';
  title.addEventListener('change', () => updateChart(chart.id, { title: title.value }));
  chartPanel.body.appendChild(panelField('제목', title));

  const range = el('input', 'sz-panel-field');
  range.type = 'text';
  range.value = chart.range;
  range.spellcheck = false;
  range.autocomplete = 'off';
  range.addEventListener('change', () => {
    const text = String(range.value || '').trim().toUpperCase();
    if (!mergeRect(text)) {
      toast('데이터 범위를 A1:C10 형식으로 입력하세요.', 'error');
      range.value = chart.range;
      return;
    }
    updateChart(chart.id, { range: text });
  });
  chartPanel.body.appendChild(panelField('데이터 범위', range));

  chartPanel.body.appendChild(panelCheck('첫 행을 계열 이름으로', chart.headerRow,
    (on) => updateChart(chart.id, { headerRow: on })));
  chartPanel.body.appendChild(panelCheck('첫 열을 항목 이름으로', chart.headerCol,
    (on) => updateChart(chart.id, { headerCol: on })));

  const legend = document.createElement('select');
  legend.className = 'sz-panel-field';
  for (const [value, label] of CHART_LEGENDS) {
    const opt = document.createElement('option');
    opt.value = value;
    opt.textContent = label;
    if (value === chart.legend) opt.selected = true;
    legend.appendChild(opt);
  }
  legend.addEventListener('change', () => updateChart(chart.id, { legend: legend.value }));
  chartPanel.body.appendChild(panelField('범례 위치', legend));

  const size = el('div', 'sz-panel-empty',
    '크기 ' + chart.w + ' × ' + chart.h + ' · 위치 ' + chart.x + ', ' + chart.y
    + ' (차트를 끌어 옮기거나 모서리를 끌어 크기를 바꿀 수 있습니다)');
  chartPanel.body.appendChild(size);

  const del = panelButton('차트 삭제', 'danger', () => deleteChart(chart.id));
  chartPanel.foot.appendChild(del);
  chartPanel.foot.appendChild(panelButton('닫기', 'primary', () => closeChartPanel()));
}

// --- 댓글 (SPEC 24.3) ---------------------------------------------------------
//
// The only feature here with a frame of its own, and the reason is trust: the SERVER
// stamps `author`, `authorId` and `at`. This client sends an op, a cell and text, and
// nothing else — it never claims who wrote a message or when, and it never applies a
// thread optimistically, because a message whose author was invented locally would be
// a lie for however long the round trip takes.

/**
 * Comment text as the wire will carry it: CR/LF folded and trimmed.
 *
 * Deliberately NOT truncated. The server refuses an over-long message rather than
 * storing part of it, because silently keeping the first 4000 code points would tell
 * the author their whole comment posted — so this side refuses it too, out loud, and
 * the two ends never disagree about what was sent. -> '' when there is nothing to send.
 */
function commentTextOrWarn(raw) {
  const text = String(raw == null ? '' : raw).replace(/\r\n?/g, '\n').trim();
  if (!text) { toast('댓글 내용을 입력하세요.', 'error'); return ''; }
  if (Array.from(text).length > MAX_COMMENT_LEN) {   // code points, never UTF-16 units
    toast('댓글은 ' + MAX_COMMENT_LEN + '자까지 쓸 수 있습니다.', 'error');
    return '';
  }
  return text;
}

/** Send one `{t:'comment'}` frame. -> true when it was handed to the socket. */
function sendCommentOp(op, extra) {
  if (!state.docId || !state.sheetId) return false;
  if (!net) { toast('연결되지 않아 댓글을 보낼 수 없습니다.', 'error'); return false; }
  const src = extra || {};
  const frame = { t: 'comment', docId: state.docId, sheetId: state.sheetId, op };
  if (typeof src.cell === 'string' && src.cell) frame.cell = src.cell;
  if (typeof src.threadId === 'string' && src.threadId) frame.threadId = src.threadId;
  if (typeof src.messageId === 'string' && src.messageId) frame.messageId = src.messageId;
  if (typeof src.text === 'string') frame.text = src.text;
  // Through the outbox like every other document mutation (SPEC 27.4): a comment is
  // typed text too, and losing one to a dropped socket is exactly what this forbids.
  if (!sendTracked(frame)) {
    toast('댓글을 보내지 못했습니다.', 'error');
    return false;
  }
  return true;
}

function addComment(a1, rawText) {
  const sheet = activeSheet();
  if (!sheet || !a1) return false;
  const text = commentTextOrWarn(rawText);
  if (!text) return false;
  const existing = threadAt(sheet, a1);
  if (!existing && Object.keys(commentsOf(sheet)).length >= MAX_COMMENTS_PER_SHEET) {
    toast('댓글은 시트당 ' + MAX_COMMENTS_PER_SHEET + '개까지 달 수 있습니다.', 'error');
    return false;
  }
  return existing
    ? sendCommentOp('reply', { cell: a1, threadId: existing.id, text })
    : sendCommentOp('add', { cell: a1, text });
}

/** A short human time for a message, mirroring the document list's vocabulary. */
function relTime(ms) {
  const n = Number(ms);
  if (!isFinite(n) || n <= 0) return '';
  const diff = Date.now() - n;
  if (diff < 0) return '방금 전';
  if (diff < 60000) return '방금 전';
  if (diff < 3600000) return Math.floor(diff / 60000) + '분 전';
  if (diff < 86400000) return Math.floor(diff / 3600000) + '시간 전';
  if (diff < 172800000) return '어제';
  if (diff < 2592000000) return Math.floor(diff / 86400000) + '일 전';
  const d = new Date(n);
  const pad = (v) => (v < 10 ? '0' + v : String(v));
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
}

/** The 댓글 side panel's own state. `cell` is the thread the panel is focused on. */
const commentPanel = { root: null, body: null, title: null, foot: null, cell: '', open: false };

function ensureCommentPanel() {
  if (commentPanel.root) return commentPanel;
  const shell = buildPanel('sz-comment-panel', '댓글', () => closeCommentPanel());
  commentPanel.root = shell.root;
  commentPanel.body = shell.body;
  commentPanel.title = shell.title;
  commentPanel.foot = shell.foot;
  return commentPanel;
}

/** The toolbar button and `grid.onCommentOpen` both land here. */
function openCommentPanel(info) {
  const sheet = activeSheet();
  if (!sheet) return;
  let a1 = '';
  if (typeof info === 'string') a1 = info;
  else if (info && typeof info === 'object') {
    const raw = info.cell || info.a1 || info.key;
    if (typeof raw === 'string') a1 = raw;
  }
  if (!a1) a1 = selOf().active;
  commentPanel.cell = String(a1).toUpperCase();
  ensureCommentPanel();
  commentPanel.root.hidden = false;
  commentPanel.open = true;
  renderCommentPanel({ focus: true });
}

function closeCommentPanel() {
  if (!commentPanel.root || !commentPanel.open) return;
  commentPanel.open = false;
  commentPanel.root.hidden = true;
  commentPanel.cell = '';
}

/** One message: author and time as the SERVER stamped them, text as TEXT. */
function commentMessageNode(msg) {
  const node = el('div', 'sz-comment-msg');
  const meta = el('div', 'sz-comment-meta');
  meta.appendChild(el('span', 'sz-comment-author', msg.author || '알 수 없는 사용자'));
  const when = relTime(msg.at);
  if (when) meta.appendChild(el('span', 'sz-comment-when', when));
  node.appendChild(meta);
  node.appendChild(el('div', 'sz-comment-text', msg.text || ''));
  return node;
}

function commentThreadNode(sheet, key, thread, focusCell) {
  const wrap = el('div', 'sz-comment-thread'
    + (thread.resolved ? ' sz-comment-thread-resolved' : '')
    + (key === focusCell ? ' sz-comment-thread-active' : ''));

  const head = el('div', 'sz-panel-row');
  const jump = panelButton(key, '', () => selectCell(key));
  jump.title = key + ' 셀로 이동';
  head.appendChild(jump);
  if (thread.resolved) head.appendChild(el('span', 'sz-comment-when', '해결됨'));
  wrap.appendChild(head);

  const messages = Array.isArray(thread.messages) ? thread.messages : [];
  for (const msg of messages) {
    if (msg && typeof msg === 'object') wrap.appendChild(commentMessageNode(msg));
  }

  const reply = el('textarea', 'sz-comment-box');
  reply.rows = 2;
  reply.maxLength = MAX_COMMENT_LEN;
  reply.placeholder = '답글 달기';
  reply.setAttribute('aria-label', key + ' 답글');
  wrap.appendChild(reply);

  const actions = el('div', 'sz-panel-row sz-panel-row-wrap');
  actions.appendChild(panelButton('답글', 'primary', () => {
    const text = commentTextOrWarn(reply.value);
    if (!text) return;
    if (sendCommentOp('reply', { cell: key, threadId: thread.id, text })) reply.value = '';
  }));
  if (thread.resolved) {
    actions.appendChild(panelButton('다시 열기', '', () =>
      sendCommentOp('reopen', { cell: key, threadId: thread.id })));
  } else {
    actions.appendChild(panelButton('해결', '', () =>
      sendCommentOp('resolve', { cell: key, threadId: thread.id })));
  }

  // 삭제 takes other people's messages with it and there is no undo for a comment, so
  // it confirms inline — the pattern the document list already uses, never window.confirm,
  // which blocks the renderer thread.
  const confirmRow = el('div', 'sz-panel-row sz-panel-row-wrap');
  confirmRow.hidden = true;
  actions.appendChild(panelButton('삭제', 'danger', () => {
    actions.hidden = true;
    confirmRow.hidden = false;
  }));
  confirmRow.appendChild(el('span', 'sz-comment-when', '이 댓글을 지울까요?'));
  confirmRow.appendChild(panelButton('삭제', 'danger', () =>
    sendCommentOp('delete', { cell: key, threadId: thread.id })));
  confirmRow.appendChild(panelButton('취소', '', () => {
    confirmRow.hidden = true;
    actions.hidden = false;
  }));

  wrap.appendChild(actions);
  wrap.appendChild(confirmRow);
  return wrap;
}

function renderCommentPanel(options) {
  if (!commentPanel.root || !commentPanel.open) return;
  const opts = options || {};
  const sheet = activeSheet();
  if (!sheet) { closeCommentPanel(); return; }
  const map = commentsOf(sheet);
  const keys = Object.keys(map);
  const focusCell = commentPanel.cell;

  commentPanel.title.textContent = '댓글' + (keys.length ? ' · ' + keys.length + '개' : '');
  commentPanel.root.setAttribute('aria-label', commentPanel.title.textContent);
  clearNode(commentPanel.body);
  clearNode(commentPanel.foot);

  // The composer, for the cell the panel was opened on, when it has no thread yet.
  let box = null;
  if (focusCell && !threadAt(sheet, focusCell)) {
    const block = el('div', 'sz-comment-thread sz-comment-thread-active');
    block.appendChild(el('div', 'sz-panel-label', focusCell + ' 셀에 댓글 달기'));
    box = el('textarea', 'sz-comment-box');
    box.rows = 3;
    box.maxLength = MAX_COMMENT_LEN;
    box.placeholder = '댓글을 입력하세요';
    box.setAttribute('aria-label', focusCell + ' 댓글');
    block.appendChild(box);
    const row = el('div', 'sz-panel-row');
    row.appendChild(panelButton('댓글 달기', 'primary', () => {
      if (addComment(focusCell, box.value)) box.value = '';
    }));
    block.appendChild(row);
    commentPanel.body.appendChild(block);
  }

  for (const key of keys) {
    const thread = map[key];
    if (thread && typeof thread === 'object') {
      commentPanel.body.appendChild(commentThreadNode(sheet, key, thread, focusCell));
    }
  }
  if (!keys.length && !box) {
    commentPanel.body.appendChild(el('div', 'sz-panel-empty', '이 시트에는 댓글이 없습니다.'));
  }

  commentPanel.foot.appendChild(panelButton('닫기', 'primary', () => closeCommentPanel()));
  if (opts.focus && box) {
    try { box.focus(); } catch (e) { /* focus is a nicety */ }
  }
}

/**
 * The server's answer to any comment op: the sheet's whole comment map (SPEC 24.3).
 * It REPLACES what we hold — the server is the only authority on a thread's author and
 * timestamps — and is re-validated on the way in, because the text in it was typed by
 * somebody else.
 */
function onCommentsFrame(payload) {
  if (isErrorFrame(payload)) { showServerError(payload); return; }
  const sheetId = frameSheetId(payload);
  const sheet = sheetById(sheetId);
  if (!sheet) return;

  let map = null;
  if (payload && typeof payload === 'object') {
    if (payload.comments && typeof payload.comments === 'object') map = payload.comments;
    else if (payload.t === 'comments') map = {};
    else map = payload;
  }
  sheet.comments = sanitizeComments(map, sheet.rows, sheet.cols);

  const rev = payload ? payload.rev : undefined;
  if (Number.isFinite(rev) && state.doc) state.doc.rev = rev;
  if (sheetId !== state.sheetId) return;    // another sheet: stored, nothing to repaint

  if (grid) {
    try { grid.render(); } catch (e) { console.error('[main] 댓글 표시 실패', e); }
  }
  renderCommentPanel();
  refreshToolbar();
}

/** Shut every data panel — a sheet or document switch must not leave one hanging. */
function closeDataPanels() {
  closeFilterPanel();
  closeChartPanel();
  closeCommentPanel();
}

// ------------------------------------------------------------ code version

/**
 * The id of the client code this page loaded with, as reported by the server.
 *
 * A tab that was opened before a restart keeps its old modules in memory, so every fix
 * looks like it never landed. Rather than leaving that to guesswork, the id is printed
 * at boot and re-checked on every reconnect; when it changes, the page says so instead
 * of quietly running code that no longer matches the server.
 */
let loadedBuild = null;
let buildWarned = false;

function noticeBuild(build) {
  if (typeof build !== 'string' || !build) return;
  if (loadedBuild === null) {
    loadedBuild = build;
    console.log('[시트지] 클라이언트 버전 ' + build);
    return;
  }
  if (build === loadedBuild || buildWarned) return;
  buildWarned = true;
  console.warn('[시트지] 서버 코드가 바뀌었습니다: ' + loadedBuild + ' → ' + build);
  toast('앱이 업데이트되었습니다. 새로고침(F5)하면 최신 기능이 적용됩니다.', 'error');
}

// ------------------------------------------------------------- peer paint

/** Everyone but us. */
function otherPeers() {
  return state.peers.filter((p) => p && p.id && p.id !== state.me.id);
}

let peersPending = false;

function paintPeers() {
  if (peersPending) return;
  peersPending = true;
  onNextFrame(() => {
    peersPending = false;
    try { if (ui && ui.peers) renderPeers(ui.peers, state.peers, state.me); }
    catch (e) { console.error('[main] 참여자 표시 실패', e); }
    const others = otherPeers();
    try {
      // Only the peers on THIS sheet get a cursor drawn; the rest show up as dots on
      // their own tab. A peer that has not reported a sheet yet is assumed to be here.
      if (grid) {
        grid.setPeerCursors(others.filter((p) => !p.sheetId || p.sheetId === state.sheetId));
      }
    } catch (e) { console.error('[main] 원격 커서 표시 실패', e); }
    try { if (sheetbar) sheetbar.setState({ peers: others }); }
    catch (e) { console.error('[main] 시트 탭 참여자 표시 실패', e); }
  });
}

function paintSheetBar() {
  if (!sheetbar || !state.doc) return;
  try {
    sheetbar.setState({
      sheets: state.doc.sheets,
      activeId: state.sheetId,
      peers: otherPeers(),
    });
  } catch (e) {
    console.error('[main] 시트 탭 표시 실패', e);
  }
}

function setStatus(status) {
  state.status = status;
  // The save indicator is driven by the outbox AND the socket, so it moves with this
  // (SPEC 27.5): pending work reads 저장 중… while the socket is up and 저장 대기 중 (N)
  // once it is not.
  paintSave();
  const view = STATUS_VIEW[status] || STATUS_VIEW.offline;
  if (!ui || !ui.status) return;
  // style.css draws the dot from .sz-status::before, keyed on data-state.
  ui.status.dataset.state = status;
  if (status === 'unauthorized') {
    // SPEC 28.3/28.5 — the socket was refused, not dropped. A chip that only said so
    // would leave the user nowhere to go, so it carries the link with it. The document
    // stays on screen and the outbox keeps its work: logging in again replays it.
    ui.status.textContent = view.text + ' ';
    const link = el('a', 'sz-status-login', '로그인');
    link.href = loginUrl();
    // Through goToLogin, not the bare href: that is what marks the navigation as
    // deliberate, so beforeunload does not warn about unsaved work on the way to the one
    // page that can save it. Warning here would contradict the toast we just showed and
    // discourage the only action that recovers the edits.
    link.addEventListener('click', (ev) => { ev.preventDefault(); goToLogin(); });
    // Two properties on a node this file created, for the same reason #sz-save carries
    // its own: style.css cannot be relied on to know about a link that only exists in
    // this one state, and a link nobody can read in dark mode is not a way out.
    link.style.color = 'inherit';
    link.style.textDecoration = 'underline';
    ui.status.appendChild(link);
    ui.status.title = '세션이 만료되었거나 로그인하지 않았습니다.';
    noticeSignedOut();
    return;
  }
  ui.status.textContent = view.text;
  ui.status.title = '서버 연결 상태: ' + view.text;
}

/**
 * Said once: the socket is refused because there is no session (SPEC 28.3).
 *
 * The promise about kept work is made ONLY when the outbox can actually keep it —
 * the same rule the save indicator obeys, for the same reason: this file may
 * under-promise and may never over-promise.
 */
function noticeSignedOut() {
  if (authNoticed) return;
  authNoticed = true;
  const kept = outboxPersists()
    ? ' 편집 내용은 이 브라우저에 보관해 두었으니 다시 로그인하면 이어서 저장됩니다.'
    : '';
  toast('로그인이 필요합니다. 다시 로그인해 주세요.' + kept, 'error');
}

// ------------------------------------------------------------- clipboard

function rangeOf(sel) {
  const b = bounds(sel);
  return {
    s: { row: b.r1, col: b.c1, absRow: false, absCol: false },
    e: { row: b.r2, col: b.c2, absRow: false, absCol: false },
  };
}

/** Raw inputs of a selection as string[][] — what an internal paste replays. */
function rawGrid(sel) {
  const b = bounds(sel);
  const rows = [];
  for (let r = b.r1; r <= b.r2; r++) {
    const row = [];
    for (let c = b.c1; c <= b.c2; c++) {
      let input = '';
      try { input = engine.getInput(cellToA1(r, c)) || ''; } catch (e) { input = ''; }
      row.push(input);
    }
    rows.push(row);
  }
  return rows;
}

/**
 * Empty the selection.
 *
 * @param {string} [label]     undo label
 * @param {boolean} [all]      true = take the FORMATTING too (Ctrl+X), false = content
 *                             only (Delete), which is what every other spreadsheet does.
 *
 * The two send different patches, and the difference matters on both sides of the wire:
 * `{input:null}` clears the content and leaves style and link alone, while a bare `null`
 * removes the cell outright. Sending the content-only form for a cut left the border
 * painted locally while the server dropped the whole cell — the same cell disagreeing
 * with itself until the next reload.
 */
function clearSelection(label, all) {
  const sel = selOf();
  const keys = selectionKeys(sel);
  if (!keys) {
    toast('선택 범위가 너무 넓습니다. ' + MAX_EDIT_CELLS + '칸 이하로 선택하세요.', 'error');
    return;
  }
  const ctx = activeCtx();
  const shadow = ctx ? ctx.shadow : new Map();
  const cells = {};
  let touched = 0;
  for (const key of keys) {
    let input = '';
    try { input = engine.getInput(key) || ''; } catch (e) { input = ''; }
    let hasStyle = false;
    if (all) {
      try { const st = engine.getStyle(key); hasStyle = !!(st && Object.keys(st).length); }
      catch (e) { hasStyle = false; }
    }
    if (input === '' && !hasStyle && !shadow.has(key)) continue;   // nothing to clear
    cells[key] = all ? null : { input: null };
    touched += 1;
  }
  if (!touched) return;
  commitLocalEdit(cells, { label: label || '내용 지우기' });
}

function onCopyLike(ev, isCut) {
  if (foreignInput(ev.target)) return;     // let real inputs use the native clipboard
  if (!engine || !grid) return;
  const sel = selOf();
  const b = bounds(sel);
  if ((b.r2 - b.r1 + 1) * (b.c2 - b.c1 + 1) > MAX_COPY_CELLS) {
    toast('복사할 범위가 너무 넓습니다. 더 좁게 선택해 주세요.', 'error');
    return;
  }
  const range = rangeOf(sel);

  let text = '';
  let html = '';
  let raw = null;
  let styles = null;
  try {
    const packed = serializeSelection(engine, range);
    if (packed) {
      text = typeof packed.text === 'string' ? packed.text : '';
      html = typeof packed.html === 'string' ? packed.html : '';
      if (Array.isArray(packed.inputs) && packed.inputs.length) raw = packed.inputs;
      if (Array.isArray(packed.styles) && packed.styles.length) styles = packed.styles;
    }
  } catch (e) {
    console.error('[main] 클립보드 직렬화 실패', e);
  }
  if (!raw) raw = rawGrid(sel);
  if (!text) text = raw.map((row) => row.join('\t')).join('\n');

  if (ev.clipboardData) {
    try {
      ev.clipboardData.setData('text/plain', text);
      if (html) ev.clipboardData.setData('text/html', html);
      ev.preventDefault();
    } catch (e) {
      console.error('[main] 클립보드 쓰기 실패', e);
    }
  }
  // A cut keeps references pointing where they pointed (Excel semantics), so
  // the flag travels with the payload and disables translation on paste.
  // Styles travel with the payload so an internal paste reproduces the formatting,
  // borders included — copying a cell in a spreadsheet means copying how it looks, not
  // just what it says.
  state.clip = { text, grid2d: raw, styles, range, cut: !!isCut };
  if (isCut) clearSelection('잘라내기', true);   // a cut takes the formatting with it
}

// ------------------------------------------- external import (SPEC 26)
//
// Every spreadsheet writes TWO flavours of the same selection onto the clipboard: the
// displayed values as tab-separated `text/plain`, and a `text/html` <table> carrying the
// formatting. Google Sheets hides each cell's FORMULA in an attribute of that table; so
// does 시트지's own copy. Reading the HTML is what turns a paste from a data transfer
// into a real import, and clipboard.js's parseExternalHtml() does all of the parsing —
// in an INERT DOMParser document, onto the app's own closed style sets, never near
// innerHTML. Nothing below ever touches the markup except to search it for a substring.
//
// The order in onPasteEvent is the whole design (SPEC 26.3): an INTERNAL paste — this
// app's own last copy, recognised by its text — never reaches this code at all. It is
// the common case, it is already right, and routing it through a generic HTML parser
// could only make it worse.

/**
 * The attributes that carry a formula. Their absence from the markup — while the markup
 * still carries formatting — is exactly what identifies an Excel (or LibreOffice) copy:
 * those programs put the RESULT of a formula on the clipboard and never the formula.
 * A plain substring test on a string this file never parses itself; a false negative
 * only costs the explanatory sentence below.
 */
const FORMULA_ATTR_RE = /data-(?:sz-input|sheets-formula|sheets-value)\s*=/i;

/** Display text only a formula can produce. */
const RESULT_ERRORS = new Set([
  '#DIV/0!', '#VALUE!', '#REF!', '#NAME?', '#NUM!', '#N/A', '#NULL!',
  '#CYCLE!', '#ERROR!', '#SPILL!', '#CALC!', '#GETTING_DATA',
]);

/** Currency marks a displayed number may wear, stripped before the numeric test. */
const CURRENCY_CHARS = /[₩$€£¥]/g;

/**
 * Does this cell's text look like the RESULT of a formula rather than something typed?
 *
 * An error literal is the only unambiguous answer, so it is checked first. A number is
 * the other one that matters: a total, an average and a lookup all display as one, and a
 * pasted table whose numbers used to be formulas is precisely the case where a user
 * would otherwise conclude their formulas were lost here. Labels and prose answer false,
 * so a pasted list of names says nothing about Excel at all.
 */
function looksComputed(text) {
  const raw = String(text == null ? '' : text).trim();
  if (!raw) return false;
  if (RESULT_ERRORS.has(raw.toUpperCase())) return true;
  let s = raw;
  if (s.charAt(0) === '(' && s.charAt(s.length - 1) === ')') s = s.slice(1, -1).trim();
  s = s.replace(CURRENCY_CHARS, '').replace(/원$/, '').replace(/%$/, '').trim();
  s = s.replace(/^[+-]/, '').replace(/,/g, '').trim();
  if (!s) return false;
  return /^\d+(?:\.\d+)?$/.test(s);
}

/**
 * Turn the clipboard's `text/html` into something pasteInto() can take, or null.
 *
 * Null is returned — and the plain-text parse used instead — whenever the two flavours
 * disagree about the SHAPE of the table. They describe the same selection, so a
 * mismatch means the markup is not that selection (a wrapper table, a mail signature, a
 * page fragment that merely contains a grid), and `text/plain` is the one to trust.
 *
 * @param {string} html          the raw text/html flavour, untrusted
 * @param {string[][]} textGrid  the plain-text parse, already rectangular
 * @returns {null|{rows:number, cols:number, values:string[][],
 *                 styles:Array<Array<object|null>>,
 *                 merges:Array<{row:number,col:number,rows:number,cols:number}>,
 *                 styled:boolean, valuesOnly:boolean}}
 */
function externalImport(html, textGrid) {
  if (typeof html !== 'string' || html === '') return null;
  if (!Array.isArray(textGrid) || textGrid.length === 0) return null;

  let table = null;
  try { table = parseExternalHtml(html); }
  catch (e) { table = null; }
  if (!table || !Array.isArray(table.cells)) return null;

  const rows = Number(table.rows) | 0;
  const cols = Number(table.cols) | 0;
  if (rows <= 0 || cols <= 0) return null;
  const textRows = textGrid.length;
  const textCols = Array.isArray(textGrid[0]) ? textGrid[0].length : 0;
  if (rows !== textRows || cols !== textCols) return null;

  const values = [];
  const styles = [];
  const merges = [];
  let styled = false;
  let formulas = false;
  let computed = false;

  for (let r = 0; r < rows; r++) {
    const src = Array.isArray(table.cells[r]) ? table.cells[r] : [];
    const valueLine = new Array(cols);
    const styleLine = new Array(cols);
    for (let c = 0; c < cols; c++) {
      const cell = src[c];
      if (!cell || typeof cell !== 'object') {
        // A position no cell reached, or one a merge covers: it must end up EMPTY,
        // because a merge keeps only its anchor (SPEC 21).
        valueLine[c] = '';
        styleLine[c] = null;
        continue;
      }
      const input = typeof cell.input === 'string' ? cell.input : '';
      valueLine[c] = input;
      const st = (cell.style && typeof cell.style === 'object' && Object.keys(cell.style).length)
        ? cell.style
        : null;
      styleLine[c] = st;
      if (st) styled = true;
      if (input.charAt(0) === '=') formulas = true;
      else if (looksComputed(input)) computed = true;
      const m = cell.merge;
      if (m && typeof m === 'object'
        && Number.isFinite(m.rows) && Number.isFinite(m.cols)
        && (m.rows > 1 || m.cols > 1)) {
        merges.push({
          row: r,
          col: c,
          rows: Math.max(1, m.rows | 0),
          cols: Math.max(1, m.cols | 0),
        });
        styled = true;
      }
    }
    values.push(valueLine);
    styles.push(styleLine);
  }

  return {
    rows,
    cols,
    values,
    styles,
    merges,
    styled,
    // Present only when the source was another 시트지 tab, which is the one source that
    // tells us where the copy came from — see parseExternalHtml.
    origin: table.origin || null,
    // "Excel sent the results, not the formulas" — claimed only when all three hold:
    // the markup carried formatting (so it really is a spreadsheet), it carried no
    // formula attribute anywhere (so it is neither Sheets nor 시트지, both of which do
    // ship formulas), and something in it reads as a computed value.
    valuesOnly: styled && computed && !formulas && !FORMULA_ATTR_RE.test(html),
  };
}

/**
 * The merge list this sheet should end up with after an import that carried merges,
 * translated from the source table's coordinates to the paste target's.
 *
 * pasteInto() tiles the source when the target is an exact multiple of it, so the
 * geometry tiles with it — cells and merges must never disagree about the same block.
 * Every existing merge the pasted region touches is dropped: those cells have just been
 * overwritten, and a rectangle the new content knows nothing about would render over it.
 *
 * @returns {string[]|null} the whole new list, or null when the import had no merges
 */
function pasteMergeList(sheet, sel, imported) {
  if (!sheet || !imported || !imported.merges.length) return null;

  const b = bounds(sel);
  const top = b.r1;
  const left = b.c1;
  const tRows = b.r2 - b.r1 + 1;
  const tCols = b.c2 - b.c1 + 1;
  const srcH = imported.rows;
  const srcW = imported.cols;

  // The tiling rule pasteInto() uses, mirrored exactly.
  let repRows = 1;
  let repCols = 1;
  if (tRows % srcH === 0 && tCols % srcW === 0 && (tRows > srcH || tCols > srcW)) {
    repRows = tRows / srcH;
    repCols = tCols / srcW;
  }

  const maxRow = Math.max(0, ((sheet.rows) | 0) - 1);
  const maxCol = Math.max(0, ((sheet.cols) | 0) - 1);
  const region = {
    r1: top,
    c1: left,
    r2: Math.min(maxRow, top + srcH * repRows - 1),
    c2: Math.min(maxCol, left + srcW * repCols - 1),
  };

  const added = [];
  for (let ti = 0; ti < repRows; ti++) {
    for (let tj = 0; tj < repCols; tj++) {
      const baseRow = top + ti * srcH;
      const baseCol = left + tj * srcW;
      for (const m of imported.merges) {
        const r1 = baseRow + m.row;
        const c1 = baseCol + m.col;
        if (r1 < 0 || c1 < 0 || r1 > maxRow || c1 > maxCol) continue;
        const r2 = Math.min(maxRow, r1 + m.rows - 1);
        const c2 = Math.min(maxCol, c1 + m.cols - 1);
        if (r1 === r2 && c1 === c2) continue;   // clipped down to a single cell
        try { added.push(cellToA1(r1, c1) + ':' + cellToA1(r2, c2)); }
        catch (e) { /* outside the address space: there is no merge to install */ }
      }
    }
  }
  if (!added.length) return null;

  const kept = mergesOf(sheet).filter((key) => {
    const r = mergeRect(key);
    if (!r) return false;
    return !(r.r1 <= region.r2 && r.r2 >= region.r1 && r.c1 <= region.c2 && r.c2 >= region.c1);
  });
  return kept.concat(added);
}

/**
 * Say what the import actually did (SPEC 26.3). Nothing is added or dropped silently:
 * the count is the cells that were written, `(서식 포함)` appears only when formatting
 * or merge geometry really came across, and the Excel sentence is said ONCE per paste
 * rather than once per cell.
 */
function reportImport(count, imported) {
  let msg = count + '칸을 붙여넣었습니다';
  if (imported.styled) msg += ' (서식 포함)';
  if (imported.valuesOnly) {
    msg += '. Excel은 수식을 클립보드에 담지 않기 때문에 계산된 값만 가져올 수 있습니다.';
  }
  toast(msg);
}

function onPasteEvent(ev) {
  if (foreignInput(ev.target)) return;
  if (!engine || !grid) return;
  const data = ev.clipboardData;
  if (!data) return;
  const text = data.getData('text/plain') || '';
  ev.preventDefault();
  if (!text) return;

  const sel = selOf();
  let grid2d = null;
  let sourceRange = null;
  let wasCut = false;
  let styles = null;
  let imported = null;                      // the external table, when one was used

  if (state.clip && state.clip.text === text) {
    grid2d = state.clip.grid2d;             // internal: raw inputs, refs translate
    sourceRange = state.clip.range;
    wasCut = !!state.clip.cut;
    styles = state.clip.styles;             // and the formatting that went with them
  } else {
    // SPEC 26.3, steps 2 and 3. The plain-text parse is computed FIRST because it is
    // both the fallback and the thing the markup has to agree with.
    try { grid2d = parseClipboard(text); } catch (e) { grid2d = null; }
    let html = '';
    try { html = data.getData('text/html') || ''; } catch (e) { html = ''; }
    imported = externalImport(html, grid2d);
    if (imported) {
      grid2d = imported.values;
      styles = imported.styles;
      // A 시트지 copy from another tab tells us where it came from, so its formulas get
      // the same relative-reference translation an internal paste performs. A copy from
      // Excel or Google Sheets does not carry an origin — nothing in their markup says
      // it — so those formulas are pasted verbatim rather than adjusted by a guess.
      if (imported.origin && Number.isInteger(imported.origin.row)) {
        const o = imported.origin;
        sourceRange = { s: { row: o.row, col: o.col }, e: { row: o.row, col: o.col } };
      }
    }
  }
  if (!Array.isArray(grid2d) || grid2d.length === 0) return;

  const opts = {
    sourceAnchor: sourceRange,
    sourceRange,
    source: sourceRange,
    origin: sourceRange ? { row: sourceRange.s.row, col: sourceRange.s.col } : null,
    internal: !!sourceRange,
    cut: wasCut,
    styles,
  };

  let patch = null;
  try { patch = pasteInto(engine, sel, grid2d, opts); }
  catch (e) {
    console.error('[main] 붙여넣기 실패', e);
    toast('붙여넣기에 실패했습니다.', 'error');
    return;
  }
  if (!patch || typeof patch !== 'object' || Object.keys(patch).length === 0) return;
  const count = Object.keys(patch).length;
  // Checked ONCE, here, for both branches below. commitLocalEdit() refuses a patch this
  // large and returns silently after its own toast; the branch that then reported
  // "N칸을 붙여넣었습니다" was telling the user a paste had happened that had not.
  // pasteInto tiles a small source over a larger target, so a 2x2 import dropped on a
  // wide selection reaches this easily.
  if (count > MAX_EDIT_CELLS) {
    toast('한 번에 편집할 수 있는 칸은 ' + MAX_EDIT_CELLS + '개까지입니다.', 'error');
    return;
  }

  // The geometry half of an import, when there is one. Merges ride the `meta` frame
  // exactly as the merge feature already sends them (SPEC 21.3), so nothing new goes on
  // the wire; the two halves are wrapped in ONE history entry, the way runMerge() does
  // it, or a single Ctrl+Z would put the cells back and leave the rectangles behind.
  const sheet = imported ? activeSheet() : null;
  const mergeList = sheet ? pasteMergeList(sheet, sel, imported) : null;

  if (!mergeList) {
    // pasteInto may already have written to the engine; re-applying is idempotent.
    // The cells go through commitLocalEdit() like every other edit, so the import is
    // undoable, replicated, journaled and chunked to the frame caps by code that was
    // already here.
    commitLocalEdit(patch, { label: '붙여넣기' });
    if (imported) reportImport(count, imported);
    return;
  }

  const sheetId = sheet.id;
  const ctx = ctxOf(sheetId);
  if (!ctx) return;
  const label = '붙여넣기';
  const forward = clonePatch(patch);
  // Taken BEFORE anything is applied: it is the only record of what the paste is
  // about to overwrite.
  const backward = inverseOf(patch, ctx);
  const beforeMerges = mergesOf(sheet).slice();
  const afterMerges = mergeList.slice();

  const applyBoth = (list, cellPatch) => {
    if (!sheetById(sheetId)) {
      toast('삭제된 시트의 작업은 되돌릴 수 없습니다.', 'error');
      return;
    }
    activateSheet(sheetId);
    if (cellPatch && Object.keys(cellPatch).length) {
      commitLocalEdit(cellPatch, { record: false, label, sheetId });
    }
    applySheetMeta(sheetId, { merges: list.slice() }, { send: true, rerender: true });
    refreshToolbar();
  };

  applyBoth(afterMerges, forward);
  history.push({
    label,
    undo: () => applyBoth(beforeMerges, backward),
    redo: () => applyBoth(afterMerges, forward),
  });
  reportImport(count, imported);
}

// --------------------------------------------------------- toolbar command

function applyStyleToSelection(stylePatch, label) {
  const sel = selOf();
  const keys = selectionKeys(sel);
  if (!keys) {
    toast('선택 범위가 너무 넓습니다. ' + MAX_EDIT_CELLS + '칸 이하로 선택하세요.', 'error');
    return;
  }
  const cells = {};
  for (const key of keys) cells[key] = { style: { ...stylePatch } };
  commitLocalEdit(cells, { label: label || '서식' });
}

function toggleFlag(key, label) {
  const on = !!activeStyle()[key];
  applyStyleToSelection({ [key]: on ? null : 1 }, label);
}

function bumpDecimals(delta) {
  const style = activeStyle();
  const fmt = typeof style.fmt === 'string' ? style.fmt : 'general';
  const base = typeof style.decimals === 'number'
    ? style.decimals
    : (DEFAULT_DECIMALS[fmt] !== undefined ? DEFAULT_DECIMALS[fmt] : 0);
  const next = Math.max(0, Math.min(6, base + delta));
  const patch = { decimals: next };
  // "일반" has no decimal places of its own; adjusting one implies a number format.
  if (fmt === 'general') patch.fmt = 'number';
  applyStyleToSelection(patch, '소수점 자릿수');
}

// --- cell formatting, SPEC 22 -----------------------------------------------
//
// 글꼴 / 글꼴 크기 / 세로 정렬 / 텍스트 줄바꿈 / 텍스트 회전 are ORDINARY style patches:
// they go through applyStyleToSelection() exactly like 굵게 and 정렬 do, which means
// they are undoable, coalesced and replicated by code that already exists — no new
// path, no new frame. A value equal to the key's documented default is written as
// null, which DELETES the key; that is what keeps a cell the user has reset
// byte-identical to a cell that was never touched at all.
//
// 테두리 is the one addition that needs geometry, and applyBorderPreset() supplies
// exactly that: rect + preset -> a per-cell patch of partial borders. Each one is
// merged into that cell's existing `bd`, and the result rides the same path.

/** 글꼴. An id outside the closed FONT_STACKS set is ignored, never stored. */
function applyFont(id) {
  const key = String(id == null ? '' : id);
  if (!Object.prototype.hasOwnProperty.call(FONT_STACKS, key)) return;
  applyStyleToSelection({ ff: key === 'default' ? null : key }, '글꼴');
}

/** 글꼴 크기. The toolbar steps through FONT_SIZES; this clamps to what `fs` allows. */
function applyFontSize(raw) {
  const n = typeof raw === 'number' ? raw : Number(String(raw == null ? '' : raw).trim());
  if (!Number.isInteger(n)) return;
  applyStyleToSelection(
    { fs: Math.max(MIN_FONT_SIZE, Math.min(MAX_FONT_SIZE, n)) },
    '글꼴 크기',
  );
}

/** 텍스트 회전. 'v' stacks the glyphs; 0 is the default, so it clears the key. */
function applyRotation(raw) {
  if (raw === 'v') { applyStyleToSelection({ rot: 'v' }, '텍스트 회전'); return; }
  const n = typeof raw === 'number' ? raw : Number(String(raw == null ? '' : raw).trim());
  if (!Number.isInteger(n)) return;
  const deg = Math.max(-MAX_ROTATION, Math.min(MAX_ROTATION, n));
  applyStyleToSelection({ rot: deg === 0 ? null : deg }, '텍스트 회전');
}

/**
 * 테두리. applyBorderPreset() decides WHICH sides of WHICH cells a preset touches;
 * a cell it does not name keeps its border untouched. Everything it does name is
 * merged into that cell's existing `bd`, so adding an outer border to a cell that
 * already carries an inner one keeps both. Only 'none' yields a null, which clears
 * the key outright.
 */
function applyBorderToSelection(preset, edge) {
  const b = bounds(selOf());
  let patch = null;
  try {
    patch = applyBorderPreset({ r1: b.r1, c1: b.c1, r2: b.r2, c2: b.c2 }, preset, edge);
  } catch (e) {
    console.error('[main] 테두리를 계산하지 못했습니다', e);
    return;
  }
  const keys = patch ? Object.keys(patch) : [];
  if (!keys.length) return;               // a preset with no edge to draw here
  if (keys.length > MAX_EDIT_CELLS) {
    toast('선택 범위가 너무 넓습니다. ' + MAX_EDIT_CELLS + '칸 이하로 선택하세요.', 'error');
    return;
  }
  const cells = {};
  for (const a1 of keys) {
    const sides = patch[a1];
    if (sides === null) { cells[a1] = { style: { bd: null } }; continue; }
    let current = null;
    try {
      const st = engine.getStyle(a1);
      if (st && st.bd && typeof st.bd === 'object') current = st.bd;
    } catch (e) { current = null; }
    cells[a1] = { style: { bd: { ...(current || {}), ...sides } } };
  }
  commitLocalEdit(cells, { label: '테두리' });
}

function gotoRef(text) {
  const raw = String(text == null ? '' : text).trim().toUpperCase().replace(/\$/g, '');
  if (!raw) return;
  const sheet = activeSheet() || { rows: DEFAULT_ROWS, cols: DEFAULT_COLS };
  const maxRow = Math.max(0, (sheet.rows | 0) - 1);
  const maxCol = Math.max(0, (sheet.cols | 0) - 1);
  const clamp = (r, c) => ({
    row: Math.max(0, Math.min(maxRow, r)),
    col: Math.max(0, Math.min(maxCol, c)),
  });

  let sel = null;
  try {
    if (raw.indexOf(':') >= 0) {
      const range = parseRange(raw);
      const a = clamp(Math.min(range.s.row, range.e.row), Math.min(range.s.col, range.e.col));
      const b = clamp(Math.max(range.s.row, range.e.row), Math.max(range.s.col, range.e.col));
      sel = { active: cellToA1(a.row, a.col), range: { s: a, e: b } };
    } else if (isA1(raw)) {
      const rc = a1ToCell(raw);
      const a = clamp(rc.row, rc.col);
      sel = { active: cellToA1(a.row, a.col), range: { s: a, e: { row: a.row, col: a.col } } };
    }
  } catch (e) {
    sel = null;
  }
  if (!sel) { toast('셀 주소를 인식할 수 없습니다: ' + text, 'error'); return; }

  try { grid.setSelection(sel); } catch (e) { console.error('[main] 선택 이동 실패', e); }
  try { grid.focusCell(sel.active); } catch (e) { /* focus is best effort */ }
  sendCursor(true);
  refreshToolbar();
}

function toggleFreeze(axis, payload) {
  const sheet = activeSheet();
  if (!sheet) return;
  const b = bounds(selOf());
  const key = axis === 'rows' ? 'frozenRows' : 'frozenCols';
  const limit = axis === 'rows' ? (sheet.rows | 0) : (sheet.cols | 0);
  const current = sheet[key] | 0;
  const wanted = Number.isFinite(payload)
    ? Number(payload)
    : (current > 0 ? 0 : (axis === 'rows' ? b.r1 + 1 : b.c1 + 1));
  const next = Math.max(0, Math.min(limit, wanted));
  if (next === current) return;
  applySheetMeta(sheet.id, { [key]: next }, { send: true, rerender: true });
  const noun = axis === 'rows' ? '행' : '열';
  toast(next > 0 ? (next + '개 ' + noun + '을 고정했습니다.') : (noun + ' 고정을 해제했습니다.'));
}

function handleCommand(name, payload) {
  if (!engine || !state.doc) return;
  const sel = selOf();
  const b = bounds(sel);
  const rowSpan = b.r2 - b.r1 + 1;
  const colSpan = b.c2 - b.c1 + 1;

  switch (name) {
    case 'undo':
      if (!history.undo()) toast('되돌릴 작업이 없습니다.');
      break;
    case 'redo':
      if (!history.redo()) toast('다시 실행할 작업이 없습니다.');
      break;

    case 'bold': toggleFlag('b', '굵게'); break;
    case 'italic': toggleFlag('i', '기울임'); break;
    case 'underline': toggleFlag('u', '밑줄'); break;
    case 'strike': toggleFlag('s', '취소선'); break;

    case 'align:left':
    case 'align:center':
    case 'align:right': {
      const want = name.slice(6);
      const cur = activeStyle().align;
      applyStyleToSelection({ align: cur === want ? null : want }, '정렬');
      break;
    }

    // SPEC 22.4. The value is written verbatim, including 'bottom'. Writing null for
    // 'bottom' instead would delete the key, and an absent `va` falls back to the
    // stylesheet's centred default — so 아래 would render identically to 가운데 and the
    // choice would be unreachable. Cells nobody has touched still carry no `va` key and
    // still render exactly as they did before, which is what SPEC 22.5 requires.
    case 'valign:top':
    case 'valign:middle':
    case 'valign:bottom': {
      applyStyleToSelection({ va: name.slice(7) }, '세로 정렬');
      break;
    }

    // Written verbatim, like 세로 정렬 and for the same reason: nulling the value that
    // happens to match the default would delete the key and make that choice unreachable.
    // Here it matters twice over — the default is CLIPPING, so nulling 'overflow' turned
    // 넘치기 into a second 자르기 instead of letting text run past its column.
    case 'wrap:overflow':
    case 'wrap:wrap':
    case 'wrap:clip': {
      applyStyleToSelection({ wrap: name.slice(5) }, '텍스트 줄바꿈');
      break;
    }

    case 'fmt:general':
      applyStyleToSelection({ fmt: 'general', decimals: null }, '숫자 서식');
      break;
    case 'fmt:number':
    case 'fmt:currency':
    case 'fmt:percent':
    case 'fmt:date':
    case 'fmt:time':
    case 'fmt:text':
      applyStyleToSelection({ fmt: name.slice(4) }, '숫자 서식');
      break;

    case 'decimals:inc': bumpDecimals(1); break;
    case 'decimals:dec': bumpDecimals(-1); break;

    case 'clear': clearSelection('내용 지우기'); break;

    case 'insertRowAbove': sendStructural({ kind: 'insertRow', index: b.r1, count: rowSpan }); break;
    case 'insertRowBelow': sendStructural({ kind: 'insertRow', index: b.r2 + 1, count: rowSpan }); break;
    case 'insertColLeft': sendStructural({ kind: 'insertCol', index: b.c1, count: colSpan }); break;
    case 'insertColRight': sendStructural({ kind: 'insertCol', index: b.c2 + 1, count: colSpan }); break;
    case 'deleteRow': sendStructural({ kind: 'deleteRow', index: b.r1, count: rowSpan }); break;
    case 'deleteCol': sendStructural({ kind: 'deleteCol', index: b.c1, count: colSpan }); break;

    case 'freeze:rows': toggleFreeze('rows', payload); break;
    case 'freeze:cols': toggleFreeze('cols', payload); break;

    // SPEC 25.4 — the two controls under the grid. They land in the very same path
    // the grid's own auto-grow takes, so there is exactly one place in this client
    // that can change a sheet's extent. Neither one records an undo entry.
    case 'grow:rows': growActiveSheet('rows', payload); break;
    case 'grow:cols': growActiveSheet('cols', payload); break;

    // All four go through runMerge(), the same function the grid's context menu
    // reaches through onMerge — one path, so the two menus cannot diverge.
    case 'merge:all':
    case 'merge:horizontal':
    case 'merge:vertical':
    case 'merge:none':
      runMerge(name.slice(6));
      break;

    // Tools, SPEC 23. Four of the five never touch cell data; 링크 writes one field
    // through the same funnel every other edit uses.
    case 'painter:toggle': togglePainter(payload); break;
    case 'print': runPrint(); break;
    case 'link:set': setActiveLink(payload); break;
    case 'link:clear': setActiveLink(null); break;

    // Data features, SPEC 24. The filter is a view and the chart list is geometry, so
    // both ride the `meta` frame; comments get their own frame because only the server
    // may say who wrote a message and when.
    case 'filter:on': turnFilterOn(); break;
    case 'filter:off': turnFilterOff(); break;
    case 'chart:add': addChartFromSelection(); break;
    case 'comment:add': openCommentPanel(sel.active); break;

    case 'export:csv':
      // The CSV endpoint exports ONE sheet: the one the user is looking at.
      window.location.href = '/api/docs/' + encodeURIComponent(state.docId) + '/csv'
        + '?sheet=' + encodeURIComponent(state.sheetId);
      break;

    case 'goto': gotoRef(payload); break;

    case 'formula:commit': {
      const text = payload == null ? '' : String(payload);
      let cur = '';
      try { cur = engine.getInput(sel.active) || ''; } catch (e) { cur = ''; }
      if (text === cur) break;
      commitLocalEdit(
        { [sel.active]: { input: text === '' ? null : text } },
        { label: '수식 입력' },
      );
      break;
    }

    case 'focusGrid':
      try { grid.focusCell(sel.active); } catch (e) { /* best effort */ }
      break;

    default: {
      const colon = name.indexOf(':');
      const head = colon > 0 ? name.slice(0, colon) : '';
      const tail = colon > 0 ? name.slice(colon + 1) : '';
      if (head === 'bg' || head === 'fg') {
        const hex = typeof payload === 'string' && payload ? payload : tail;
        const value = (hex === 'none' || hex === 'null' || !hex) ? null : String(hex).toLowerCase();
        applyStyleToSelection({ [head]: value }, head === 'bg' ? '배경색' : '글자색');
        break;
      }
      // SPEC 22.4 — the commands whose value is open-ended live here, beside the
      // colours, rather than being spelled out as dozens of switch labels.
      if (head === 'font') { applyFont(tail); break; }
      if (head === 'fontsize') {
        applyFontSize(typeof payload === 'number' ? payload : tail);
        break;
      }
      if (head === 'rotate') { applyRotation(tail); break; }
      if (head === 'border') { applyBorderToSelection(tail, payload); break; }
      // SPEC 23.2 / 23.5 — two more open-ended commands.
      if (head === 'zoom') {
        applyZoom(typeof payload === 'number' ? payload : tail);
        break;
      }
      if (head === 'fx') {
        // 'insert' names a function to start typing; 'more' is the toolbar telling us
        // it opened its own list, which needs nothing from here; anything else is one
        // of the five shortcuts.
        if (tail === 'insert') beginFunctionEdit(payload);
        else if (tail !== 'more') insertFunction(tail);
        break;
      }
      console.warn('[main] 알 수 없는 명령: ' + name);
    }
  }
}

// ----------------------------------------------------------- sheet command

/** Outstanding add/duplicate requests that still get to focus their new sheet. */
let pendingNewSheets = 0;
let pendingNewSheetsAt = 0;

function expectNewSheet() {
  pendingNewSheets += 1;
  pendingNewSheetsAt = Date.now();
}

function sendSheetOp(op, extra) {
  if (!net) return;
  const frame = { t: 'sheet', docId: state.docId, op };
  if (extra) Object.assign(frame, extra);
  sendTracked(frame);
  if (state.status !== 'online') toast('오프라인 상태입니다. 연결되면 반영됩니다.');
}

/**
 * SheetBar commands (SPEC section 17). Every one of them is a server round trip: the
 * server owns names, ordering and the "you may not delete the last sheet" rule, and
 * answers with the whole document, so nothing here mutates the sheet list optimistically.
 */
function handleSheetCommand(name, payload) {
  if (!state.doc) return;
  const p = payload || {};
  const sheetId = p.sheetId == null ? '' : String(p.sheetId);

  switch (name) {
    case 'select':
      if (sheetId && sheetId !== state.sheetId && sheetById(sheetId)) activateSheet(sheetId);
      break;

    case 'add':
      expectNewSheet();
      sendSheetOp('add', { afterId: p.afterId == null ? null : String(p.afterId) });
      break;

    case 'duplicate':
      if (!sheetById(sheetId)) break;
      expectNewSheet();
      sendSheetOp('duplicate', { sheetId });
      break;

    case 'rename': {
      const wanted = String(p.name == null ? '' : p.name).trim();
      const sheet = sheetById(sheetId);
      if (!sheet || !wanted || wanted === sheet.name) break;
      sendSheetOp('rename', { sheetId, name: wanted });
      break;
    }

    case 'delete':
      if (!sheetById(sheetId)) break;
      if (sheetsOf().length <= 1) {
        toast('마지막 시트는 삭제할 수 없습니다.', 'error');
        break;
      }
      sendSheetOp('delete', { sheetId });
      break;

    case 'reorder': {
      const index = Math.max(0, Math.min(sheetsOf().length - 1, Number(p.index) | 0));
      if (!sheetById(sheetId)) break;
      sendSheetOp('reorder', { sheetId, index });
      break;
    }

    case 'color': {
      if (!sheetById(sheetId)) break;
      const color = typeof p.color === 'string' && HEX_RE.test(p.color)
        ? p.color.toLowerCase() : null;
      sendSheetOp('color', { sheetId, color });
      break;
    }

    default:
      console.warn('[main] 알 수 없는 시트 명령: ' + name);
  }
}

// -------------------------------------------------------- document command

function refreshDocs() {
  if (!docsMenu) return Promise.resolve();
  docsMenu.setState({ currentId: state.docId, busy: true });
  return api('/api/docs').then(
    (list) => {
      if (!docsMenu) return;
      docsMenu.setState({
        docs: Array.isArray(list) ? list : [],
        currentId: state.docId,
        busy: false,
      });
    },
    (e) => {
      console.error('[main] 문서 목록을 불러오지 못했습니다', e);
      if (docsMenu) docsMenu.setState({ busy: false });
      toast('문서 목록을 불러오지 못했습니다.', 'error');
    },
  );
}

/** Leave for another document: the hash is the router, so a reload is the navigation. */
function openDocument(docId) {
  if (!docId || !ID_RE.test(docId) || docId === state.docId) return;
  flushEdits();
  try { if (net) net.close(); } catch (e) { /* leaving anyway */ }
  try { window.location.hash = '#doc=' + docId; }
  catch (e) { console.error('[main] 문서 이동 실패', e); }
  window.location.reload();
}

function createDocument() {
  if (docsMenu) docsMenu.setState({ busy: true });
  return api('/api/docs', { method: 'POST', body: JSON.stringify({ name: DEFAULT_DOC_NAME }) })
    .then((created) => {
      if (!created || !created.id) throw new Error('새 문서를 만들지 못했습니다.');
      openDocument(created.id);
    })
    .catch((e) => {
      console.error('[main] 새 문서를 만들지 못했습니다', e);
      if (docsMenu) docsMenu.setState({ busy: false });
      toast('새 문서를 만들지 못했습니다.', 'error');
    });
}

function renameDocument(docId, rawName) {
  if (!docId) return Promise.resolve();
  const name = String(rawName == null ? '' : rawName).trim() || DEFAULT_DOC_NAME;
  if (docId === state.docId) {
    // The open document is renamed over the socket so every viewer sees it at once.
    applyDocMeta({ name }, { send: true });
    return refreshDocs();
  }
  return api('/api/docs/' + encodeURIComponent(docId), {
    method: 'PATCH',
    body: JSON.stringify({ name }),
  }).then(
    () => refreshDocs(),
    (e) => {
      console.error('[main] 문서 이름을 바꾸지 못했습니다', e);
      toast('문서 이름을 바꾸지 못했습니다.', 'error');
    },
  );
}

function deleteDocument(docId) {
  if (!docId) return Promise.resolve();
  return api('/api/docs/' + encodeURIComponent(docId), { method: 'DELETE' }).then(
    () => {
      if (docId !== state.docId) {
        toast('문서를 삭제했습니다.');
        return refreshDocs();
      }
      // The document under our feet is gone. Nothing still in the outbox can ever be
      // saved to it, and keeping it would warn on every unload about a document that no
      // longer exists — so this is the one place discarding pending work is correct.
      if (saveOutbox) { try { saveOutbox.clear(); } catch (e) { /* memory-only */ } }
      paintSave();
      // Open the next document, or make a fresh one.
      return api('/api/docs').then((list) => {
        const next = (Array.isArray(list) ? list : []).find((d) => d && d.id && d.id !== docId);
        if (next) { openDocument(next.id); return undefined; }
        return api('/api/docs', {
          method: 'POST', body: JSON.stringify({ name: DEFAULT_DOC_NAME }),
        }).then((created) => {
          if (created && created.id) openDocument(created.id);
        });
      });
    },
    (e) => {
      console.error('[main] 문서를 삭제하지 못했습니다', e);
      toast('문서를 삭제하지 못했습니다.', 'error');
    },
  );
}

function handleDocsCommand(name, payload) {
  const p = payload || {};
  switch (name) {
    case 'refresh': refreshDocs(); break;
    case 'create': createDocument(); break;
    case 'open': openDocument(p.docId == null ? '' : String(p.docId)); break;
    case 'rename': renameDocument(p.docId == null ? '' : String(p.docId), p.name); break;
    case 'delete': deleteDocument(p.docId == null ? '' : String(p.docId)); break;
    default: console.warn('[main] 알 수 없는 문서 명령: ' + name);
  }
}

// ---------------------------------------------------------- net callbacks

function isErrorFrame(msg) {
  return !!msg && typeof msg === 'object' && msg.t === 'error';
}

function showServerError(msg) {
  // The server could not read this document (SPEC 27.6). A toast is the wrong shape for
  // it twice over: the refusal is permanent until the server is restarted, so a message
  // that fades away leaves the page looking usable, and every frame the outbox replays
  // would raise another one. The panel says it once and stops the socket.
  if (msg && msg.code === 'doc_unreadable') {
    renderUnreadable(msg);
    return;
  }
  const text = (msg && typeof msg.message === 'string' && msg.message)
    ? msg.message
    : '서버에서 오류가 발생했습니다.';
  toast(text, 'error');
}

/** The sheet a frame is about, falling back to the one on screen. */
function frameSheetId(payload) {
  const id = payload && payload.sheetId;
  return typeof id === 'string' && id ? id : state.sheetId;
}

/**
 * A full document resend after ANY sheet operation (SPEC section 11). Cells are
 * untouched by a sheet op, so every surviving sheet keeps its engine; only the sheet
 * LIST changes. Afterwards we may have to move: onto a sheet we just asked for, or
 * off one somebody else deleted.
 */
function onSheetsFrame(payload) {
  if (isErrorFrame(payload)) { showServerError(payload); return; }
  const doc = (payload && payload.doc) || payload;
  if (!doc || typeof doc !== 'object' || !Array.isArray(doc.sheets)) return;

  const before = sheetsOf().map((s) => s.id);
  const beforeIndex = before.indexOf(state.sheetId);
  const by = payload ? payload.by : undefined;

  adoptDoc(doc, { keepEngines: true });   // clears state.sheetId if it was deleted
  const rev = payload ? payload.rev : undefined;
  if (Number.isFinite(rev)) state.doc.rev = rev;

  const after = sheetsOf().map((s) => s.id);
  const added = after.filter((id) => before.indexOf(id) < 0);
  const mine = by == null || state.me.id == null || by === state.me.id;
  const fresh = Date.now() - pendingNewSheetsAt < NEW_SHEET_WINDOW_MS;

  let target = '';
  if (pendingNewSheets > 0 && mine && fresh && added.length) {
    // We asked for this sheet: land on it, the way Google Sheets does.
    pendingNewSheets -= 1;
    target = added[added.length - 1];
  } else if (!state.sheetId) {
    // The sheet on screen was deleted; the nearest survivor takes its place.
    const idx = Math.min(Math.max(beforeIndex, 0), after.length - 1);
    target = after[idx] || after[0] || '';
    if (target) toast('보고 있던 시트가 삭제되어 다른 시트로 이동했습니다.');
  }

  if (target || !state.sheetId) activateSheet(target);
  else { paintSheetBar(); refreshToolbar(); }
}

function onDocMetaFrame(payload) {
  if (isErrorFrame(payload)) { showServerError(payload); return; }
  const patch = (payload && payload.patch) || payload;
  if (!patch || typeof patch !== 'object') return;
  applyDocMeta(patch, {});
  const rev = payload ? payload.rev : undefined;
  if (Number.isFinite(rev) && state.doc) state.doc.rev = rev;
  if (docsMenu) docsMenu.setState({ currentId: state.docId });
}

const netHandlers = {
  onWelcome: (payload) => {
    if (isErrorFrame(payload)) { showServerError(payload); return; }
    noticeBuild(payload && payload.build);
    const doc = (payload && payload.doc) || payload;
    const you = payload && payload.you;
    if (you && typeof you === 'object') {
      state.me = {
        id: you.id != null ? you.id : state.me.id,
        name: you.name || state.me.name,
        color: you.color || state.me.color,
      };
    }
    // A reconnect adopts the server's document wholesale, so every engine is reloaded.
    const wanted = state.sheetId;
    adoptDoc(doc, {});
    const peers = payload && payload.peers;
    state.peers = Array.isArray(peers) ? peers.slice() : [];
    activateSheet(sheetById(wanted) ? wanted : state.sheetId, { repaint: true, announce: true });
    paintPeers();
    // SPEC 27.4 — after EVERY welcome, first connection and reconnect alike, everything
    // still unacknowledged goes back out in order. This runs after adoptDoc(), which has
    // just replaced the local document with the server's: the replay is what puts our
    // own unsaved work back on top of it.
    replayOutbox();
  },

  onEdit: (payload) => {
    if (isErrorFrame(payload)) { showServerError(payload); return; }
    const cells = (payload && payload.cells) || payload;
    if (!cells || typeof cells !== 'object') return;
    const sheetId = frameSheetId(payload);
    // An edit for a sheet nobody is looking at is applied all the same: switching to
    // that tab must show current data without a refetch.
    const ctx = ctxOf(sheetId);
    if (!ctx) return;
    const by = payload ? payload.by : undefined;
    const mine = state.me.id != null && by === state.me.id;
    // Skip the echo only when the engine genuinely already agrees — see engineAgrees().
    // Trusting `mine` alone loses every edit made while the socket was down.
    const changed = (mine && engineAgrees(cells, ctx)) ? null : applyToEngine(cells, ctx);
    applyPatchToModel(cells, ctx);          // the mirror always tracks the server
    // The mirror is updated FIRST: a cell's link lives there rather than in the
    // engine, so repainting before this line would draw a remote link change from
    // stale data and only pick it up on some later, unrelated repaint.
    if (changed && sheetId === state.sheetId) safeRefresh(changed);
    invalidateFilterView(sheetId);          // a peer's write can change what a filter shows
    const rev = payload ? payload.rev : undefined;
    if (Number.isFinite(rev) && state.doc) state.doc.rev = rev;
    if (sheetId === state.sheetId) refreshToolbar();
  },

  onStruct: (payload) => {
    if (isErrorFrame(payload)) { showServerError(payload); return; }
    const doc = (payload && payload.doc) || payload;
    if (!doc || typeof doc !== 'object') return;
    adoptDoc(doc, {});
    const rev = payload ? payload.rev : undefined;
    if (Number.isFinite(rev)) state.doc.rev = rev;
    activateSheet(state.sheetId, { repaint: true });
    // Reference rewriting invalidates recorded inverse patches.
    history.clear();
  },

  onMeta: (payload) => {
    if (isErrorFrame(payload)) { showServerError(payload); return; }
    const patch = (payload && payload.patch) || payload;
    if (!patch || typeof patch !== 'object') return;
    // Our own echo needs no repaint: the change is already on screen.
    const mine = state.me.id != null && payload && payload.by === state.me.id;
    if (typeof patch.name === 'string') applyDocMeta({ name: patch.name }, {});
    const frameSheet = frameSheetId(payload);
    applySheetMeta(frameSheet, patch, { rerender: !mine });
    // A meta frame is how a merge list travels (SPEC 21.3), and whether the selection
    // contains a merge decides the toolbar button's label. Repainting the grid alone
    // would leave that button showing 셀 병합 over an already-merged range until the
    // local user happened to move the cursor.
    if (!mine && Array.isArray(patch.merges) && frameSheet === state.sheetId) refreshToolbar();
    // The filter view and the chart list travel on this frame too (SPEC 24.1 / 24.2).
    // Both change what the toolbar's buttons say, and a peer editing the chart we have
    // open must be visible in the panel rather than only in the overlay.
    if (frameSheet === state.sheetId && ('filter' in patch || Array.isArray(patch.charts))) {
      if ('filter' in patch) renderFilterPanel();
      if (Array.isArray(patch.charts)) renderChartPanel();
      refreshToolbar();
    }
    const rev = payload ? payload.rev : undefined;
    if (Number.isFinite(rev) && state.doc) state.doc.rev = rev;
  },

  onSheets: onSheetsFrame,
  onDocMeta: onDocMetaFrame,
  // SPEC 24.3 — declared so a Net that learns to dispatch the frame reaches the same
  // handler installFrameBridge() routes it to today.
  onComments: onCommentsFrame,

  onPeers: (payload) => {
    const peers = Array.isArray(payload) ? payload : (payload && payload.peers);
    state.peers = Array.isArray(peers) ? peers.slice() : [];
    paintPeers();
  },

  onCursor: (msg) => {
    if (!msg || !msg.id) return;
    const found = state.peers.find((p) => p && p.id === msg.id);
    if (found) {
      found.active = msg.active;
      found.range = msg.range;
      if (typeof msg.sheetId === 'string') found.sheetId = msg.sheetId;
    } else {
      state.peers.push({
        id: msg.id,
        name: msg.name || '',
        color: msg.color || colorForId(msg.id),
        sheetId: typeof msg.sheetId === 'string' ? msg.sheetId : '',
        active: msg.active,
        range: msg.range,
      });
    }
    paintPeers();
  },

  onStatus: (status) => setStatus(status),

  // SPEC 27.3 — {t:'ack', opId, rev}. The operation's journal line is on disk, so the
  // frame may finally leave the outbox. Nothing else in the app is allowed to drop one.
  onAck: (msg) => onAckFrame(msg),

  onError: (msg) => {
    // A refusal is final unless the server says otherwise. `retry: true` marks the one
    // recoverable case — the disk write failed and the operation is still valid — and
    // everything else the server will never accept: a frame for a deleted sheet, a sheet
    // op past the limit, a malformed payload. Keeping those in the outbox would replay
    // them after every reconnect for ever, pin the save indicator at 저장 중… so it could
    // never honestly read 저장됨, and warn on every attempt to close the tab.
    //
    // A document the server could not READ is the one refusal that must never drop the
    // frame, whatever else the message says (SPEC 27.6). The edit is valid; it simply has
    // nowhere durable to go until the server restarts, and it is still the only copy. The
    // server sends `retry: true` for exactly this reason, and the code is tested as well
    // so that a server that forgot the flag cannot turn the guard against losing
    // acknowledged work into a way of losing unacknowledged work.
    const unreadable = !!(msg && msg.code === 'doc_unreadable');
    const opId = msg && typeof msg.opId === 'string' ? msg.opId : null;
    if (opId && saveOutbox && !(msg && msg.retry) && !unreadable) {
      try { saveOutbox.ack(opId); } catch (e) { /* the toast below still reports it */ }
      paintSave();
    }
    showServerError(msg);
  },
};

/**
 * Net dispatches the frame types its own handler set names. 'sheets' and 'docmeta'
 * arrived with multi-sheet documents and are routed here, ahead of that dispatch, so
 * they reach the app whether or not the socket layer knows about them yet. Handlers
 * are also declared above, so a Net that does dispatch them behaves identically —
 * the frame is handled exactly once either way, because this hook returns instead of
 * falling through.
 *
 * SPEC 24.3's `{t:'comments'}` frame joins them on exactly the same terms: it is
 * handled here and RETURNS, so it reaches the app whether or not the socket layer has
 * learned the frame type, and it can never be handled twice.
 *
 * @param {object} socket the Net instance
 */
function installFrameBridge(socket) {
  if (!socket || typeof socket._dispatch !== 'function') return;
  const inner = socket._dispatch.bind(socket);
  socket._dispatch = (msg) => {
    if (msg && msg.t === 'comments') { onCommentsFrame(msg); return; }
    inner(msg);
  };
}

// ---------------------------------------------------------------- the shell

/**
 * Find (or, for anything index.html does not supply, create) the shell nodes.
 * The selector lists lead with the ids public/index.html actually uses and keep
 * generic fallbacks so a stripped host page still boots.
 */
function buildShell() {
  const shell = {};

  shell.header = pick(['.sz-header', '#header', 'header', '#app-header']);
  if (!shell.header) {
    shell.header = el('header', 'sz-header');
    document.body.insertBefore(shell.header, document.body.firstChild);
  }

  // Document name.
  shell.docName = pick(['#sz-docname', '.sz-docname', '#doc-name', '[data-doc-name]']);
  if (!shell.docName) {
    const input = el('input', 'sz-docname');
    input.type = 'text';
    input.title = '문서 이름';
    input.setAttribute('aria-label', '문서 이름');
    input.autocomplete = 'off';
    shell.header.appendChild(input);
    shell.docName = input;
  }
  if (shell.docName.tagName === 'INPUT' || shell.docName.tagName === 'TEXTAREA') {
    shell.docName.addEventListener('change', () => {
      const name = shell.docName.value.trim() || DEFAULT_DOC_NAME;
      shell.docName.value = name;
      applyDocMeta({ name }, { send: true });
    });
    shell.docName.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') shell.docName.blur();
      ev.stopPropagation();
    });
  }

  // Peers (presence.js paints into this container).
  shell.peers = pick(['#sz-peers', '.sz-peers', '#peers', '[data-peers]']);
  if (!shell.peers) {
    shell.peers = el('div', 'sz-peers');
    shell.header.appendChild(shell.peers);
  }

  // Connection indicator.
  shell.status = pick(['#sz-status', '.sz-status', '#status', '[data-status]']);
  if (!shell.status) {
    shell.status = el('div', 'sz-status');
    shell.header.appendChild(shell.status);
  }

  // Save indicator (SPEC 27.5). It sits beside the connection indicator because the two
  // answer different questions — "is my work safe?" and "am I connected?" — and a person
  // reading one immediately wants the other. Its text is written ONLY by paintSave().
  shell.save = pick(['#sz-save', '.sz-save', '[data-save]']);
  if (!shell.save) {
    const node = el('div', 'sz-save');
    node.id = 'sz-save';
    node.setAttribute('role', 'status');
    node.setAttribute('aria-live', 'polite');
    // Two properties only, and only on a node this file created: a count that changes
    // must not make the header jitter, and the phrase must not wrap mid-word. A host
    // page that supplies its own #sz-save keeps its own styling untouched.
    node.style.whiteSpace = 'nowrap';
    node.style.fontVariantNumeric = 'tabular-nums';
    let placed = false;
    if (shell.status && shell.status.parentNode) {
      try { shell.status.parentNode.insertBefore(node, shell.status); placed = true; }
      catch (e) { placed = false; }
    }
    if (!placed) shell.header.appendChild(node);
    shell.save = node;
  }

  // Header actions supplied by index.html (공유 / CSV 내보내기).
  shell.actions = pick(['.sz-actions', '#sz-actions']);

  // SPEC 28.5 — the 로그아웃 button is NOT created here. It exists only once
  // GET /api/version reports the gate is on (showLogout), so a password-less
  // deployment has no button rather than a hidden one. A host page that supplies its
  // own is adopted and wired, and stays hidden until that same answer arrives.
  shell.logout = pick(['#sz-logout', '.sz-logout']);
  if (shell.logout) {
    shell.logout.hidden = true;
    shell.logout.style.display = 'none';
    shell.logout.addEventListener('click', (ev) => { ev.preventDefault(); logout(); });
  }
  for (const btn of document.querySelectorAll('[data-action]')) {
    const action = btn.getAttribute('data-action');
    btn.addEventListener('click', (ev) => {
      ev.preventDefault();
      if (action === 'share') shareLink();
      else handleCommand(action);
    });
  }

  // Documents menu root (docsmenu.js owns everything inside it).
  shell.docsRoot = pick(['#sz-docs-root', '.sz-docs-root']);
  if (!shell.docsRoot) {
    shell.docsRoot = el('div', 'sz-docs');
    shell.docsRoot.id = 'sz-docs-root';
    if (shell.actions) shell.actions.insertBefore(shell.docsRoot, shell.actions.firstChild);
    else shell.header.appendChild(shell.docsRoot);
  }

  // Rename control for the display name — index.html has no equivalent.
  shell.rename = pick(['#sz-rename', '[data-rename]', '.sz-rename', '#rename']);
  if (!shell.rename) {
    shell.rename = el('button', 'sz-btn sz-rename', '이름 변경');
    shell.rename.type = 'button';
    shell.rename.id = 'sz-rename';
    if (shell.actions) shell.actions.insertBefore(shell.rename, shell.actions.firstChild);
    else shell.header.appendChild(shell.rename);
  }
  shell.rename.title = '표시 이름 변경';
  shell.rename.addEventListener('click', renameMe);

  // Toolbar root.
  shell.toolbarRoot = pick(['#sz-toolbar-root', '#toolbar', '#toolbar-root', '[data-toolbar]']);
  if (!shell.toolbarRoot) {
    shell.toolbarRoot = el('div', 'sz-toolbar-root');
    shell.toolbarRoot.id = 'sz-toolbar-root';
    if (shell.header.nextSibling) {
      shell.header.parentNode.insertBefore(shell.toolbarRoot, shell.header.nextSibling);
    } else {
      shell.header.parentNode.appendChild(shell.toolbarRoot);
    }
  }

  // Grid root. A container that also holds the toolbar (e.g. a bare <main>) is
  // used as the parent of a fresh grid element rather than as the grid itself.
  const found = pick(['#sz-grid-root', '.sz-grid', '#grid', '#grid-root', '[data-grid]', 'main']);
  const usable = found && found !== shell.toolbarRoot && !found.contains(shell.toolbarRoot);
  if (usable) {
    shell.gridRoot = found;
  } else {
    const node = el('div', 'sz-grid sz-grid-root');
    node.id = 'sz-grid-root';
    (found || document.body).appendChild(node);
    shell.gridRoot = node;
  }

  // Sheet tab strip root: between the grid and the status bar (SPEC section 17).
  shell.sheetbarRoot = pick(['#sz-sheetbar-root', '.sz-sheetbar-root']);
  if (!shell.sheetbarRoot) {
    shell.sheetbarRoot = el('div', 'sz-sheetbar');
    shell.sheetbarRoot.id = 'sz-sheetbar-root';
    const host = shell.gridRoot.parentNode || document.body;
    if (shell.gridRoot.nextSibling) host.insertBefore(shell.sheetbarRoot, shell.gridRoot.nextSibling);
    else host.appendChild(shell.sheetbarRoot);
  }

  // Grow controls root: below the grid, beside the sheet bar (SPEC 25.4). It is a
  // row of its own rather than a group in the toolbar, because it changes the sheet
  // you are looking at, not the cells you have selected.
  shell.growRoot = pick(['#sz-grow-root', '.sz-grow-root', '.sz-grow']);
  if (!shell.growRoot) {
    shell.growRoot = el('div', 'sz-grow');
    shell.growRoot.id = 'sz-grow-root';
    const host = shell.sheetbarRoot.parentNode || document.body;
    if (shell.sheetbarRoot.nextSibling) {
      host.insertBefore(shell.growRoot, shell.sheetbarRoot.nextSibling);
    } else {
      host.appendChild(shell.growRoot);
    }
  }

  // Selection readout in the status bar.
  shell.selStats = pick(['#sz-selstats', '.sz-selstats']);

  // The sheet's extent, next to that readout (SPEC 25.4). index.html supplies no such
  // element, so it is created here — with the one layout property that keeps it beside
  // the selection readout in a `justify-content: space-between` bar instead of drifting
  // to the middle of it. A host page that does supply the element keeps its own styling.
  shell.extent = pick(['#sz-extent', '.sz-extent']);
  if (!shell.extent && shell.selStats && shell.selStats.parentNode) {
    const node = el('span', 'sz-extent');
    node.id = 'sz-extent';
    node.title = '시트 크기 (행 x 열)';
    node.style.marginRight = 'auto';
    node.style.fontVariantNumeric = 'tabular-nums';
    shell.selStats.parentNode.insertBefore(node, shell.selStats.nextSibling);
    shell.extent = node;
  }

  // Toast host.
  shell.toasts = pick(['#sz-toasts', '.sz-toasts']);
  if (!shell.toasts) {
    shell.toasts = el('div', 'sz-toasts');
    shell.toasts.id = 'sz-toasts';
    document.body.appendChild(shell.toasts);
  }

  return shell;
}

/** 공유: copy this document's URL to the clipboard. */
function shareLink() {
  const url = window.location.href;
  const done = () => toast('문서 링크를 복사했습니다.', 'ok');
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(url).then(done, () => toast('링크: ' + url));
      return;
    }
  } catch (e) { /* fall through to the manual path */ }
  toast('링크: ' + url);
}

function renameMe() {
  const current = state.me.name || DEFAULT_NAME;
  const answer = window.prompt('표시할 이름을 입력하세요.', current);
  if (answer === null) return;
  const name = answer.trim() || DEFAULT_NAME;
  lsSet(NAME_KEY, name);
  state.me.name = name;
  const self = state.peers.find((p) => p && p.id === state.me.id);
  if (self) self.name = name;
  paintPeers();
  if (net) {
    net.name = name;                        // future reconnects use the new name
    try { net.send({ t: 'hello', docId: state.docId, name, color: state.me.color }); }
    catch (e) { console.error('[main] 이름 변경 전송 실패', e); }
  }
  toast('표시 이름을 "' + name + '"(으)로 바꿨습니다.');
}

/** True when this browser had no stored name, so we can invite a rename after boot. */
let isFirstVisit = false;

function resolveName() {
  const stored = lsGet(NAME_KEY);
  if (typeof stored === 'string' && stored.trim()) return stored.trim();
  // Deliberately NOT window.prompt(): a native modal here runs before the grid has
  // painted and blocks the renderer thread until it is dismissed, so the app appears
  // frozen behind a system dialog. Browsers that suppress dialogs (embedded views,
  // "prevent additional dialogs") would hang the page outright. Start immediately
  // with a default and invite the rename from the header once the UI is up.
  isFirstVisit = true;
  lsSet(NAME_KEY, DEFAULT_NAME);
  return DEFAULT_NAME;
}

function resolveUid() {
  let uid = lsGet(UID_KEY);
  if (typeof uid === 'string' && uid) return uid;
  uid = Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
  lsSet(UID_KEY, uid);
  return uid;
}

// ------------------------------------------------------------- doc routing

/** The hash carries BOTH ids: #doc=<docId>&sheet=<sheetId>. */
function readHash() {
  const hash = window.location.hash || '';
  const doc = /(?:^#|[#&])doc=([A-Za-z0-9_-]{1,64})/.exec(hash);
  const sheet = /(?:^#|[#&])sheet=([A-Za-z0-9_-]{1,64})/.exec(hash);
  return { docId: doc ? doc[1] : '', sheetId: sheet ? sheet[1] : '' };
}

function writeHash(docId, sheetId) {
  if (!docId) return;
  const want = '#doc=' + docId + (sheetId ? '&sheet=' + sheetId : '');
  if (window.location.hash === want) return;
  // replaceState never fires hashchange, so this cannot bounce us into a reload.
  try { window.history.replaceState(null, '', window.location.pathname + window.location.search + want); }
  catch (e) { window.location.hash = want; }
}

async function resolveDoc(preferredId) {
  if (preferredId) {
    try {
      const doc = await api('/api/docs/' + encodeURIComponent(preferredId));
      if (doc && doc.id) return doc;
    } catch (e) {
      // A document the server could not READ is where this function STOPS (SPEC 27.6).
      // Every line below it is a fallback — open something else, and failing that create
      // something new — and running them here is precisely the damage: the person asked
      // for a document that exists and is intact, and would be handed a different one, or
      // a brand-new empty one, with no indication that theirs is still sitting on the
      // disk. The failure is rethrown so boot() shows the explanation instead.
      if (isUnreadableError(e)) throw e;
      console.warn('[main] 해시의 문서를 열지 못했습니다: ' + preferredId, e);
    }
  }
  let list = [];
  try { list = await api('/api/docs'); } catch (e) { list = []; }
  // The server lists a quarantined document rather than hiding it, so this page has to
  // skip it deliberately: opening one would 503, and it must never be the document a
  // visitor with no hash silently lands in.
  const openable = Array.isArray(list) ? list.filter((d) => d && d.id && !d.unreadable) : [];
  if (openable.length) {
    try {
      const doc = await api('/api/docs/' + encodeURIComponent(openable[0].id));
      if (doc && doc.id) return doc;
    } catch (e) {
      if (isUnreadableError(e)) throw e;
      console.warn('[main] 최근 문서를 열지 못했습니다', e);
    }
  }
  // Nothing openable, and every document there IS is one the server could not read. A new
  // document here would be the visible result of an invisible failure: the list would fill
  // up with empty spreadsheets, one per visit, while the real ones stayed unread. Say what
  // happened instead.
  if (!openable.length && Array.isArray(list) && list.some((d) => d && d.unreadable)) {
    const err = new Error(UNREADABLE_FALLBACK.message);
    err.code = 'doc_unreadable';
    err.status = 503;
    throw err;
  }
  const created = await api('/api/docs', {
    method: 'POST',
    body: JSON.stringify({ name: DEFAULT_DOC_NAME }),
  });
  if (!created || !created.id) throw new Error('새 문서를 만들지 못했습니다.');
  return created;
}

// ------------------------------------------------------------- global keys

function onGlobalKeydown(ev) {
  if (foreignInput(ev.target)) return;     // the cell editor / formula bar own these
  // Escape gives up the format painter (SPEC 23.1). It carries no modifier, so it is
  // checked before the test below, and it is only consumed while the painter is
  // actually armed — the grid keeps its own Escape for cancelling an edit.
  if ((ev.key === 'Escape' || ev.key === 'Esc') && painter.on) {
    disarmPainter();
    return;
  }
  const mod = ev.ctrlKey || ev.metaKey;
  if (!mod) return;
  const key = (ev.key || '').toLowerCase();

  if (key === 'z' && !ev.shiftKey) {
    ev.preventDefault();
    handleCommand('undo');
  } else if ((key === 'z' && ev.shiftKey) || key === 'y') {
    ev.preventDefault();
    handleCommand('redo');
  } else if (key === 'b') {
    ev.preventDefault();
    handleCommand('bold');
  } else if (key === 'i') {
    ev.preventDefault();
    handleCommand('italic');
  } else if (key === 'u') {
    ev.preventDefault();
    handleCommand('underline');
  } else if (key === 's') {
    ev.preventDefault();
    toast('변경 사항은 자동으로 저장됩니다.');
  }
}

// ------------------------------------------------------------------- fatal

/**
 * The document could not be READ, so the server refused to open it (SPEC 27.6).
 *
 * A different panel from renderFatal on purpose. This is not a crash and it is not the
 * user's data being damaged — it is the server declining to touch a file it could not see,
 * which is the behaviour that KEEPS the data — so the panel says that in Korean, in the
 * order somebody frightened about their work needs to hear it, and shows no path, no
 * errno and no stack. The operator gets those in the server log, where they are useful.
 */
function renderUnreadable(source) {
  if (authRedirecting) return;
  if (unreadableShown) return;
  unreadableShown = true;
  const text = unreadableTextOf(source);
  console.error('[main] 문서를 읽지 못해 열 수 없습니다', source);

  // Nothing on this page can save anything from here on, so the socket is stopped rather
  // than left reconnecting into the same refusal. The outbox is untouched: whatever it is
  // holding stays in localStorage and replays after the server is restarted (SPEC 27.4).
  try { if (net) net.close(); } catch (e) { /* never connected */ }

  const panel = el('div', 'sz-fatal sz-unreadable');
  panel.style.cssText =
    'position:fixed;inset:0;z-index:2147483002;display:flex;align-items:center;' +
    'justify-content:center;padding:24px;background:#fff;color:#202124;' +
    "font-family:'Pretendard','Apple SD Gothic Neo','Malgun Gothic','Segoe UI',system-ui,sans-serif";
  const card = el('div');
  card.style.cssText = 'max-width:600px;width:100%;border:1px solid #dadce0;border-radius:12px;padding:24px';

  const h = el('h1', null, text.message);
  h.style.cssText = 'margin:0 0 14px;font-size:19px;line-height:1.5';

  // The reassurance is first and it is the loudest thing on the panel, because it is the
  // question the person actually has.
  const safe = el('p', null, text.steps[0] || UNREADABLE_FALLBACK.steps[0]);
  safe.style.cssText =
    'margin:0 0 16px;padding:12px 14px;border-radius:8px;background:#e6f4ea;color:#137333;' +
    'font-size:14px;line-height:1.6;font-weight:600';

  const list = el('ul');
  list.style.cssText = 'margin:0 0 20px;padding-left:20px;font-size:14px;line-height:1.8;color:#3c4043';
  for (let i = 1; i < text.steps.length; i++) {
    list.appendChild(el('li', null, text.steps[i]));
  }

  const row = el('div');
  row.style.cssText = 'display:flex;gap:8px;flex-wrap:wrap';
  const retry = el('button', null, '다시 시도');
  retry.type = 'button';
  retry.style.cssText =
    'padding:8px 16px;border:0;border-radius:6px;background:#1a73e8;color:#fff;' +
    'font-size:14px;cursor:pointer';
  retry.addEventListener('click', () => window.location.reload());
  const home = el('a', null, '내 문서 목록으로');
  home.href = '/';
  home.style.cssText =
    'padding:8px 16px;border:1px solid #dadce0;border-radius:6px;color:#3c4043;' +
    'font-size:14px;text-decoration:none;line-height:normal;display:inline-flex;align-items:center';
  row.appendChild(retry);
  row.appendChild(home);

  card.appendChild(h);
  card.appendChild(safe);
  if (list.childNodes.length) card.appendChild(list);
  card.appendChild(row);
  panel.appendChild(card);
  document.body.appendChild(panel);
}

function renderFatal(error) {
  // A boot that failed because the session expired is already on its way to the login
  // page (SPEC 28.3); a fatal panel over the top of that would blame the wrong thing.
  if (authRedirecting) return;
  // A document the server could not read is not a failure to start; it is a refusal with
  // a reason, and it gets the panel that explains the reason (SPEC 27.6). The generic
  // panel's "잠시 후 다시 시도해 주세요" would be false — no amount of retrying changes it
  // — and its stack-trace box would tell somebody their spreadsheet is broken when the
  // whole point of the refusal is that it is not.
  if (isUnreadableError(error) || (error && error.code === 'doc_unreadable')) {
    renderUnreadable(error && error.body ? error.body : error);
    return;
  }
  console.error('[main] 시작 실패', error);
  const panel = el('div', 'sz-fatal');
  panel.style.cssText =
    'position:fixed;inset:0;z-index:2147483002;display:flex;align-items:center;' +
    'justify-content:center;padding:24px;background:#fff;color:#202124;' +
    "font-family:'Pretendard','Apple SD Gothic Neo','Malgun Gothic','Segoe UI',system-ui,sans-serif";
  const card = el('div');
  card.style.cssText = 'max-width:560px;width:100%;border:1px solid #dadce0;border-radius:12px;padding:24px';

  const h = el('h1', null, '시트지를 시작하지 못했습니다');
  h.style.cssText = 'margin:0 0 10px;font-size:18px';
  const p = el('p', null, '서버에 연결하거나 문서를 여는 중 문제가 발생했습니다. 잠시 후 다시 시도해 주세요.');
  p.style.cssText = 'margin:0 0 14px;font-size:14px;line-height:1.6;color:#5f6368';
  const detail = el('pre', null, String((error && error.message) || error || '알 수 없는 오류'));
  detail.style.cssText =
    'margin:0 0 18px;padding:10px 12px;border-radius:8px;background:#f1f3f4;color:#3c4043;' +
    'font-size:12px;white-space:pre-wrap;word-break:break-word';
  const retry = el('button', null, '다시 시도');
  retry.type = 'button';
  retry.style.cssText =
    'padding:8px 16px;border:0;border-radius:6px;background:#1a73e8;color:#fff;' +
    'font-size:14px;cursor:pointer';
  retry.addEventListener('click', () => window.location.reload());

  card.appendChild(h);
  card.appendChild(p);
  card.appendChild(detail);
  card.appendChild(retry);
  panel.appendChild(card);
  document.body.appendChild(panel);
}

// ---------------------------------------------------------------- bootstrap

async function boot() {
  ui = buildShell();
  setStatus('connecting');

  state.me.name = resolveName();
  state.me.color = colorForId(resolveUid());

  const wanted = readHash();
  const fetched = await resolveDoc(wanted.docId);
  state.doc = normalizeDoc(fetched);
  state.docId = state.doc.id;

  // The outbox is built BEFORE the grid, the toolbar or the socket exist, because from
  // this line on every mutation has to have somewhere durable to land (SPEC 27.4). It
  // may already be holding work an earlier tab could not send; replayOutbox() puts that
  // back on the wire after the first `welcome`.
  makeOutbox(state.docId);
  paintSave();

  // An unknown sheet id in the hash falls back to the first sheet — and the hash is
  // rewritten, so a stale link stops lying about where the user is.
  const first = firstSheet();
  state.sheetId = (wanted.sheetId && sheetById(wanted.sheetId))
    ? wanted.sheetId
    : (first ? first.id : '');
  writeHash(state.docId, state.sheetId);
  setDocTitle(state.doc.name);

  const ctx = ctxOf(state.sheetId);
  engine = ctx ? ctx.engine : new SheetEngine({});

  // The zoom this viewer last chose (SPEC 23.2). Read before the grid exists so the
  // first layout is already at the right scale rather than jumping after it.
  zoomFactor = toZoomFactor(lsGet(ZOOM_KEY));

  grid = new Grid(ui.gridRoot, {
    engine,
    sheet: activeSheet(),
    onEdit: (cellsPatch) => commitLocalEdit(cellsPatch, { alreadyApplied: true, label: '셀 편집' }),
    onCursor: (sel, settled) => {
      // An armed format painter claims the new selection before anything else looks
      // at it (SPEC 23.1); with no painter armed this costs one boolean test.
      //
      // Only a SETTLED selection counts. The grid emits the 1x1 anchor the moment the
      // button goes down and again for every step of a drag; painting on those would
      // stamp the anchor cell and disarm before the user finished drawing the range,
      // and in sticky mode would commit one undo entry per mousemove.
      if (settled !== false) applyPainterToSelection();
      sendCursor(false);
      refreshToolbar();
    },
    onStructural: (edit) => sendStructural(edit),
    onMeta: (patch) => applySheetMeta(state.sheetId, patch, { send: true }),
    // The context menu's 셀 병합 / 병합 해제 land in the very same function the
    // toolbar commands do (SPEC 21.4 / 21.5).
    onMerge: (mode, rect) => runMerge(mode, rect),
    onNotice: (message, tone) => toast(message, tone),
    // Data features, SPEC 24: the filter glyph on a header cell, a chart that was
    // dragged or resized, and the comment marker on a cell.
    onFilterMenu: (info, anchor) => openFilterPanel(info, anchor),
    onChartChange: (a, b) => persistChartGeometry(a, b),
    onCommentOpen: (info) => openCommentPanel(info),
  });
  // The grid reads these off the instance when it calls them, so assigning them here
  // wires them whether or not its constructor knows the option names yet.
  grid.onFilterMenu = (info, anchor) => openFilterPanel(info, anchor);
  grid.onChartChange = (a, b) => persistChartGeometry(a, b);
  grid.onCommentOpen = (info) => openCommentPanel(info);
  // A debug handle. A spreadsheet's rendering bugs are all about internal geometry —
  // the row view, the cumulative offsets, the merge index — and none of it is visible
  // from the DOM. This costs one property and makes those answerable from the console.
  try { window.__szgrid = grid; } catch (e) { /* non-browser host */ }
  applyZoomToGrid();                      // before the first paint, not after it
  try { grid.render(); } catch (e) { console.error('[main] 첫 렌더 실패', e); }

  toolbar = new Toolbar(ui.toolbarRoot, { onCommand: handleCommand });
  paintToolbar();

  sheetbar = new SheetBar(ui.sheetbarRoot, { onCommand: handleSheetCommand });
  paintSheetBar();

  // 시트 늘리기 (SPEC 25.4). Its two commands go to handleCommand like every other
  // command in the app, so growing is wired exactly the way 굵게 is.
  growBar = new GrowBar(ui.growRoot, { onCommand: handleCommand });
  paintGrowState();

  docsMenu = new DocsMenu(ui.docsRoot, { onCommand: handleDocsCommand });
  docsMenu.setState({ docs: [], currentId: state.docId, busy: false });

  net = new Net({
    docId: state.docId,
    name: state.me.name,
    color: state.me.color,
    handlers: netHandlers,
  });
  installFrameBridge(net);                // SPEC 24.3 — route {t:'comments'}
  net.connect();

  // SPEC 28.5 — is the gate on? Deliberately not awaited: nothing below depends on the
  // answer, and the only thing it decides is whether a 로그아웃 button exists.
  refreshAuthMode();

  document.addEventListener('copy', (ev) => onCopyLike(ev, false));
  document.addEventListener('cut', (ev) => onCopyLike(ev, true));
  document.addEventListener('paste', onPasteEvent);
  document.addEventListener('keydown', onGlobalKeydown);

  window.addEventListener('hashchange', () => {
    const h = readHash();
    if (h.docId && h.docId !== state.docId) { window.location.reload(); return; }
    if (h.sheetId && h.sheetId !== state.sheetId && sheetById(h.sheetId)) activateSheet(h.sheetId);
  });
  window.addEventListener('beforeunload', (ev) => {
    // The 60 ms coalescer first: it is the only place an edit lives in memory alone, and
    // flushing it moves those cells into the outbox synchronously, before anything below
    // asks how much is pending.
    flushEdits();
    // SPEC 27.5 — the ONE exception the spec writes into the beforeunload rule, and it is
    // spelled out there for exactly this reason: read without it, the line below looks
    // like a bug. A deliberate trip to the login page is not an accidental close. The
    // coalescer has just been flushed into the outbox, and a persisted outbox replays
    // after the next welcome (27.4), so nothing is lost by leaving. Warning here would
    // offer a "stay" that leads back to a page which can no longer save anything. When the
    // outbox CANNOT persist, the warning stands: that is the one case where leaving really
    // does cost the work, which is why the test is "redirecting AND persisting".
    if (authRedirecting && outboxPersists()) return undefined;
    const pending = outboxSize();
    if (pending > 0) {
      // SPEC 27.5 — leaving with unsent work asks first. The socket is deliberately left
      // open: if the user cancels, closing it here would strand the page offline with no
      // reconnect, which would turn a warning into the very loss it warns about.
      const message = '저장되지 않은 변경 ' + pending + '건이 남아 있습니다. 페이지를 떠나시겠습니까?';
      ev.preventDefault();
      ev.returnValue = message;    // older browsers show this text; newer ones show their own
      return message;
    }
    try { if (net) net.close(); } catch (e) { /* leaving anyway */ }
    return undefined;
  });

  // First visit on this browser: the name defaulted silently, so point at the rename
  // control instead of interrupting the load with a dialog.
  if (isFirstVisit) {
    setTimeout(() => toast('오른쪽 위의 이름을 눌러 표시 이름을 바꿀 수 있습니다.'), 1200);
  }
}

function start() {
  boot().catch((error) => {
    try { renderFatal(error); } catch (e) { console.error(e); }
  });
}

try {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start, { once: true });
  } else {
    start();
  }
} catch (error) {
  renderFatal(error);
}
