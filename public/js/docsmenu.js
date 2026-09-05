// docsmenu.js — 시트지: document create / list menu (docs/SPEC.md section 18).
//
// A self-contained view module. It renders whatever setState() hands it and reports
// intent through onCommand(name, payload); it imports nothing from the engine, the
// network layer or the model — only ./schedule.js, so repaints coalesce the same way
// every other view in this app coalesces them (a hidden tab still gets painted).
//
// ---------------------------------------------------------------------------
// DOM / class-name contract (styled by public/css/style.css)
// ---------------------------------------------------------------------------
// Spec class names (section 18) — used exactly as written:
//   .sz-docs                the wrapper built inside the host root element
//   .sz-docs-panel          the 내 문서 panel; hidden while closed
//   .sz-docs-item           one document row
//   .sz-docs-item-current   the row of the document currently open
//   .sz-docs-name           the row's name (a <button> that opens; a <span> on the
//                           current row, which is marked and never opens)
//   .sz-docs-time           the relative updated time (<time datetime=...>)
//   .sz-docs-actions        the row's 이름 바꾸기 / 삭제 buttons
//   .sz-docs-empty          the 문서가 없습니다 placeholder (also the loading text)
//   .sz-docs-confirm        the inline 삭제 / 취소 pair that REPLACES .sz-docs-actions
//                           while a delete is awaiting confirmation
// Additional structural classes (not named in the spec, layout/state only):
//   .sz-docs-new            the 새 문서 button          (also carries .sz-btn)
//   .sz-docs-toggle         the 내 문서 button          (also carries .sz-btn)
//   .sz-docs-head           panel header row
//   .sz-docs-title          panel heading text
//   .sz-docs-busy           the subtle "불러오는 중…" hint in the panel header
//   .sz-docs-refresh        the 새로고침 button in the panel header
//   .sz-docs-list           scroll container holding the rows
//   .sz-docs-badge          the 현재 marker on the current row
//   .sz-docs-rename         the inline rename <input> replacing .sz-docs-name
//   .sz-docs-act            a row action button (rename/delete/confirm/cancel)
//   .sz-docs-act-danger     the destructive variant of .sz-docs-act
//   .sz-docs-confirm-text   the "삭제할까요?" label inside .sz-docs-confirm
//   .sz-docs-empty-new      the create button inside the empty placeholder
//
// This module writes NO stylesheet. The only inline style it sets is the panel's
// display while closed, which pairs with the `hidden` attribute so the panel stays
// invisible even if style.css gives .sz-docs-panel an unconditional display.
//
// ---------------------------------------------------------------------------
// Commands emitted through onCommand(name, payload)
// ---------------------------------------------------------------------------
//   'create'  {}                     새 문서 / the empty placeholder's button
//   'open'    { docId }              a row was activated
//   'rename'  { docId, name }        inline rename committed (Enter or blur)
//   'delete'  { docId }              inline confirmation accepted
//   'refresh' {}                     the panel was opened, or 새로고침 was pressed
//
// setState({ docs, currentId, busy }):
//   docs       [{ id, name, updatedAt, rev }] — order is irrelevant, this module
//              sorts newest-first itself
//   currentId  id of the document on screen; its row is marked and cannot open
//   busy       true while the host is talking to the server: the actions are
//              disabled and a loading hint replaces the list when nothing is known
//
// Panel lifecycle: opens on 내 문서 (focusing the first row), closes on Escape
// (returning focus to that button), on an outside click, and after a row opens or a
// document is created.

import { onNextFrame } from './schedule.js';

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** Beyond this many calendar days a row shows an absolute YYYY-MM-DD date. */
const RELATIVE_DAY_LIMIT = 7;

/** Names longer than this are trimmed on commit (the server caps names anyway). */
const MAX_NAME_LEN = 100;

/** How often the open panel refreshes its relative times, in ms. */
const CLOCK_MS = 30 * 1000;

const FALLBACK_NAME = '제목 없는 스프레드시트';

let panelSeq = 0;

// ---------------------------------------------------------------------------
// Relative time
// ---------------------------------------------------------------------------

function pad2(n) {
  return n < 10 ? '0' + n : String(n);
}

/** Local midnight of the day containing `ms`. */
function startOfDay(ms) {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/**
 * Whole calendar days between two instants, in LOCAL time.
 * Rounding (rather than flooring) absorbs 23h/25h daylight-saving days, which
 * would otherwise make "yesterday" land a day off in half the world.
 */
function calendarDaysBetween(fromMs, toMs) {
  return Math.round((startOfDay(toMs) - startOfDay(fromMs)) / DAY_MS);
}

/** Local YYYY-MM-DD. */
function formatDate(ms) {
  const d = new Date(ms);
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
}

/** Local YYYY-MM-DD HH:MM — the exact value, shown as a tooltip. */
function formatAbsolute(ms) {
  const d = new Date(ms);
  return formatDate(ms) + ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
}

/** Local YYYY-MM-DDTHH:MM — a valid <time datetime> without pretending to be UTC. */
function formatMachine(ms) {
  const d = new Date(ms);
  return formatDate(ms) + 'T' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
}

/**
 * Korean relative time for a document's updatedAt.
 *
 *   < 1분        방금 전          (also when the stamp is slightly in the future:
 *                                 a server clock a few seconds ahead must not
 *                                 produce "-1분 전")
 *   < 1시간      N분 전
 *   < 24시간     N시간 전         elapsed-based, so 23:00 → 00:30 reads "1시간 전"
 *   그 이후      어제 / N일 전    CALENDAR-based, so Saturday 23:00 seen on Monday
 *                                 morning is "2일 전" and not "어제" (a pure
 *                                 34-hours-is-one-day rule gets exactly this wrong)
 *   8일 이상     YYYY-MM-DD
 *
 * @param {number} ts     epoch ms
 * @param {number} [now]  epoch ms to compare against (injectable for tests)
 * @returns {string}      '' when ts is not a usable timestamp
 */
export function formatRelativeTime(ts, now = Date.now()) {
  const t = Number(ts);
  if (!Number.isFinite(t) || t <= 0) return '';
  const diff = now - t;

  if (diff < MINUTE_MS) return '방금 전';
  if (diff < HOUR_MS) return Math.floor(diff / MINUTE_MS) + '분 전';
  if (diff < DAY_MS) return Math.floor(diff / HOUR_MS) + '시간 전';

  const days = calendarDaysBetween(t, now);
  if (days <= 1) return '어제';
  if (days <= RELATIVE_DAY_LIMIT) return days + '일 전';
  return formatDate(t);
}

// ---------------------------------------------------------------------------
// Small DOM helpers
// ---------------------------------------------------------------------------

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = text;
  return node;
}

function button(className, label, title) {
  const b = el('button', className, label);
  b.type = 'button';
  if (title) b.title = title;
  return b;
}

function closestIn(target, selector) {
  return target && typeof target.closest === 'function' ? target.closest(selector) : null;
}

/** Escape a value for use inside an [attr="..."] selector. */
function attrValue(s) {
  return String(s).replace(/["\\]/g, '');
}

function docName(doc) {
  const n = doc && typeof doc.name === 'string' ? doc.name.trim() : '';
  return n || FALLBACK_NAME;
}

// ---------------------------------------------------------------------------
// DocsMenu
// ---------------------------------------------------------------------------

export class DocsMenu {
  /**
   * @param {HTMLElement} root  an element supplied by index.html (contents replaced)
   * @param {{onCommand?: (name: string, payload?: *) => void}} [options]
   */
  constructor(root, options = {}) {
    if (!root || typeof root.appendChild !== 'function') {
      throw new TypeError('DocsMenu: 메뉴를 붙일 root 엘리먼트가 필요합니다');
    }
    this.root = root;
    this.onCommand = typeof options.onCommand === 'function' ? options.onCommand : () => {};

    this.state = { docs: [], currentId: null, busy: false };

    this._open = false;
    this._renaming = null;    // { docId, original } while an inline rename is live
    this._confirming = null;  // docId whose delete is awaiting inline confirmation
    this._focusKey = null;    // one-shot data-fk to focus after the next render
    this._cancelFrame = null;
    this._clock = 0;
    this._destroyed = false;

    this._build();
    this._bindGlobal();
    this._render();
  }

  // ------------------------------------------------------------------ build

  _build() {
    this.root.textContent = '';

    const wrap = el('div', 'sz-docs');
    this.el = wrap;

    const panelId = 'sz-docs-panel-' + (++panelSeq);

    this.newBtn = button('sz-btn sz-docs-new', '새 문서', '새 스프레드시트를 만들어 바로 엽니다');
    this.newBtn.dataset.fk = 'create';
    this.newBtn.addEventListener('click', () => this._create());

    this.toggleBtn = button('sz-btn sz-docs-toggle', '내 문서', '내 문서 목록을 엽니다');
    this.toggleBtn.dataset.fk = 'toggle';
    this.toggleBtn.setAttribute('aria-haspopup', 'true');
    this.toggleBtn.setAttribute('aria-expanded', 'false');
    this.toggleBtn.setAttribute('aria-controls', panelId);
    this.toggleBtn.addEventListener('click', () => {
      if (this._open) this.close({ focusButton: true });
      else this.open();
    });

    const panel = el('div', 'sz-docs-panel');
    panel.id = panelId;
    panel.tabIndex = -1;
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', '내 문서');
    panel.hidden = true;
    panel.style.display = 'none';
    this.panel = panel;

    const head = el('div', 'sz-docs-head');
    head.appendChild(el('span', 'sz-docs-title', '내 문서'));

    this.busyEl = el('span', 'sz-docs-busy', '불러오는 중…');
    this.busyEl.setAttribute('aria-live', 'polite');
    this.busyEl.hidden = true;
    head.appendChild(this.busyEl);

    this.refreshBtn = button('sz-docs-act sz-docs-refresh', '새로고침', '목록을 다시 불러옵니다');
    this.refreshBtn.dataset.fk = 'refresh';
    this.refreshBtn.addEventListener('click', () => {
      if (this.state.busy) return;
      this.emit('refresh', {});
    });
    head.appendChild(this.refreshBtn);

    panel.appendChild(head);

    this.list = el('div', 'sz-docs-list');
    this.list.setAttribute('role', 'list');
    panel.appendChild(this.list);

    // One delegated click handler for every row control.
    panel.addEventListener('click', (ev) => this._onPanelClick(ev));

    wrap.appendChild(this.newBtn);
    wrap.appendChild(this.toggleBtn);
    wrap.appendChild(panel);
    this.root.appendChild(wrap);
  }

  _bindGlobal() {
    this._onDocDown = (ev) => {
      if (!this._open) return;
      if (this.el && this.el.contains(ev.target)) return;
      this.close();               // outside click: no focus stealing
    };

    this._onDocKey = (ev) => {
      if (!this._open || ev.key !== 'Escape') return;
      // Layered: an inline edit backs out first, then the panel itself.
      if (this._renaming) {
        ev.preventDefault();
        ev.stopPropagation();
        this._cancelRename();
        return;
      }
      if (this._confirming) {
        ev.preventDefault();
        ev.stopPropagation();
        this._cancelConfirm();
        return;
      }
      ev.preventDefault();
      ev.stopPropagation();
      this.close({ focusButton: true });
    };

    this._onDocNav = (ev) => {
      if (!this._open || !this.panel.contains(ev.target)) return;
      if (this._renaming) return;                        // arrows belong to the input
      const keys = ['ArrowDown', 'ArrowUp', 'Home', 'End'];
      if (keys.indexOf(ev.key) === -1) return;
      const names = Array.prototype.slice.call(this.list.querySelectorAll('.sz-docs-name'));
      if (names.length === 0) return;
      const here = names.indexOf(closestIn(ev.target, '.sz-docs-name'));
      let next;
      if (ev.key === 'Home') next = 0;
      else if (ev.key === 'End') next = names.length - 1;
      else if (here === -1) next = ev.key === 'ArrowDown' ? 0 : names.length - 1;
      else next = (here + (ev.key === 'ArrowDown' ? 1 : names.length - 1)) % names.length;
      ev.preventDefault();
      names[next].focus();
    };

    document.addEventListener('mousedown', this._onDocDown, true);
    document.addEventListener('keydown', this._onDocKey, true);
    document.addEventListener('keydown', this._onDocNav, false);
  }

  // ------------------------------------------------------------------ events

  /**
   * Report a command. Returns false when the host's handler threw, which is what
   * "a successful open" means here: a handler that blew up must not leave the user
   * staring at a closed panel and an unchanged document.
   */
  emit(name, payload) {
    try {
      this.onCommand(name, payload);
      return true;
    } catch (e) {
      console.error('[docsmenu] 명령 처리 실패: ' + name, e);
      return false;
    }
  }

  _onPanelClick(ev) {
    const act = closestIn(ev.target, '[data-act]');
    const row = closestIn(ev.target, '.sz-docs-item');
    const docId = row ? row.dataset.id : (act ? act.dataset.id : null);

    if (act) {
      const kind = act.dataset.act;
      if (kind === 'create') { ev.preventDefault(); this._create(); return; }
      if (!docId) return;
      ev.preventDefault();
      if (kind === 'open') this._openDoc(docId);
      else if (kind === 'rename') this._beginRename(docId);
      else if (kind === 'delete') this._askDelete(docId);
      else if (kind === 'confirm') this._confirmDelete(docId);
      else if (kind === 'cancel') this._cancelConfirm();
      return;
    }

    // Bare row background: opening is the row's primary action.
    if (row && docId && !closestIn(ev.target, '.sz-docs-actions, .sz-docs-confirm, input')) {
      this._openDoc(docId);
    }
  }

  // ------------------------------------------------------------------ actions

  _create() {
    if (this.state.busy) return;
    const ok = this.emit('create', {});
    if (ok) this.close();   // the host opens the new document immediately
  }

  _openDoc(docId) {
    if (this.state.busy) return;
    if (!docId || docId === this.state.currentId) return;   // current row never opens
    const ok = this.emit('open', { docId });
    if (ok) this.close();
  }

  _beginRename(docId) {
    if (this.state.busy) return;
    const doc = this._findDoc(docId);
    if (!doc) return;
    this._confirming = null;
    this._renaming = { docId, original: docName(doc) };
    this._focusKey = 'rename:' + docId;
    this._render();
  }

  /** Enter, or a blur that was not preceded by Escape. */
  _commitRename(opts = {}) {
    const pending = this._renaming;
    if (!pending) return;
    const input = this.panel.querySelector('.sz-docs-rename');
    const raw = input ? input.value : '';
    const name = raw.trim().slice(0, MAX_NAME_LEN);
    this._renaming = null;

    if (name && name !== pending.original) {
      // Optimistic: paint the new name now so the row does not flash the old one
      // while the server round-trip is in flight. setState() overwrites it.
      const doc = this._findDoc(pending.docId);
      if (doc) doc.name = name;
      this.emit('rename', { docId: pending.docId, name });
    }
    if (opts.render === false) return;
    this._focusKey = 'row:' + pending.docId;
    this._render();
  }

  _cancelRename() {
    const pending = this._renaming;
    if (!pending) return;
    this._renaming = null;
    this._focusKey = 'row:' + pending.docId;
    this._render();
  }

  _askDelete(docId) {
    if (this.state.busy) return;
    if (!this._findDoc(docId)) return;
    this._renaming = null;
    this._confirming = docId;
    // 취소 takes focus: the destructive button must be a deliberate second target,
    // never something a stray Enter can hit twice in a row.
    this._focusKey = 'cancel:' + docId;
    this._render();
  }

  _confirmDelete(docId) {
    if (this.state.busy) return;
    if (this._confirming !== docId) return;
    this._confirming = null;
    this.emit('delete', { docId });
    this._render();
  }

  _cancelConfirm() {
    const docId = this._confirming;
    if (!docId) return;
    this._confirming = null;
    this._focusKey = 'act-delete:' + docId;
    this._render();
  }

  // ------------------------------------------------------------------ state

  /**
   * @param {{docs?: Array, currentId?: string|null, busy?: boolean}} next
   */
  setState(next = {}) {
    if (Array.isArray(next.docs)) {
      // Copy: the optimistic rename below must never mutate the host's array.
      this.state.docs = next.docs
        .filter((d) => d && typeof d.id === 'string' && d.id)
        .map((d) => ({
          id: d.id,
          name: typeof d.name === 'string' ? d.name : '',
          updatedAt: Number(d.updatedAt) || 0,
          rev: Number(d.rev) || 0,
        }));
    }
    if (next.currentId !== undefined) this.state.currentId = next.currentId || null;
    if (next.busy !== undefined) this.state.busy = !!next.busy;

    // Drop row-local UI state that no longer has a row to live in.
    if (this._renaming && !this._findDoc(this._renaming.docId)) this._renaming = null;
    if (this._confirming && !this._findDoc(this._confirming)) this._confirming = null;

    this._scheduleRender();
  }

  _findDoc(docId) {
    for (const d of this.state.docs) if (d.id === docId) return d;
    return null;
  }

  /** Newest first; ties broken by id so the order never jitters between renders. */
  _sortedDocs() {
    return this.state.docs.slice().sort((a, b) => {
      if (b.updatedAt !== a.updatedAt) return b.updatedAt - a.updatedAt;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
  }

  // ------------------------------------------------------------------ open/close

  open() {
    if (this._destroyed || this._open) return;
    this._open = true;
    this._renaming = null;
    this._confirming = null;
    this.panel.hidden = false;
    this.panel.style.display = '';
    this.toggleBtn.setAttribute('aria-expanded', 'true');
    this.emit('refresh', {});
    this._render();
    this._startClock();

    // Focus the first row; fall back to the panel so Escape still lands here.
    const first = this.list.querySelector('.sz-docs-name');
    if (first) first.focus();
    else this.panel.focus();
  }

  close(opts = {}) {
    if (!this._open) return;
    // An edit in flight keeps what the user typed, exactly as a blur would.
    if (this._renaming) this._commitRename({ render: false });
    this._open = false;
    this._confirming = null;
    this._stopClock();
    this.panel.hidden = true;
    this.panel.style.display = 'none';
    this.toggleBtn.setAttribute('aria-expanded', 'false');
    this.list.textContent = '';
    if (opts.focusButton) this.toggleBtn.focus();
  }

  destroy() {
    this._destroyed = true;
    this._open = false;
    this._stopClock();
    if (this._cancelFrame) { this._cancelFrame(); this._cancelFrame = null; }
    document.removeEventListener('mousedown', this._onDocDown, true);
    document.removeEventListener('keydown', this._onDocKey, true);
    document.removeEventListener('keydown', this._onDocNav, false);
    this._renaming = null;
    this._confirming = null;
    this.root.textContent = '';
  }

  // ------------------------------------------------------------------ clock

  _startClock() {
    this._stopClock();
    this._clock = setInterval(() => this._tickTimes(), CLOCK_MS);
  }

  _stopClock() {
    if (this._clock) { clearInterval(this._clock); this._clock = 0; }
  }

  /** Repaint only the time labels, so a live rename or confirm is left alone. */
  _tickTimes() {
    if (!this._open) return;
    const now = Date.now();
    const nodes = this.list.querySelectorAll('.sz-docs-time');
    for (const node of nodes) {
      const ts = Number(node.dataset.ts);
      if (!Number.isFinite(ts) || ts <= 0) continue;
      node.textContent = formatRelativeTime(ts, now);
    }
  }

  // ------------------------------------------------------------------ render

  _scheduleRender() {
    if (this._destroyed || this._cancelFrame) return;
    this._cancelFrame = onNextFrame(() => {
      this._cancelFrame = null;
      this._render();
    });
  }

  _render() {
    if (this._destroyed) return;
    const busy = !!this.state.busy;

    this.newBtn.disabled = busy;
    this.refreshBtn.disabled = busy;
    this.busyEl.hidden = !busy;

    if (!this._open) return;   // the panel's contents only exist while it is open

    this.panel.setAttribute('aria-busy', busy ? 'true' : 'false');

    // Remember where focus was so a repaint mid-interaction does not throw the
    // user back to the top of the panel.
    const active = document.activeElement;
    const prevKey = active && this.panel.contains(active) ? active.dataset.fk || null : null;
    const prevSelStart = active && active.selectionStart !== undefined ? active.selectionStart : null;
    const prevSelEnd = active && active.selectionEnd !== undefined ? active.selectionEnd : null;

    this._renderList(busy);

    const wantKey = this._focusKey || prevKey;
    this._focusKey = null;
    if (wantKey) {
      const target = this.panel.querySelector('[data-fk="' + attrValue(wantKey) + '"]');
      if (target && !target.disabled) {
        target.focus();
        if (target.tagName === 'INPUT') {
          if (prevKey === wantKey && prevSelStart !== null) {
            try { target.setSelectionRange(prevSelStart, prevSelEnd); } catch (e) { /* ignore */ }
          } else {
            target.select();
          }
        }
      } else if (!this.panel.contains(document.activeElement)) {
        this.panel.focus();
      }
    }
  }

  _renderList(busy) {
    const list = this.list;
    list.textContent = '';
    const docs = this._sortedDocs();

    if (docs.length === 0) {
      const empty = el('div', 'sz-docs-empty');
      if (busy) {
        empty.appendChild(el('span', null, '문서를 불러오는 중입니다…'));
      } else {
        empty.appendChild(el('span', null, '문서가 없습니다'));
        const make = button('sz-docs-act sz-docs-empty-new', '새 문서 만들기', '새 스프레드시트를 만듭니다');
        make.dataset.act = 'create';
        make.dataset.fk = 'empty-create';
        empty.appendChild(make);
      }
      list.appendChild(empty);
      return;
    }

    const now = Date.now();
    for (const doc of docs) list.appendChild(this._renderItem(doc, busy, now));
  }

  _renderItem(doc, busy, now) {
    const isCurrent = doc.id === this.state.currentId;
    const renaming = !!this._renaming && this._renaming.docId === doc.id;
    const confirming = this._confirming === doc.id;

    const item = el('div', 'sz-docs-item' + (isCurrent ? ' sz-docs-item-current' : ''));
    item.setAttribute('role', 'listitem');
    item.dataset.id = doc.id;

    if (renaming) {
      item.appendChild(this._renameInput(doc));
    } else if (isCurrent) {
      // Marked, and deliberately not a button: the current document never opens.
      const span = el('span', 'sz-docs-name', docName(doc));
      span.tabIndex = -1;
      span.title = docName(doc);
      span.dataset.fk = 'row:' + doc.id;
      span.setAttribute('aria-current', 'true');
      item.appendChild(span);
      item.appendChild(el('span', 'sz-docs-badge', '현재'));
    } else {
      const open = button('sz-docs-name', docName(doc), docName(doc) + ' 열기');
      open.dataset.act = 'open';
      open.dataset.id = doc.id;
      open.dataset.fk = 'row:' + doc.id;
      if (busy) open.setAttribute('aria-disabled', 'true');   // stays focusable
      item.appendChild(open);
    }

    const time = el('time', 'sz-docs-time', formatRelativeTime(doc.updatedAt, now));
    if (doc.updatedAt > 0) {
      time.dataset.ts = String(doc.updatedAt);
      time.dateTime = formatMachine(doc.updatedAt);
      time.title = formatAbsolute(doc.updatedAt) + ' 수정됨';
    }
    item.appendChild(time);

    item.appendChild(confirming ? this._confirmBox(doc, busy) : this._actionsBox(doc, busy, renaming));
    return item;
  }

  _renameInput(doc) {
    const input = el('input', 'sz-docs-rename');
    input.type = 'text';
    input.value = docName(doc);
    input.maxLength = MAX_NAME_LEN;
    input.spellcheck = false;
    input.autocomplete = 'off';
    input.title = 'Enter로 확정, Esc로 되돌리기';
    input.setAttribute('aria-label', '문서 이름');
    input.dataset.fk = 'rename:' + doc.id;

    input.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') {
        ev.preventDefault();
        ev.stopPropagation();
        this._commitRename();
      }
      // Escape is handled by the document-level capture handler (_onDocKey).
    });
    // A click elsewhere keeps the typing, like every other inline editor here.
    // Guarded by _renaming: a rerender that removes the input cannot re-commit.
    input.addEventListener('blur', () => {
      if (this._renaming && this._renaming.docId === doc.id) this._commitRename();
    });
    return input;
  }

  _actionsBox(doc, busy, renaming) {
    const box = el('div', 'sz-docs-actions');

    const rename = button('sz-docs-act', '이름 바꾸기', '문서 이름을 바꿉니다');
    rename.dataset.act = 'rename';
    rename.dataset.id = doc.id;
    rename.dataset.fk = 'act-rename:' + doc.id;
    rename.disabled = busy || renaming;
    box.appendChild(rename);

    const del = button('sz-docs-act sz-docs-act-danger', '삭제', '문서를 삭제합니다');
    del.dataset.act = 'delete';
    del.dataset.id = doc.id;
    del.dataset.fk = 'act-delete:' + doc.id;
    del.disabled = busy;
    box.appendChild(del);

    return box;
  }

  /** Replaces .sz-docs-actions while the row waits for confirmation. */
  _confirmBox(doc, busy) {
    const box = el('div', 'sz-docs-confirm');
    box.setAttribute('role', 'group');
    box.setAttribute('aria-label', docName(doc) + ' 삭제 확인');
    box.appendChild(el('span', 'sz-docs-confirm-text', '삭제할까요?'));

    const yes = button('sz-docs-act sz-docs-act-danger', '삭제', '이 문서를 삭제합니다');
    yes.dataset.act = 'confirm';
    yes.dataset.id = doc.id;
    yes.dataset.fk = 'confirm:' + doc.id;
    yes.disabled = busy;
    box.appendChild(yes);

    const no = button('sz-docs-act', '취소', '삭제하지 않습니다');
    no.dataset.act = 'cancel';
    no.dataset.id = doc.id;
    no.dataset.fk = 'cancel:' + doc.id;
    no.disabled = busy;
    box.appendChild(no);

    return box;
  }
}

export default DocsMenu;
