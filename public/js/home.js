// home.js — the document list at the site root (SPEC section 20).
//
// This page is deliberately independent of the editor: it loads no engine, opens no
// WebSocket and imports nothing from main.js, so it stays fast and cannot be broken by
// a change in the editor's wiring. It talks to the REST API only.
//
// Classes it owns (styled in style.css §19):
//   .sz-home-grid   .sz-home-card   .sz-home-card-new   .sz-home-card-name
//   .sz-home-card-meta   .sz-home-card-menu   .sz-home-rename   .sz-home-confirm
//   .sz-home-empty   .sz-home-error
// And, for a document the server could not read (SPEC 27.6) — these carry their own
// inline styles as well, so the card is legible even against a stylesheet that has never
// heard of them:
//   .sz-home-unreadable-note        the one-line notice above the cards
//   .sz-home-card-unreadable        the card itself (a div, never a link)
//   .sz-home-card-unreadable-head   the button that unfolds the explanation
//   .sz-home-card-unreadable-badge  the 지금은 열 수 없음 marker
//   .sz-home-card-unreadable-detail the explanation

import { onNextFrame } from './schedule.js';

// ---------------------------------------------------------------------------
// URL compatibility — must run before anything else.
//
// '/#doc=<id>' links were handed out before this page existed. The hash never reaches
// the server, so the redirect has to happen here. `replace` rather than `href` keeps
// the bounce out of the back-button history: pressing Back from the editor should
// return to wherever the user actually came from, not re-trigger this redirect.
// ---------------------------------------------------------------------------
{
  const m = /(?:^#|[#&])doc=([A-Za-z0-9_-]{1,64})/.exec(location.hash || '');
  if (m) location.replace('/edit' + location.hash);
}

const DEFAULT_DOC_NAME = '제목 없는 스프레드시트';
const MAX_NAME_LEN = 100;

const state = {
  docs: [],
  query: '',
  sort: 'recent',
  loading: true,
  error: null,
  renamingId: null,
  confirmingId: null,
  // The id of the unreadable document whose explanation is open (SPEC 27.6). One at a
  // time, and closed by default, so the list still reads as a list. `explainDetail` is
  // the server's own wording once it has answered; until then the card shows the same
  // words from its own copy, so there is never an empty box.
  explainingId: null,
  explainDetail: null,
  busy: false,
};

const ui = {
  grid: document.getElementById('sz-home-grid'),
  search: document.getElementById('sz-home-search'),
  sort: document.getElementById('sz-home-sort'),
  toasts: document.getElementById('sz-toasts'),
  // Where the 로그아웃 button goes when the gate is on (SPEC 28.5).
  tools: document.querySelector('.sz-home-tools'),
  header: document.querySelector('.sz-home-header'),
  logout: document.getElementById('sz-logout'),
};

// ------------------------------------------------------------- tiny helpers

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function button(className, text, title) {
  const b = el('button', className, text);
  b.type = 'button';
  if (title) b.title = title;
  return b;
}

function docName(doc) {
  const n = typeof doc.name === 'string' ? doc.name.trim() : '';
  return n || DEFAULT_DOC_NAME;
}

function toast(message, tone) {
  if (!ui.toasts) return;
  const box = el('div', 'sz-toast' + (tone === 'error' ? ' sz-toast-error' : ''), String(message));
  ui.toasts.appendChild(box);
  setTimeout(() => {
    box.classList.add('sz-toast-out');
    setTimeout(() => box.remove(), 260);
  }, 4200);
}

/**
 * '방금 전' / 'N분 전' / 'N시간 전' / '어제' / 'N일 전' / 'YYYY-MM-DD'.
 * Uses calendar-day differences, not 24-hour blocks, so something saved at 23:50 reads
 * as 어제 the next morning rather than "9시간 전".
 */
function relativeTime(ts, now = Date.now()) {
  if (!Number.isFinite(ts) || ts <= 0) return '';
  const diff = now - ts;
  if (diff < 0) return '방금 전';
  const min = Math.floor(diff / 60000);
  if (min < 1) return '방금 전';
  if (min < 60) return `${min}분 전`;

  const startOfDay = (t) => {
    const d = new Date(t);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  };
  const days = Math.round((startOfDay(now) - startOfDay(ts)) / 86400000);
  if (days === 0) return `${Math.floor(min / 60)}시간 전`;
  if (days === 1) return '어제';
  if (days < 7) return `${days}일 전`;

  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function absoluteTime(ts) {
  if (!Number.isFinite(ts) || ts <= 0) return '';
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} `
    + `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

async function api(path, options = {}) {
  const init = { method: options.method || 'GET', headers: { 'Content-Type': 'application/json' } };
  if (options.body !== undefined) init.body = JSON.stringify(options.body);
  const res = await fetch(path, init);
  // SPEC 28.3 — every request this page makes goes through here, so this is the ONE
  // place a lost session is handled. A tab left open until the cookie expired must be
  // sent to the login page rather than left showing a list it can no longer act on.
  if (res.status === 401) {
    let body = null;
    try { body = await res.json(); } catch (e) { body = null; }
    // A 401 with no readable body is treated as the gate: it is the only 401 this app's
    // own endpoints produce for these calls.
    const kind = (body && typeof body.error === 'string') ? body.error : 'auth_required';
    if (kind === 'auth_required') goToLogin();
    throw new Error('로그인이 필요합니다.');
  }
  if (!res.ok) {
    // The status and the server's own Korean message travel with the failure, so a caller
    // can tell "cannot be read right now" (503, SPEC 27.6) from "not here" (404) and can
    // put the server's words in front of the user instead of an HTTP number.
    let body = null;
    try { body = await res.json(); } catch (e) { body = null; }
    const server = (body && typeof body.message === 'string' && body.message) ? body.message : '';
    const err = new Error(server || `${init.method} ${path} 실패 (HTTP ${res.status})`);
    err.status = res.status;
    err.code = (body && typeof body.error === 'string') ? body.error : '';
    err.body = body;
    throw err;
  }
  if (res.status === 204) return null;
  return res.json();
}

// ------------------------------------------- an unreadable document (SPEC 27.6)
//
// The server will not open a document whose stored state it could not READ, and it says so
// with a 503 rather than a 404 — because "no such document" is what would have somebody
// create a replacement on top of data that is still sitting there intact.
//
// This page's job is the opposite of hiding it. A document missing from the list reads as
// deleted; a document that is present, marked, and explains itself when opened reads as
// what it is: temporarily unavailable, with nothing lost.

/** The words, for the case where the server's own message did not reach us. */
const UNREADABLE_FALLBACK = {
  message: '이 문서를 지금은 열 수 없습니다.',
  steps: [
    '지금까지 입력한 내용은 서버에 그대로 남아 있습니다. 사라진 것이 아닙니다.',
    '이번에 서버가 그 파일을 읽지 못했을 뿐이라, 읽지 못한 내용을 덮어쓰지 않으려고 문서를 열지 않았습니다.',
    '서버를 다시 시작하면 대부분 그대로 다시 열립니다.',
    '다시 시작해도 같은 문제가 이어지면 백신·백업 같은 다른 프로그램이 파일을 붙잡고 있거나 디스크에 문제가 있는 것입니다. 관리자에게 알려 주세요.',
  ],
};

function unreadableTextOf(source) {
  const message = (source && typeof source.message === 'string' && source.message)
    ? source.message
    : UNREADABLE_FALLBACK.message;
  const steps = (source && Array.isArray(source.steps))
    ? source.steps.filter((s) => typeof s === 'string' && s)
    : [];
  return { message, steps: steps.length ? steps : UNREADABLE_FALLBACK.steps };
}

// ------------------------------------------------------------- access gate
//
// SPEC 28. One shared password for the whole site — no per-user accounts, so there is
// nothing here about who anybody is, only whether this browser has a session.

const LOGIN_PATH = '/login';
/** True once a navigation to the login page is under way; everything after it is noise. */
let authRedirecting = false;

/** /login?next=<where we are>, so logging in comes back to this page. */
function loginUrl() {
  const here = location.pathname + location.search + location.hash;
  return LOGIN_PATH + '?next=' + encodeURIComponent(here);
}

/**
 * The session is gone: to the login page, once, whatever answered 401 first.
 *
 * Nothing can be lost to this navigation. Unlike the editor, this page keeps no outbox
 * and buffers nothing: every mutation it makes is a single request that has either
 * completed or failed by the time we get here, and the optimistic name/row state it
 * holds is a copy of what the server already has. There is therefore nothing to persist
 * before leaving — only the rename input's uncommitted text, which was never sent
 * anywhere and is not work the app ever claimed to be holding.
 */
function goToLogin() {
  if (authRedirecting) return;
  authRedirecting = true;
  // `replace`, not `href`: a page that 401s is not somewhere Back should return to.
  try { location.replace(loginUrl()); }
  catch (e) { location.href = loginUrl(); }
}

/**
 * Show the 로그아웃 button, creating it on first use (SPEC 28.5). With the gate off
 * there is no button at all — not a hidden one — because a 로그아웃 control on a site
 * with no password would misrepresent what the site is. `hidden` and display are both
 * set on a host-supplied node, since one CSS rule would otherwise beat the attribute.
 */
function showLogout(on) {
  if (!on) {
    if (ui.logout) { ui.logout.hidden = true; ui.logout.style.display = 'none'; }
    return;
  }
  if (!ui.logout) {
    const btn = button('sz-btn sz-logout', '로그아웃', '이 브라우저의 로그인 세션을 끝냅니다');
    btn.id = 'sz-logout';
    btn.addEventListener('click', (ev) => { ev.preventDefault(); logout(); });
    (ui.tools || ui.header || document.body).appendChild(btn);
    ui.logout = btn;
  } else if (!ui.logout.dataset.szWired) {
    ui.logout.addEventListener('click', (ev) => { ev.preventDefault(); logout(); });
  }
  ui.logout.dataset.szWired = '1';
  ui.logout.hidden = false;
  ui.logout.style.display = '';
}

/** POST /api/logout, then to the login page (SPEC 28.5). */
async function logout() {
  try {
    await api('/api/logout', { method: 'POST', body: {} });
  } catch (e) {
    // A failed logout is still a logout as far as this tab is concerned.
    console.warn('[home] 로그아웃 요청이 실패했습니다', e);
  }
  authRedirecting = true;
  location.replace(LOGIN_PATH);
}

/**
 * Is the gate on at all? Fire-and-forget: the list is usable before the answer arrives
 * and the only thing it decides is whether the button exists. A 401 here needs no
 * special case — api() sends the user to the login page, which is exactly right.
 */
function refreshAuthMode() {
  return api('/api/version').then(
    (info) => showLogout(!!(info && info.auth)),
    () => showLogout(false),
  );
}

// ------------------------------------------------------------------- data

async function load() {
  state.loading = true;
  state.error = null;
  render();
  try {
    const list = await api('/api/docs');
    state.docs = Array.isArray(list) ? list : [];
  } catch (e) {
    state.error = e && e.message ? e.message : '문서 목록을 불러오지 못했습니다.';
    state.docs = [];
  } finally {
    state.loading = false;
    render();
  }
}

function visibleDocs() {
  const q = state.query.trim().toLowerCase();
  let list = state.docs;
  if (q) list = list.filter((d) => docName(d).toLowerCase().includes(q));
  const sorted = [...list];
  if (state.sort === 'name') {
    sorted.sort((a, b) => docName(a).localeCompare(docName(b), 'ko'));
  } else {
    sorted.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  }
  return sorted;
}

// ---------------------------------------------------------------- actions

async function createDoc() {
  if (state.busy) return;
  state.busy = true;
  render();
  try {
    const doc = await api('/api/docs', { method: 'POST', body: {} });
    // Navigate straight in — creating a document and then having to find it in the
    // list would be a pointless extra step.
    location.href = `/edit#doc=${encodeURIComponent(doc.id)}`;
  } catch (e) {
    state.busy = false;
    toast(e.message || '문서를 만들지 못했습니다.', 'error');
    render();
  }
}

async function renameDoc(id, name) {
  const trimmed = (name || '').trim().slice(0, MAX_NAME_LEN);
  state.renamingId = null;
  const doc = state.docs.find((d) => d.id === id);
  if (!doc || !trimmed || trimmed === docName(doc)) { render(); return; }
  const previous = doc.name;
  doc.name = trimmed;                   // optimistic: the row updates immediately
  render();
  try {
    await api(`/api/docs/${encodeURIComponent(id)}`, { method: 'PATCH', body: { name: trimmed } });
  } catch (e) {
    doc.name = previous;
    toast(e.message || '이름을 바꾸지 못했습니다.', 'error');
    render();
  }
}

/**
 * Open (or close) the explanation for a document the server could not read (SPEC 27.6).
 *
 * It asks the server rather than only unfolding text, for two reasons. The server's own
 * wording is then what the person reads, so the page and the API can never drift apart;
 * and the quarantine is cleared by a restart, so this request is also the cheapest
 * possible way to discover that the restart has already happened — in which case the
 * document opens normally and the person goes straight into it instead of reading an
 * explanation of a problem that is over.
 */
async function explainUnreadable(id) {
  if (state.explainingId === id) {
    state.explainingId = null;
    state.explainDetail = null;
    render();
    return;
  }
  state.explainingId = id;
  state.explainDetail = null;
  render();
  try {
    const doc = await api(`/api/docs/${encodeURIComponent(id)}`);
    if (doc && doc.id) {
      location.href = `/edit#doc=${encodeURIComponent(doc.id)}`;
      return;
    }
  } catch (e) {
    if (e && (e.status === 503 || e.code === 'doc_unreadable')) {
      const text = unreadableTextOf(e.body);
      state.explainDetail = { id, message: text.message, steps: text.steps };
    } else {
      // Anything else (offline, a 500) is not this condition and must not be dressed up
      // as it; the card keeps its own wording and the toast says what actually failed.
      toast(e && e.message ? e.message : '문서 상태를 확인하지 못했습니다.', 'error');
    }
  }
  render();
}

async function deleteDoc(id) {
  state.confirmingId = null;
  const idx = state.docs.findIndex((d) => d.id === id);
  if (idx === -1) return;
  const [removed] = state.docs.splice(idx, 1);
  render();
  try {
    await api(`/api/docs/${encodeURIComponent(id)}`, { method: 'DELETE' });
    toast(`"${docName(removed)}" 문서를 삭제했습니다.`);
  } catch (e) {
    state.docs.splice(idx, 0, removed);  // put it back
    toast(e.message || '문서를 삭제하지 못했습니다.', 'error');
    render();
  }
}

// ----------------------------------------------------------------- render

let renderPending = false;
function render() {
  if (renderPending) return;
  renderPending = true;
  onNextFrame(() => {
    renderPending = false;
    paint();
  });
}

function paint() {
  // On the way to the login page (SPEC 28.3): an error panel here would blame the
  // network for what is actually an expired session, and would flash for one frame
  // before the navigation replaces the page anyway.
  if (authRedirecting) return;
  const grid = ui.grid;
  if (!grid) return;
  grid.textContent = '';

  if (state.error) {
    const box = el('div', 'sz-home-error');
    box.appendChild(el('p', null, state.error));
    const retry = button('sz-btn sz-btn-primary', '다시 시도');
    retry.addEventListener('click', load);
    box.appendChild(retry);
    grid.appendChild(box);
    return;
  }

  grid.appendChild(newCard());

  if (state.loading) {
    grid.appendChild(el('div', 'sz-home-empty', '불러오는 중…'));
    return;
  }

  const list = visibleDocs();
  if (list.length === 0) {
    grid.appendChild(state.query ? noResults() : emptyState());
    return;
  }
  // One line above the cards when anything is quarantined (SPEC 27.6). The red badge on
  // the card says which; this says that the condition exists at all and that it is not
  // data loss, which is the thing somebody scanning the list needs to know before they
  // start wondering where their spreadsheet went.
  const blocked = list.filter((d) => d && d.unreadable);
  if (blocked.length) {
    const note = el('div', 'sz-home-unreadable-note');
    note.style.cssText =
      'grid-column:1/-1;padding:10px 14px;border-radius:8px;background:#fce8e6;color:#a50e0e;'
      + 'font-size:13px;line-height:1.6';
    note.textContent = `문서 ${blocked.length}개를 서버가 읽지 못해 지금은 열 수 없습니다. `
      + '내용은 그대로 있습니다 — 아래에서 해당 문서를 눌러 자세한 내용을 보세요.';
    // Above the 새 문서 card, not after it: the reason not to create a replacement has
    // to be read before the button that creates one.
    grid.insertBefore(note, grid.firstChild);
  }

  const now = Date.now();
  for (const doc of list) grid.appendChild(card(doc, now));
}

function newCard() {
  const a = el('a', 'sz-home-card sz-home-card-new');
  a.href = '#';
  a.setAttribute('role', 'listitem');
  a.title = '빈 스프레드시트를 새로 만듭니다';
  const plus = el('div', 'sz-home-card-plus');
  plus.innerHTML = '<svg viewBox="0 0 24 24" width="30" height="30" aria-hidden="true">'
    + '<path fill="currentColor" d="M11 5h2v6h6v2h-6v6h-2v-6H5v-2h6z"/></svg>';
  a.appendChild(plus);
  a.appendChild(el('div', 'sz-home-card-name', '새 문서 만들기'));
  a.addEventListener('click', (ev) => { ev.preventDefault(); createDoc(); });
  return a;
}

function emptyState() {
  const box = el('div', 'sz-home-empty');
  box.appendChild(el('p', null, '아직 문서가 없습니다.'));
  box.appendChild(el('p', 'sz-home-empty-sub', '왼쪽의 "새 문서 만들기"를 눌러 시작하세요.'));
  return box;
}

function noResults() {
  const box = el('div', 'sz-home-empty');
  box.appendChild(el('p', null, `"${state.query}"에 대한 검색 결과가 없습니다.`));
  const clear = button('sz-btn', '검색 지우기');
  clear.addEventListener('click', () => {
    state.query = '';
    if (ui.search) ui.search.value = '';
    render();
  });
  box.appendChild(clear);
  return box;
}

/**
 * The card for a document the server could not read (SPEC 27.6).
 *
 * Deliberately NOT an anchor. A real link here would be a lie the browser helps tell:
 * middle-click and ctrl-click would open tabs that all land on the same refusal, and the
 * hover would promise a document that is not going to appear. It is a button that explains
 * itself in place, and it carries no 이름 바꾸기 and no 삭제 — both would be refused by the
 * server anyway, and 삭제 in particular must not be one click away from a document nobody
 * has managed to look at.
 */
function unreadableCard(doc) {
  const open = state.explainingId === doc.id;
  const fetched = (state.explainDetail && state.explainDetail.id === doc.id)
    ? state.explainDetail
    : null;
  const text = unreadableTextOf(fetched);

  const box = el('div', 'sz-home-card sz-home-card-unreadable');
  box.setAttribute('role', 'listitem');
  box.dataset.id = doc.id;

  const head = button('sz-home-card-unreadable-head', '');
  head.setAttribute('aria-expanded', open ? 'true' : 'false');
  head.title = '왜 열 수 없는지 봅니다';
  head.style.cssText = 'display:block;width:100%;text-align:left;background:none;border:0;padding:0;cursor:pointer;color:inherit;font:inherit';

  const name = el('div', 'sz-home-card-name', docName(doc));
  name.title = docName(doc);
  head.appendChild(name);

  const meta = el('div', 'sz-home-card-meta');
  const badge = el('span', 'sz-home-card-unreadable-badge', '지금은 열 수 없음');
  badge.style.cssText = 'color:#a50e0e;font-weight:600';
  meta.appendChild(badge);
  meta.appendChild(el('span', null, doc.id));
  head.appendChild(meta);

  head.addEventListener('click', (ev) => {
    ev.preventDefault();
    explainUnreadable(doc.id);
  });
  box.appendChild(head);

  if (open) {
    const detail = el('div', 'sz-home-card-unreadable-detail');
    detail.style.cssText = 'margin-top:10px;font-size:13px;line-height:1.7;color:#3c4043';
    const lead = el('p', null, text.message);
    lead.style.cssText = 'margin:0 0 8px;font-weight:600;color:#202124';
    detail.appendChild(lead);
    // The reassurance is its own block and comes first: it is the question the person
    // opening this actually has.
    const safe = el('p', null, text.steps[0]);
    safe.style.cssText = 'margin:0 0 8px;padding:8px 10px;border-radius:6px;background:#e6f4ea;color:#137333';
    detail.appendChild(safe);
    const list = el('ul');
    list.style.cssText = 'margin:0;padding-left:18px';
    for (let i = 1; i < text.steps.length; i++) list.appendChild(el('li', null, text.steps[i]));
    if (list.childNodes.length) detail.appendChild(list);
    box.appendChild(detail);
  }

  return box;
}

function card(doc, now) {
  // A document the server could not read never becomes an openable card (SPEC 27.6).
  if (doc && doc.unreadable) return unreadableCard(doc);
  const renaming = state.renamingId === doc.id;
  const confirming = state.confirmingId === doc.id;

  // A real anchor so middle-click / ctrl-click open a new tab, which a div with a
  // click handler can never do.
  const a = el('a', 'sz-home-card');
  a.href = `/edit#doc=${encodeURIComponent(doc.id)}`;
  a.setAttribute('role', 'listitem');
  a.dataset.id = doc.id;
  if (renaming || confirming) a.classList.add('sz-home-card-busy');

  const thumb = el('div', 'sz-home-card-thumb');
  thumb.setAttribute('aria-hidden', 'true');
  a.appendChild(thumb);

  const body = el('div', 'sz-home-card-body');

  if (renaming) {
    const input = el('input', 'sz-home-rename');
    input.type = 'text';
    input.value = docName(doc);
    input.maxLength = MAX_NAME_LEN;
    input.spellcheck = false;
    input.setAttribute('aria-label', '문서 이름');
    input.title = 'Enter로 확정, Esc로 되돌리기';
    // The card is a link; typing inside it must not navigate.
    input.addEventListener('click', (ev) => ev.preventDefault());
    input.addEventListener('keydown', (ev) => {
      ev.stopPropagation();
      if (ev.key === 'Enter') { ev.preventDefault(); renameDoc(doc.id, input.value); }
      else if (ev.key === 'Escape') { ev.preventDefault(); state.renamingId = null; render(); }
    });
    input.addEventListener('blur', () => {
      if (state.renamingId === doc.id) renameDoc(doc.id, input.value);
    });
    body.appendChild(input);
    onNextFrame(() => { input.focus(); input.select(); });
  } else {
    const name = el('div', 'sz-home-card-name', docName(doc));
    name.title = docName(doc);
    body.appendChild(name);
  }

  const sheets = Number.isFinite(doc.sheetCount) ? doc.sheetCount : 1;
  const meta = el('div', 'sz-home-card-meta');
  meta.appendChild(el('span', null, `시트 ${sheets}장`));
  const time = el('time', null, relativeTime(doc.updatedAt, now));
  if (doc.updatedAt > 0) {
    time.dateTime = new Date(doc.updatedAt).toISOString();
    time.title = `${absoluteTime(doc.updatedAt)} 수정됨`;
  }
  meta.appendChild(time);
  body.appendChild(meta);
  a.appendChild(body);

  if (confirming) {
    const box = el('div', 'sz-home-confirm');
    box.appendChild(el('span', null, '삭제할까요?'));
    const yes = button('sz-home-act sz-home-act-danger', '삭제');
    yes.addEventListener('click', (ev) => { ev.preventDefault(); ev.stopPropagation(); deleteDoc(doc.id); });
    const no = button('sz-home-act', '취소');
    no.addEventListener('click', (ev) => {
      ev.preventDefault(); ev.stopPropagation();
      state.confirmingId = null; render();
    });
    box.appendChild(yes);
    box.appendChild(no);
    a.appendChild(box);
  } else if (!renaming) {
    const menu = el('div', 'sz-home-card-menu');
    const rename = button('sz-home-act', '이름 바꾸기', '문서 이름을 바꿉니다');
    rename.addEventListener('click', (ev) => {
      ev.preventDefault(); ev.stopPropagation();
      state.confirmingId = null;
      state.renamingId = doc.id;
      render();
    });
    const del = button('sz-home-act sz-home-act-danger', '삭제', '문서를 삭제합니다');
    del.addEventListener('click', (ev) => {
      ev.preventDefault(); ev.stopPropagation();
      state.renamingId = null;
      state.confirmingId = doc.id;
      render();
    });
    menu.appendChild(rename);
    menu.appendChild(del);
    a.appendChild(menu);
  }

  return a;
}

// ------------------------------------------------------------------- wiring

if (ui.search) {
  ui.search.addEventListener('input', () => {
    state.query = ui.search.value || '';
    render();
  });
  ui.search.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && ui.search.value) {
      ev.preventDefault();
      ui.search.value = '';
      state.query = '';
      render();
    }
  });
}

if (ui.sort) {
  ui.sort.addEventListener('change', () => {
    state.sort = ui.sort.value === 'name' ? 'name' : 'recent';
    render();
  });
}

// Escape anywhere backs out of an in-progress rename or delete confirmation.
document.addEventListener('keydown', (ev) => {
  if (ev.key !== 'Escape') return;
  if (state.confirmingId) { state.confirmingId = null; render(); }
  if (state.explainingId) { state.explainingId = null; state.explainDetail = null; render(); }
});

// A document deleted or created in another tab should show up here on return.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && !state.loading) load();
});

load();
// SPEC 28.5 — shows the 로그아웃 button when, and only when, the gate is on.
refreshAuthMode();
