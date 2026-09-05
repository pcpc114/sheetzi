// sheetbar.js — 시트지: the bottom sheet tab strip (docs/SPEC.md section 17).
//
// A self-contained view. It builds every node itself from an empty root element,
// paints whatever setState() hands it, and reports intent through
// onCommand(name, payload). It knows nothing about the engine, the socket or
// main.js; the only imports are the repaint scheduler and the presence palette.
//
// ---------------------------------------------------------------------------
// DOM / class-name contract (styled by public/css/style.css)
// ---------------------------------------------------------------------------
// Spec-mandated class names (section 17):
//   .sz-sheetbar          the strip itself; the single child of the root element
//   .sz-sheet-add         the '+' button on the far left
//   .sz-sheet-tabs        the horizontally scrolling tab container (role=tablist)
//   .sz-sheet-tab         one tab — a real <button role="tab" aria-selected>
//   .sz-sheet-tab-active  active-tab modifier on .sz-sheet-tab
//   .sz-sheet-tab-color   the tab's colour underline (a child of the tab)
//   .sz-sheet-caret       the per-tab menu button, overlaid at the tab's right end
//   .sz-sheet-rename      the inline rename <input>, overlaid on the tab
//   .sz-sheet-drop        the drop indicator shown while dragging to reorder
//   .sz-sheet-peer        one peer dot on a tab
//   .sz-sheet-menu        the floating tab menu (in <body>, position:fixed)
//   .sz-sheet-menu-item   one row of that menu
// Additional structural classes (layout only, not named in the spec):
//   .sz-sheet-tab-slot    per-tab positioning wrapper (role=presentation) — it exists
//                         because a <button> may not contain another <button>, so the
//                         caret and the rename input must be siblings of the tab
//   .sz-sheet-tab-label   the name text inside the tab (ellipsised when long)
//   .sz-sheet-peers       the peer-dot stack inside the tab
//   .sz-sheet-peer-more   the '+N' chip when more peers than dots fit
//   .sz-sheet-menu-sep    a 1px separator inside the menu
//   .sz-sheet-menu-title  the heading of the colour submenu
//   .sz-sheet-swatches    the colour submenu grid
//   .sz-sheet-swatch      one colour swatch in that grid
//
// ---------------------------------------------------------------------------
// Commands emitted through onCommand(name, payload)
// ---------------------------------------------------------------------------
//   'select'    { sheetId }
//   'add'       { afterId }            afterId is null => append at the end,
//                                      which is what the '+' button means
//   'rename'    { sheetId, name }      trimmed, non-empty, actually different
//   'delete'    { sheetId }
//   'duplicate' { sheetId }
//   'reorder'   { sheetId, index }     index is the final position in the list
//   'color'     { sheetId, color }     color null clears
//
// setState({ sheets, activeId, peers }) — `sheets` is read for id/name/color only,
// `peers` is [{id,name,color,sheetId}] and paints the per-tab dots.
//
// Deliberate implementation notes:
//   - Rename is an <input> overlaid on the tab. It is NEVER window.prompt: a native
//     modal blocks the whole renderer thread, which in a collaborative app freezes
//     the socket pump and every other window's view of this user.
//   - Pointer events (not mouse events) drive the reorder drag, so a touch drag works
//     and a lost pointer is recoverable through pointercancel.
//   - setState diffs against the previous state: the tab list is rebuilt only when the
//     id sequence changes, so a peer-cursor storm patches text and dots in place and an
//     open rename editor survives a remote edit.

import { onNextFrame } from './schedule.js';
import { colorForId } from './presence.js';

/** Fixed tab-colour palette offered by the 색상 변경 submenu. */
const TAB_COLORS = [
  ['#d93025', '빨강'],
  ['#e8710a', '주황'],
  ['#f9ab00', '노랑'],
  ['#0b8043', '초록'],
  ['#00838f', '청록'],
  ['#1a73e8', '파랑'],
  ['#3949ab', '남색'],
  ['#9334e6', '보라'],
  ['#c2185b', '분홍'],
  ['#795548', '갈색'],
  ['#546e7a', '회청색'],
  ['#5f6368', '회색'],
];

/** Peer dots drawn on a tab before collapsing the rest into a '+N' chip. */
const MAX_PEER_DOTS = 4;

/** Pointer travel (px) that turns a press into a reorder drag. */
const DRAG_THRESHOLD = 4;

/** Sheet names are capped server-side at 100 chars; mirror that in the editor. */
const MAX_NAME_LEN = 100;

const HEX_COLOR = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

/**
 * Minimal structural fallback styling, PREPENDED to <head> so that
 * public/css/style.css — linked later in the document — always wins on conflict.
 * It exists only so the strip is usable (a horizontal row, a floating menu, an
 * overlaid editor) before or without the real stylesheet; every rule here is
 * layout, and every selector is one class deep so the stylesheet can override it.
 */
const FALLBACK_CSS = [
  '.sz-sheetbar{display:flex;align-items:stretch;gap:6px;min-width:0;padding:3px 6px;user-select:none}',
  '.sz-sheet-add{flex:0 0 auto;display:inline-flex;align-items:center;justify-content:center;',
  'width:28px;height:28px;padding:0;border:0;border-radius:5px;background:transparent;',
  'color:inherit;font:inherit;cursor:pointer}',
  '.sz-sheet-add:hover{background:rgba(60,64,67,.10)}',
  '.sz-sheet-tabs{position:relative;display:flex;align-items:stretch;gap:2px;flex:1 1 auto;',
  'min-width:0;overflow-x:auto;overflow-y:hidden;scrollbar-width:thin}',
  '.sz-sheet-tab-slot{position:relative;flex:0 0 auto;display:flex;align-items:stretch}',
  '.sz-sheet-tab{position:relative;display:inline-flex;align-items:center;gap:6px;height:28px;',
  'max-width:220px;padding:0 22px 0 10px;border:0;border-radius:6px 6px 0 0;background:transparent;',
  'color:inherit;font:inherit;cursor:pointer;white-space:nowrap}',
  '.sz-sheet-tab:hover{background:rgba(60,64,67,.10)}',
  '.sz-sheet-tab-active{background:rgba(26,115,232,.16);color:#1a73e8;font-weight:700}',
  '.sz-sheet-tab-label{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:170px}',
  '.sz-sheet-tab-color{position:absolute;left:5px;right:5px;bottom:0;height:3px;border-radius:2px}',
  '.sz-sheet-caret{position:absolute;right:1px;top:50%;transform:translateY(-50%);display:inline-flex;',
  'align-items:center;justify-content:center;width:18px;height:20px;padding:0;border:0;',
  'border-radius:4px;background:transparent;color:inherit;font:inherit;cursor:pointer}',
  '.sz-sheet-caret:hover{background:rgba(60,64,67,.18)}',
  '.sz-sheet-peers{display:inline-flex;align-items:center;gap:2px}',
  '.sz-sheet-peer{display:inline-block;width:7px;height:7px;border-radius:50%;flex:0 0 auto}',
  '.sz-sheet-peer-more{width:auto;height:auto;padding:0 3px;border-radius:6px;color:#fff;',
  'font-size:9px;line-height:12px;font-weight:700}',
  '.sz-sheet-rename{position:absolute;left:2px;top:2px;right:2px;bottom:2px;width:auto;',
  'box-sizing:border-box;min-width:70px;padding:0 6px;font:inherit;z-index:2}',
  '.sz-sheet-drop{position:absolute;width:2px;border-radius:1px;background:#1a73e8;',
  'pointer-events:none;z-index:3}',
  '.sz-sheet-drop[hidden]{display:none}',
  '.sz-sheet-menu{position:fixed;min-width:186px;max-width:min(280px,calc(100vw - 12px));',
  'padding:6px 0;border:1px solid rgba(0,0,0,.18);border-radius:8px;background:#fff;color:#202124;',
  'box-shadow:0 6px 20px rgba(0,0,0,.22);font-size:13px}',
  '.sz-sheet-menu[hidden]{display:none}',
  '.sz-sheet-menu-item{display:flex;align-items:center;gap:8px;width:100%;box-sizing:border-box;',
  'padding:7px 14px;border:0;background:transparent;color:inherit;font:inherit;text-align:left;',
  'cursor:pointer}',
  '.sz-sheet-menu-item:hover:not(:disabled){background:rgba(60,64,67,.10)}',
  '.sz-sheet-menu-item:disabled{opacity:.45;cursor:default}',
  '.sz-sheet-menu-sep{height:1px;margin:5px 0;background:currentColor;opacity:.16}',
  '.sz-sheet-menu-title{padding:4px 14px 6px;font-weight:600;opacity:.75}',
  '.sz-sheet-swatches{display:grid;grid-template-columns:repeat(6,20px);gap:6px;padding:2px 14px 8px}',
  '.sz-sheet-swatch{width:20px;height:20px;padding:0;border:1px solid rgba(0,0,0,.22);',
  'border-radius:4px;cursor:pointer}',
  '@media (prefers-color-scheme:dark){',
  '.sz-sheet-menu{background:#2a2c2f;color:#e8eaed;border-color:rgba(255,255,255,.16)}',
  '.sz-sheet-add:hover,.sz-sheet-tab:hover,.sz-sheet-caret:hover{background:rgba(255,255,255,.10)}}',
].join('');

let cssInjected = false;
function injectFallbackCss() {
  if (cssInjected || typeof document === 'undefined' || !document.head) return;
  cssInjected = true;
  const el = document.createElement('style');
  el.id = 'sz-sheetbar-fallback';
  el.textContent = FALLBACK_CSS;
  document.head.prepend(el); // first in <head> => public/css/style.css wins
}

/** '#ABC' / 'abc123' -> '#aabbcc', or '' when unusable. */
function normHex(value) {
  if (typeof value !== 'string') return '';
  const s = value.trim();
  if (!HEX_COLOR.test(s)) return '';
  const body = s.slice(1).toLowerCase();
  if (body.length === 3) {
    return '#' + body.charAt(0) + body.charAt(0) + body.charAt(1) + body.charAt(1) +
      body.charAt(2) + body.charAt(2);
  }
  return '#' + body;
}

/** Wrap icon geometry in a stroked 24x24 <svg>, matching toolbar.js. */
function ico(inner, size) {
  const px = size || 16;
  return '<svg viewBox="0 0 24 24" width="' + px + '" height="' + px + '" aria-hidden="true" ' +
    'focusable="false" style="fill:none" fill="none" stroke="currentColor" stroke-width="2" ' +
    'stroke-linecap="round" stroke-linejoin="round">' + inner + '</svg>';
}

const ICON_PLUS = '<path d="M12 5v14M5 12h14"/>';
const ICON_CARET = '<path d="M7 10l5 5 5-5"/>';

/** Read only what the bar needs out of whatever the host passed as a sheet. */
function normalizeSheets(list) {
  const out = [];
  if (!Array.isArray(list)) return out;
  const seen = new Set();
  for (const s of list) {
    if (!s || typeof s !== 'object') continue;
    const id = s.id == null ? '' : String(s.id);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const name = s.name == null ? '' : String(s.name);
    out.push({ id, name, color: normHex(s.color) });
  }
  return out;
}

/** Group peers by the sheet they are looking at. */
function groupPeers(peers) {
  const map = new Map();
  if (!Array.isArray(peers)) return map;
  for (const p of peers) {
    if (!p || typeof p !== 'object') continue;
    const sheetId = p.sheetId == null ? '' : String(p.sheetId);
    if (!sheetId) continue;
    const id = p.id == null ? '' : String(p.id);
    const name = p.name == null || String(p.name).trim() === '' ? '익명' : String(p.name).trim();
    const color = normHex(p.color) || colorForId(id);
    if (!map.has(sheetId)) map.set(sheetId, []);
    map.get(sheetId).push({ id, name, color });
  }
  return map;
}

/** Cheap change key for one tab's peer dots. */
function peerKey(list) {
  if (!list || list.length === 0) return '';
  let k = '';
  for (const p of list) k += p.id + '\u0002' + p.color + '\u0001';
  return k;
}

export class SheetBar {
  /**
   * @param {HTMLElement} root  an empty element supplied by index.html
   * @param {{onCommand?: (name: string, payload?: *) => void}} [options]
   */
  constructor(root, options = {}) {
    if (!root || typeof root.appendChild !== 'function') {
      throw new TypeError('SheetBar: 시트 탭을 붙일 root 엘리먼트가 필요합니다');
    }
    this.root = root;
    this.onCommand = typeof options.onCommand === 'function' ? options.onCommand : () => {};

    /** @type {{sheets: Array<{id:string,name:string,color:string}>, activeId: string|null, peers: Array}} */
    this.state = { sheets: [], activeId: null, peers: [] };

    this._listKey = '\u0000';                 // never equal to a real key => first paint rebuilds
    this._byId = new Map();                   // sheetId -> normalized sheet
    this._slots = new Map();                  // sheetId -> slot element
    this._tabs = new Map();                   // sheetId -> tab button
    this._labels = new Map();                 // sheetId -> label span
    this._colorBars = new Map();              // sheetId -> underline span
    this._peerBoxes = new Map();              // sheetId -> peer stack span
    this._peerKeys = new Map();               // sheetId -> last painted peer key
    this._painted = new Map();                // sheetId -> { name, color }
    this._peerGroups = new Map();

    this._rename = null;                      // { sheetId, input }
    this._renameClosing = false;
    this._drag = null;                        // { sheetId, slot, tab, pointerId, startX, moved, index }
    this._menuFor = null;                     // sheetId the open menu belongs to
    this._menuAnchor = null;
    this._cancelFrame = null;
    this._frameJobs = new Map();
    this._suppressNextClick = false;
    this._destroyed = false;

    injectFallbackCss();
    this._build();
    this._bindGlobal();
  }

  // ------------------------------------------------------------------ build

  _build() {
    this.root.textContent = '';

    const bar = document.createElement('div');
    bar.className = 'sz-sheetbar';
    this.el = bar;

    const add = document.createElement('button');
    add.type = 'button';
    add.className = 'sz-sheet-add';
    add.title = '시트 추가';
    add.setAttribute('aria-label', '시트 추가');
    add.innerHTML = ico(ICON_PLUS, 18);
    add.addEventListener('click', (ev) => {
      ev.preventDefault();
      this._closeMenu(false);
      this._endRename(true);
      // The '+' mirrors Google Sheets: a new sheet always lands at the end.
      this.emit('add', { afterId: null });
    });
    this.addBtn = add;
    bar.appendChild(add);

    const tabs = document.createElement('div');
    tabs.className = 'sz-sheet-tabs';
    tabs.setAttribute('role', 'tablist');
    tabs.setAttribute('aria-label', '시트 탭');
    tabs.setAttribute('aria-orientation', 'horizontal');
    this.tabs = tabs;

    tabs.addEventListener('click', (ev) => this._onTabsClick(ev));
    tabs.addEventListener('dblclick', (ev) => this._onTabsDblClick(ev));
    tabs.addEventListener('keydown', (ev) => this._onTabsKeyDown(ev));
    tabs.addEventListener('pointerdown', (ev) => this._onPointerDown(ev));
    tabs.addEventListener('contextmenu', (ev) => this._onTabsContextMenu(ev));
    tabs.addEventListener('wheel', (ev) => this._onWheel(ev), { passive: false });
    bar.appendChild(tabs);

    const drop = document.createElement('div');
    drop.className = 'sz-sheet-drop';
    drop.hidden = true;
    drop.setAttribute('aria-hidden', 'true');
    this.drop = drop;
    tabs.appendChild(drop);

    this.root.appendChild(bar);
  }

  _bindGlobal() {
    this._onDocDown = (ev) => {
      if (this._menuFor === null) return;
      if (this.menu && this.menu.contains(ev.target)) return;
      if (this._menuAnchor && this._menuAnchor.contains(ev.target)) return;
      this._closeMenu(false);
    };
    this._onDocKey = (ev) => {
      if (ev.key === 'Escape' && this._menuFor !== null) {
        ev.preventDefault();
        this._closeMenu(true);
      }
    };
    this._onReflow = () => { if (this._menuFor !== null) this._closeMenu(false); };

    document.addEventListener('pointerdown', this._onDocDown, true);
    document.addEventListener('keydown', this._onDocKey, true);
    window.addEventListener('resize', this._onReflow);
    window.addEventListener('scroll', this._onReflow, true);
  }

  emit(name, payload) {
    try {
      this.onCommand(name, payload);
    } catch (e) {
      console.error('[sheetbar] 명령 처리 실패: ' + name, e);
    }
  }

  // ---------------------------------------------------------------- painting

  /**
   * Reflect the host's view of the document into the strip.
   * Every key is optional; omitted keys keep their previous value.
   *
   * @param {{sheets?: Array, activeId?: string|null, peers?: Array}} [next]
   */
  setState(next = {}) {
    if (this._destroyed) return;
    const s = next && typeof next === 'object' ? next : {};

    if ('sheets' in s) this.state.sheets = normalizeSheets(s.sheets);
    if ('activeId' in s) this.state.activeId = s.activeId == null ? null : String(s.activeId);
    if ('peers' in s) this.state.peers = Array.isArray(s.peers) ? s.peers : [];

    const sheets = this.state.sheets;
    this._byId = new Map(sheets.map((sh) => [sh.id, sh]));

    // The active id must name a real sheet; otherwise nothing is selected.
    const activeId = this._byId.has(this.state.activeId) ? this.state.activeId : null;
    const activeChanged = activeId !== this._activeShown;

    const listKey = sheets.map((sh) => sh.id).join('\u0001');
    const rebuilt = listKey !== this._listKey;
    if (rebuilt) {
      this._listKey = listKey;
      this._rebuildTabs();
    }

    this._peerGroups = groupPeers(this.state.peers);

    for (const sheet of sheets) {
      this._paintTab(sheet, sheet.id === activeId);
    }
    this._activeShown = activeId;

    // Only chase the active tab when it actually moved: doing it on every call
    // would fight a user who scrolled the strip by hand while peers move around.
    if (rebuilt || activeChanged) this._scheduleScrollIntoView();

    // A menu or an editor that belonged to a now-deleted sheet must not linger.
    if (this._menuFor !== null && !this._byId.has(this._menuFor)) this._closeMenu(false);
    if (this._rename && !this._byId.has(this._rename.sheetId)) this._endRename(false);
  }

  _rebuildTabs() {
    const restoreFocus = this._hasFocus();
    this._endRename(false);
    this._closeMenu(false);
    this._cancelDrag();

    // Keep the drop indicator; it is a child of the container, not of a tab.
    for (const slot of this._slots.values()) {
      if (slot.parentNode === this.tabs) this.tabs.removeChild(slot);
    }
    this._slots.clear();
    this._tabs.clear();
    this._labels.clear();
    this._colorBars.clear();
    this._peerBoxes.clear();
    this._peerKeys.clear();
    this._painted.clear();

    for (const sheet of this.state.sheets) {
      const slot = this._buildSlot(sheet);
      this.tabs.insertBefore(slot, this.drop);
    }

    if (restoreFocus) {
      this._scheduleFrame('focus', () => {
        const target = this._tabs.get(this._activeShown) || this._firstTab();
        if (target) target.focus();
      });
    }
  }

  _buildSlot(sheet) {
    const slot = document.createElement('div');
    slot.className = 'sz-sheet-tab-slot';
    slot.setAttribute('role', 'presentation');
    slot.dataset.id = sheet.id;

    const tab = document.createElement('button');
    tab.type = 'button';
    tab.className = 'sz-sheet-tab';
    tab.id = 'sz-sheet-tab-' + sheet.id;
    tab.dataset.id = sheet.id;
    tab.setAttribute('role', 'tab');
    tab.setAttribute('aria-selected', 'false');
    tab.tabIndex = -1;
    // A tab drag must not be stolen by the browser's touch panning.
    tab.style.touchAction = 'none';

    const label = document.createElement('span');
    label.className = 'sz-sheet-tab-label';
    tab.appendChild(label);

    const peers = document.createElement('span');
    peers.className = 'sz-sheet-peers';
    tab.appendChild(peers);

    const colorBar = document.createElement('span');
    colorBar.className = 'sz-sheet-tab-color';
    colorBar.setAttribute('aria-hidden', 'true');
    colorBar.hidden = true;
    tab.appendChild(colorBar);

    const caret = document.createElement('button');
    caret.type = 'button';
    caret.className = 'sz-sheet-caret';
    caret.dataset.id = sheet.id;
    caret.tabIndex = -1;
    caret.title = '시트 메뉴';
    caret.setAttribute('aria-label', '시트 메뉴');
    caret.setAttribute('aria-haspopup', 'menu');
    caret.setAttribute('aria-expanded', 'false');
    caret.innerHTML = ico(ICON_CARET, 14);

    slot.appendChild(tab);
    slot.appendChild(caret);

    this._slots.set(sheet.id, slot);
    this._tabs.set(sheet.id, tab);
    this._labels.set(sheet.id, label);
    this._colorBars.set(sheet.id, colorBar);
    this._peerBoxes.set(sheet.id, peers);
    return slot;
  }

  /** Patch one existing tab in place — no DOM churn unless something changed. */
  _paintTab(sheet, isActive) {
    const tab = this._tabs.get(sheet.id);
    if (!tab) return;

    const prev = this._painted.get(sheet.id);
    if (!prev || prev.name !== sheet.name) {
      const label = this._labels.get(sheet.id);
      const shown = sheet.name === '' ? '(이름 없음)' : sheet.name;
      if (label) label.textContent = shown;
      tab.title = shown;
    }
    if (!prev || prev.color !== sheet.color) {
      const bar = this._colorBars.get(sheet.id);
      if (bar) {
        bar.hidden = sheet.color === '';
        bar.style.backgroundColor = sheet.color || '';
      }
      // Also exposed as a custom property so a stylesheet can render the colour
      // through the tab itself (border, inset shadow) instead of the child span.
      tab.style.setProperty('--sz-sheet-tab-color', sheet.color || 'transparent');
    }
    this._painted.set(sheet.id, { name: sheet.name, color: sheet.color });

    tab.classList.toggle('sz-sheet-tab-active', isActive);
    tab.setAttribute('aria-selected', isActive ? 'true' : 'false');
    tab.tabIndex = isActive ? 0 : -1;
    const slot = this._slots.get(sheet.id);
    if (slot) slot.dataset.active = isActive ? 'true' : 'false';

    this._paintPeers(sheet);
  }

  _paintPeers(sheet) {
    const box = this._peerBoxes.get(sheet.id);
    if (!box) return;
    const list = this._peerGroups.get(sheet.id) || [];
    const key = peerKey(list);
    if (this._peerKeys.get(sheet.id) === key) return;
    this._peerKeys.set(sheet.id, key);

    while (box.firstChild) box.removeChild(box.firstChild);
    if (list.length === 0) return;

    const shown = list.slice(0, MAX_PEER_DOTS);
    for (const p of shown) {
      const dot = document.createElement('span');
      dot.className = 'sz-sheet-peer';
      dot.style.backgroundColor = p.color;
      dot.title = p.name;
      box.appendChild(dot);
    }
    if (list.length > shown.length) {
      const more = document.createElement('span');
      more.className = 'sz-sheet-peer sz-sheet-peer-more';
      more.textContent = '+' + (list.length - shown.length);
      more.style.backgroundColor = '#5f6368';
      box.appendChild(more);
    }
    const names = list.map((p) => p.name).join(', ');
    box.setAttribute('aria-label', '이 시트를 보고 있는 사용자: ' + names);
    box.title = names;
  }

  // ------------------------------------------------------------- navigation

  _firstTab() {
    for (const sheet of this.state.sheets) {
      const t = this._tabs.get(sheet.id);
      if (t) return t;
    }
    return null;
  }

  /** Is focus currently inside the strip, or inside its floating menu? */
  _hasFocus() {
    const a = document.activeElement;
    if (!a) return false;
    if (this.el && this.el.contains(a)) return true;
    return !!(this.menu && this.menu.contains(a));
  }

  _focusTab(sheetId) {
    const tab = this._tabs.get(sheetId);
    if (tab) tab.focus();
  }

  _select(sheetId) {
    if (!this._byId.has(sheetId)) return;
    if (sheetId === this._activeShown) return;
    this.emit('select', { sheetId });
  }

  /**
   * Run `fn` on the next frame. Jobs are keyed by name so a later call replaces
   * the pending job of the same kind instead of cancelling every other one — one
   * setState can legitimately queue both a focus restore and a scroll.
   */
  _scheduleFrame(name, fn) {
    this._frameJobs.set(name, fn);
    if (this._cancelFrame) return;
    this._cancelFrame = onNextFrame(() => {
      this._cancelFrame = null;
      const jobs = [...this._frameJobs.values()];
      this._frameJobs.clear();
      if (this._destroyed) return;
      for (const job of jobs) job();
    });
  }

  _scheduleScrollIntoView() {
    this._scheduleFrame('scroll', () => this._scrollActiveIntoView());
  }

  /**
   * Bring the active tab inside the scroll viewport. Measured with client rects
   * rather than offsetLeft so it does not care which ancestor happens to be the
   * offset parent under the real stylesheet.
   */
  _scrollActiveIntoView() {
    const slot = this._slots.get(this._activeShown);
    const c = this.tabs;
    if (!slot || !c || typeof c.getBoundingClientRect !== 'function') return;
    const cr = c.getBoundingClientRect();
    const sr = slot.getBoundingClientRect();
    if (!cr.width) return;
    const pad = 10;
    const left = sr.left - cr.left;
    const right = sr.right - cr.left;
    if (left < pad) c.scrollLeft += left - pad;
    else if (right > c.clientWidth - pad) c.scrollLeft += right - (c.clientWidth - pad);
  }

  /** Let a plain vertical wheel scroll the strip horizontally. */
  _onWheel(ev) {
    const c = this.tabs;
    if (!c || c.scrollWidth <= c.clientWidth) return;
    if (ev.deltaX !== 0 || ev.deltaY === 0) return;
    ev.preventDefault();
    c.scrollLeft += ev.deltaY;
  }

  // ----------------------------------------------------------------- events

  _tabIdFromEvent(ev) {
    const el = ev.target && ev.target.closest ? ev.target.closest('.sz-sheet-tab') : null;
    return el && el.dataset ? el.dataset.id || null : null;
  }

  _caretFromEvent(ev) {
    return ev.target && ev.target.closest ? ev.target.closest('.sz-sheet-caret') : null;
  }

  _onTabsClick(ev) {
    const caret = this._caretFromEvent(ev);
    if (caret) {
      ev.preventDefault();
      const id = caret.dataset.id;
      if (this._menuFor === id) { this._closeMenu(true); return; }
      this._select(id);
      this._openMenu(id, caret);
      return;
    }
    if (this._suppressNextClick) {
      this._suppressNextClick = false;
      return;
    }
    const id = this._tabIdFromEvent(ev);
    if (!id) return;
    ev.preventDefault();
    // Pointer presses already selected on pointerdown; this path only serves
    // keyboard activation (Space on a focused tab), which reports detail 0.
    if (ev.detail === 0) this._select(id);
  }

  _onTabsDblClick(ev) {
    if (this._caretFromEvent(ev)) return;
    const id = this._tabIdFromEvent(ev);
    if (!id) return;
    ev.preventDefault();
    this._startRename(id);
  }

  _onTabsContextMenu(ev) {
    const id = this._tabIdFromEvent(ev) ||
      (this._caretFromEvent(ev) ? this._caretFromEvent(ev).dataset.id : null);
    if (!id) return;
    ev.preventDefault();
    this._select(id);
    this._openMenu(id, this._tabs.get(id) || this.el);
  }

  _onTabsKeyDown(ev) {
    if (this._rename) return;                  // the editor stops its own keys
    const id = this._tabIdFromEvent(ev);
    if (!id) return;
    const sheets = this.state.sheets;
    const idx = sheets.findIndex((s) => s.id === id);
    if (idx === -1) return;

    let move = -1;
    if (ev.key === 'ArrowRight') move = Math.min(sheets.length - 1, idx + 1);
    else if (ev.key === 'ArrowLeft') move = Math.max(0, idx - 1);
    else if (ev.key === 'Home') move = 0;
    else if (ev.key === 'End') move = sheets.length - 1;

    if (move !== -1) {
      ev.preventDefault();
      const target = sheets[move];
      if (!target) return;
      this._focusTab(target.id);
      this._select(target.id);
      return;
    }

    if (ev.key === 'Enter' || ev.key === 'F2') {
      // preventDefault also stops Enter from activating the button (a second select).
      ev.preventDefault();
      this._startRename(id);
      return;
    }
    if (ev.key === 'Delete') {
      ev.preventDefault();
      this._openMenu(id, this._tabs.get(id) || this.el);
    }
  }

  // ------------------------------------------------------------ inline rename

  _startRename(sheetId) {
    const slot = this._slots.get(sheetId);
    const sheet = this._byId.get(sheetId);
    if (!slot || !sheet) return;
    this._closeMenu(false);
    if (this._rename && this._rename.sheetId === sheetId) {
      this._rename.input.focus();
      this._rename.input.select();
      return;
    }
    this._endRename(true);

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'sz-sheet-rename';
    input.value = sheet.name;
    input.maxLength = MAX_NAME_LEN;
    input.spellcheck = false;
    input.autocomplete = 'off';
    input.setAttribute('aria-label', '시트 이름');
    input.title = 'Enter로 확정, Esc로 취소';

    input.addEventListener('keydown', (ev) => {
      ev.stopPropagation();                     // never reaches the tablist or the grid
      if (ev.key === 'Enter') {
        ev.preventDefault();
        this._endRename(true);
        this._focusTab(sheetId);
      } else if (ev.key === 'Escape') {
        ev.preventDefault();
        this._endRename(false);
        this._focusTab(sheetId);
      }
    });
    input.addEventListener('blur', () => this._endRename(true));
    input.addEventListener('pointerdown', (ev) => ev.stopPropagation());  // no drag from here
    input.addEventListener('dblclick', (ev) => ev.stopPropagation());
    input.addEventListener('click', (ev) => ev.stopPropagation());

    slot.appendChild(input);
    this._rename = { sheetId, input };
    // Focus after the node is laid out; some browsers ignore focus on a fresh node.
    this._scheduleFrame('rename', () => {
      if (this._rename && this._rename.input === input) {
        input.focus();
        input.select();
      }
    });
  }

  /**
   * Close the inline editor.
   * @param {boolean} commit  true to emit 'rename' when the text really changed
   */
  _endRename(commit) {
    const r = this._rename;
    if (!r || this._renameClosing) return;
    this._renameClosing = true;
    this._rename = null;
    const raw = r.input.value;
    if (r.input.parentNode) r.input.parentNode.removeChild(r.input);
    this._renameClosing = false;
    if (!commit) return;

    const name = raw.trim().slice(0, MAX_NAME_LEN);
    const sheet = this._byId.get(r.sheetId);
    if (!name) return;                          // empty name reverts, like Sheets
    if (sheet && name === sheet.name) return;   // nothing to say
    this.emit('rename', { sheetId: r.sheetId, name });
  }

  // ------------------------------------------------------------------- menu

  _ensureMenu() {
    if (this.menu) return this.menu;
    const menu = document.createElement('div');
    menu.className = 'sz-sheet-menu';
    menu.setAttribute('role', 'menu');
    menu.setAttribute('aria-label', '시트 메뉴');
    menu.hidden = true;
    menu.style.zIndex = '2147483000';
    menu.addEventListener('keydown', (ev) => this._onMenuKeyDown(ev));
    document.body.appendChild(menu);
    this.menu = menu;
    return menu;
  }

  _menuItem(label, action, disabled, hint) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'sz-sheet-menu-item';
    b.setAttribute('role', 'menuitem');
    b.dataset.act = action;
    b.textContent = label;
    if (hint) b.title = hint;
    if (disabled) {
      b.disabled = true;
      b.setAttribute('aria-disabled', 'true');
    }
    b.addEventListener('click', (ev) => {
      ev.preventDefault();
      if (b.disabled) return;
      this._runMenuAction(action, b.dataset.color);
    });
    return b;
  }

  _openMenu(sheetId, anchor) {
    if (!this._byId.has(sheetId)) return;
    this._endRename(true);
    this._menuFor = sheetId;
    this._menuAnchor = anchor || null;
    this._renderMenu(false);
    if (anchor && anchor.setAttribute && anchor.classList &&
        anchor.classList.contains('sz-sheet-caret')) {
      anchor.setAttribute('aria-expanded', 'true');
    }
    this._positionMenu();
    this._focusFirstMenuItem();
  }

  /** @param {boolean} colorMode  true renders the colour submenu */
  _renderMenu(colorMode) {
    const menu = this._ensureMenu();
    menu.hidden = false;
    while (menu.firstChild) menu.removeChild(menu.firstChild);

    if (!colorMode) {
      const onlyOne = this.state.sheets.length <= 1;
      menu.appendChild(this._menuItem('이름 바꾸기', 'rename'));
      menu.appendChild(this._menuItem('복사본 만들기', 'duplicate'));
      menu.appendChild(this._menuItem('색상 변경', 'color'));
      const sep = document.createElement('div');
      sep.className = 'sz-sheet-menu-sep';
      sep.setAttribute('aria-hidden', 'true');
      menu.appendChild(sep);
      menu.appendChild(this._menuItem(
        '삭제', 'delete', onlyOne,
        onlyOne ? '시트가 하나뿐이라 삭제할 수 없습니다' : ''
      ));
      return;
    }

    const title = document.createElement('div');
    title.className = 'sz-sheet-menu-title';
    title.textContent = '탭 색상';
    menu.appendChild(title);

    const grid = document.createElement('div');
    grid.className = 'sz-sheet-swatches';
    const current = (this._byId.get(this._menuFor) || {}).color || '';
    for (const [hex, label] of TAB_COLORS) {
      const sw = document.createElement('button');
      sw.type = 'button';
      sw.className = 'sz-sheet-swatch';
      sw.setAttribute('role', 'menuitemradio');
      sw.setAttribute('aria-checked', hex === current ? 'true' : 'false');
      sw.dataset.act = 'pick';
      sw.dataset.color = hex;
      sw.title = label;
      sw.setAttribute('aria-label', label);
      sw.style.backgroundColor = hex;
      sw.addEventListener('click', (ev) => {
        ev.preventDefault();
        this._runMenuAction('pick', hex);
      });
      grid.appendChild(sw);
    }
    menu.appendChild(grid);

    menu.appendChild(this._menuItem('색상 없음', 'pick-none'));
    const sep = document.createElement('div');
    sep.className = 'sz-sheet-menu-sep';
    sep.setAttribute('aria-hidden', 'true');
    menu.appendChild(sep);
    menu.appendChild(this._menuItem('뒤로', 'back'));
  }

  _runMenuAction(action, color) {
    const sheetId = this._menuFor;
    if (sheetId === null) return;

    if (action === 'color') {
      this._renderMenu(true);
      this._positionMenu();
      this._focusFirstMenuItem();
      return;
    }
    if (action === 'back') {
      this._renderMenu(false);
      this._positionMenu();
      this._focusFirstMenuItem();
      return;
    }

    this._closeMenu(false);
    if (action === 'rename') { this._startRename(sheetId); return; }
    if (action === 'duplicate') { this.emit('duplicate', { sheetId }); return; }
    if (action === 'delete') {
      if (this.state.sheets.length <= 1) return;
      this.emit('delete', { sheetId });
      return;
    }
    if (action === 'pick') { this.emit('color', { sheetId, color: normHex(color) || null }); return; }
    if (action === 'pick-none') this.emit('color', { sheetId, color: null });
  }

  _positionMenu() {
    const menu = this.menu;
    if (!menu) return;
    const anchor = this._menuAnchor && this._menuAnchor.getBoundingClientRect
      ? this._menuAnchor : this.el;
    const r = anchor.getBoundingClientRect();
    // Vertically the menu clears the WHOLE strip, not just the caret: a caret is
    // centred inside its tab, so anchoring to it would cover the tab row.
    const bar = this.el && this.el.getBoundingClientRect ? this.el.getBoundingClientRect() : r;
    const w = menu.offsetWidth || 186;
    const h = menu.offsetHeight || 160;
    const left = Math.max(4, Math.min(r.left, window.innerWidth - w - 6));
    // The strip sits at the bottom of the window, so open upward by default.
    let top = Math.min(r.top, bar.top) - h - 4;
    if (top < 4) {
      top = Math.min(Math.max(r.bottom, bar.bottom) + 4, Math.max(4, window.innerHeight - h - 4));
    }
    menu.style.left = left + 'px';
    menu.style.top = top + 'px';
  }

  _menuItems() {
    if (!this.menu) return [];
    return Array.prototype.filter.call(
      this.menu.querySelectorAll('.sz-sheet-menu-item, .sz-sheet-swatch'),
      (b) => !b.disabled
    );
  }

  _focusFirstMenuItem() {
    const items = this._menuItems();
    if (items.length) items[0].focus();
  }

  _onMenuKeyDown(ev) {
    if (this._menuFor === null) return;
    const items = this._menuItems();
    if (items.length === 0) return;
    const at = items.indexOf(document.activeElement);
    if (ev.key === 'ArrowDown' || ev.key === 'ArrowRight') {
      ev.preventDefault();
      items[(at + 1 + items.length) % items.length].focus();
    } else if (ev.key === 'ArrowUp' || ev.key === 'ArrowLeft') {
      ev.preventDefault();
      items[(at - 1 + items.length) % items.length].focus();
    } else if (ev.key === 'Home') {
      ev.preventDefault();
      items[0].focus();
    } else if (ev.key === 'End') {
      ev.preventDefault();
      items[items.length - 1].focus();
    } else if (ev.key === 'Tab') {
      ev.preventDefault();
      this._closeMenu(true);
    }
  }

  /** @param {boolean} returnFocus  move focus back to the tab the menu belonged to */
  _closeMenu(returnFocus) {
    const sheetId = this._menuFor;
    if (sheetId === null) return;
    this._menuFor = null;
    if (this._menuAnchor && this._menuAnchor.classList &&
        this._menuAnchor.classList.contains('sz-sheet-caret')) {
      this._menuAnchor.setAttribute('aria-expanded', 'false');
    }
    this._menuAnchor = null;
    if (this.menu) this.menu.hidden = true;
    if (returnFocus) this._focusTab(sheetId);
  }

  // ------------------------------------------------------- drag to reorder

  _onPointerDown(ev) {
    this._suppressNextClick = false;                           // a fresh gesture
    if (ev.button !== undefined && ev.button !== 0) return;    // primary button only
    if (this._caretFromEvent(ev)) return;                      // the caret opens the menu
    if (ev.target && ev.target.closest && ev.target.closest('.sz-sheet-rename')) return;
    const id = this._tabIdFromEvent(ev);
    if (!id) return;
    const tab = this._tabs.get(id);
    const slot = this._slots.get(id);
    if (!tab || !slot) return;

    this._closeMenu(false);
    if (!this._rename || this._rename.sheetId !== id) this._endRename(true);

    // Select immediately: a press should switch sheets before the drag decides.
    this._select(id);

    this._drag = {
      sheetId: id,
      tab,
      slot,
      pointerId: ev.pointerId,
      startX: ev.clientX,
      moved: false,
      index: -1,
    };
    this._onWinMove = (e) => this._onPointerMove(e);
    this._onWinUp = (e) => this._onPointerUp(e);
    this._onWinCancel = () => this._cancelDrag();
    window.addEventListener('pointermove', this._onWinMove);
    window.addEventListener('pointerup', this._onWinUp);
    window.addEventListener('pointercancel', this._onWinCancel);
  }

  _onPointerMove(ev) {
    const d = this._drag;
    if (!d || (ev.pointerId !== undefined && ev.pointerId !== d.pointerId)) return;

    if (!d.moved) {
      if (Math.abs(ev.clientX - d.startX) < DRAG_THRESHOLD) return;
      d.moved = true;
      if (d.tab.setPointerCapture) {
        try { d.tab.setPointerCapture(d.pointerId); } catch (e) { /* capture is optional */ }
      }
      // The drop indicator is absolutely positioned inside the scroll container;
      // make sure that container really is the containing block.
      const pos = window.getComputedStyle(this.tabs).position;
      if (pos === 'static') this.tabs.style.position = 'relative';
      d.tab.style.opacity = '0.45';
      this.drop.hidden = false;
    }
    ev.preventDefault();
    this._edgeScroll(ev.clientX);
    d.index = this._dropIndexAt(ev.clientX);
    this._paintDrop(d.index);
  }

  _onPointerUp(ev) {
    const d = this._drag;
    if (!d || (ev.pointerId !== undefined && ev.pointerId !== d.pointerId)) return;
    const moved = d.moved;
    const sheetId = d.sheetId;
    const insertAt = d.index;
    this._cancelDrag();

    if (!moved) return;
    this._suppressNextClick = true;             // the drop must not re-fire 'select'

    const from = this.state.sheets.findIndex((s) => s.id === sheetId);
    if (from === -1 || insertAt < 0) return;
    // insertAt is an insertion slot in the list that still contains the dragged
    // tab; reorderSheet() takes the final index after removal.
    let target = insertAt > from ? insertAt - 1 : insertAt;
    target = Math.max(0, Math.min(this.state.sheets.length - 1, target));
    if (target === from) return;
    this.emit('reorder', { sheetId, index: target });
  }

  _cancelDrag() {
    const d = this._drag;
    this._drag = null;
    if (this._onWinMove) window.removeEventListener('pointermove', this._onWinMove);
    if (this._onWinUp) window.removeEventListener('pointerup', this._onWinUp);
    if (this._onWinCancel) window.removeEventListener('pointercancel', this._onWinCancel);
    this._onWinMove = null;
    this._onWinUp = null;
    this._onWinCancel = null;
    if (d) {
      d.tab.style.opacity = '';
      if (d.moved && d.tab.releasePointerCapture) {
        try { d.tab.releasePointerCapture(d.pointerId); } catch (e) { /* already released */ }
      }
    }
    if (this.drop) this.drop.hidden = true;
  }

  /** Nudge the strip when the pointer reaches either edge during a drag. */
  _edgeScroll(clientX) {
    const c = this.tabs;
    if (!c || c.scrollWidth <= c.clientWidth) return;
    const r = c.getBoundingClientRect();
    const zone = 28;
    if (clientX < r.left + zone) c.scrollLeft -= 14;
    else if (clientX > r.right - zone) c.scrollLeft += 14;
  }

  /** Insertion slot (0..n) for a pointer at clientX, in the current list order. */
  _dropIndexAt(clientX) {
    const sheets = this.state.sheets;
    for (let i = 0; i < sheets.length; i++) {
      const slot = this._slots.get(sheets[i].id);
      if (!slot) continue;
      const r = slot.getBoundingClientRect();
      if (clientX < r.left + r.width / 2) return i;
    }
    return sheets.length;
  }

  _paintDrop(index) {
    const c = this.tabs;
    const drop = this.drop;
    if (!c || !drop) return;
    const sheets = this.state.sheets;
    const cr = c.getBoundingClientRect();
    let x;
    if (index >= sheets.length) {
      const last = sheets.length ? this._slots.get(sheets[sheets.length - 1].id) : null;
      x = last ? last.getBoundingClientRect().right - cr.left : 0;
    } else {
      const slot = this._slots.get(sheets[index].id);
      x = slot ? slot.getBoundingClientRect().left - cr.left : 0;
    }
    drop.style.left = Math.round(x + c.scrollLeft - 1) + 'px';
    drop.style.top = '2px';
    drop.style.height = Math.max(0, c.clientHeight - 4) + 'px';
  }

  // ---------------------------------------------------------------- teardown

  /** Detach every listener, drop the floating menu and empty the root. */
  destroy() {
    if (this._destroyed) return;
    this._destroyed = true;

    this._endRename(false);
    this._closeMenu(false);
    this._cancelDrag();
    if (this._cancelFrame) { this._cancelFrame(); this._cancelFrame = null; }
    this._frameJobs.clear();

    document.removeEventListener('pointerdown', this._onDocDown, true);
    document.removeEventListener('keydown', this._onDocKey, true);
    window.removeEventListener('resize', this._onReflow);
    window.removeEventListener('scroll', this._onReflow, true);

    if (this.menu && this.menu.parentNode) this.menu.parentNode.removeChild(this.menu);
    this.menu = null;

    this._slots.clear();
    this._tabs.clear();
    this._labels.clear();
    this._colorBars.clear();
    this._peerBoxes.clear();
    this._peerKeys.clear();
    this._painted.clear();
    this._byId.clear();
    this._peerGroups.clear();

    this.root.textContent = '';
    this.el = null;
    this.tabs = null;
    this.drop = null;
  }
}

export default SheetBar;
