// presence.js — collaborator avatars in the header.
//
//   colorForId(id)                 deterministic hue from one of 12 legible colors
//   renderPeers(container, peers, you)  circular initial chips, "+N" past six

const MAX_CHIPS = 6;

// Twelve well-separated, legible hues. Chip text flips to dark on light fills.
const PALETTE = [
  '#1a73e8', // blue
  '#e8710a', // orange
  '#0b8043', // green
  '#d93025', // red
  '#9334e6', // purple
  '#00838f', // teal
  '#c2185b', // pink
  '#f9ab00', // amber
  '#3949ab', // indigo
  '#7cb342', // light green
  '#795548', // brown
  '#546e7a', // blue gray
];

const HEX_COLOR = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

/**
 * Deterministic color for a peer id (FNV-1a over the id, mapped to the palette).
 * @param {string} id
 * @returns {string} hex color
 */
export function colorForId(id) {
  const s = id == null ? '' : String(id);
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return PALETTE[h % PALETTE.length];
}

function validColor(c) {
  return typeof c === 'string' && HEX_COLOR.test(c.trim()) ? c.trim() : null;
}

function hexToRgb(hex) {
  let h = hex.replace('#', '');
  if (h.length === 3) h = h.charAt(0) + h.charAt(0) + h.charAt(1) + h.charAt(1) + h.charAt(2) + h.charAt(2);
  const n = parseInt(h, 16);
  if (!Number.isFinite(n)) return null;
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

/** Readable text color for a filled chip. */
function textColorOn(hex) {
  const rgb = hexToRgb(hex);
  if (!rgb) return '#ffffff';
  const lum = (0.299 * rgb.r + 0.587 * rgb.g + 0.114 * rgb.b) / 255;
  return lum > 0.62 ? '#202124' : '#ffffff';
}

function firstChar(s) {
  const chars = Array.from(String(s));
  return chars.length ? chars[0] : '?';
}

/** 'Ada Lovelace' -> 'AL', '김철수' -> '김', '' -> '?' */
function initials(name) {
  const s = String(name == null ? '' : name).trim();
  if (!s) return '?';
  const words = s.split(/\s+/).filter(Boolean);
  if (words.length >= 2 && /^[A-Za-z]/.test(words[0]) && /^[A-Za-z]/.test(words[1])) {
    return (firstChar(words[0]) + firstChar(words[1])).toUpperCase();
  }
  const ch = firstChar(s);
  return /[a-z]/.test(ch) ? ch.toUpperCase() : ch;
}

function displayName(p) {
  const n = p && p.name != null ? String(p.name).trim() : '';
  return n || '익명';
}

/** Merge `you` in front, drop duplicates by id, resolve colors. */
function normalizePeers(peers, you) {
  const out = [];
  const seen = new Set();
  const add = (p) => {
    if (!p || typeof p !== 'object') return;
    const id = p.id != null ? String(p.id) : '';
    const key = id || '@anon' + out.length;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ id, name: displayName(p), color: validColor(p.color) || colorForId(id) });
  };
  add(you);
  if (Array.isArray(peers)) for (const p of peers) add(p);
  return out;
}

/**
 * Base look is applied inline so the chips are correct even before style.css
 * has an opinion; layout/spacing of the container stays with the stylesheet.
 */
function styleChip(el, bg, isYou) {
  const s = el.style;
  s.boxSizing = 'border-box';
  s.display = 'inline-flex';
  s.alignItems = 'center';
  s.justifyContent = 'center';
  s.width = '26px';
  s.height = '26px';
  s.borderRadius = '50%';
  s.flex = '0 0 auto';
  s.fontSize = '11px';
  s.fontWeight = '700';
  s.lineHeight = '1';
  s.letterSpacing = '0';
  s.overflow = 'hidden';
  s.whiteSpace = 'nowrap';
  s.userSelect = 'none';
  s.cursor = 'default';
  s.background = bg;
  s.color = textColorOn(bg);
  if (isYou) {
    // Subtle ring, separated from the fill by a small gap.
    s.boxShadow = '0 0 0 2px var(--sz-peer-ring-gap, #ffffff), 0 0 0 3px ' + bg;
  }
}

/**
 * Paint the avatar chips for the current collaborators.
 * @param {Element|string} container
 * @param {Array<{id:string,name:string,color?:string}>} peers
 * @param {{id:string,name:string,color?:string}} [you]
 */
export function renderPeers(container, peers, you) {
  const el = typeof container === 'string'
    ? (typeof document !== 'undefined' ? document.querySelector(container) : null)
    : container;
  if (!el || typeof el.appendChild !== 'function') return;
  const doc = el.ownerDocument || (typeof document !== 'undefined' ? document : null);
  if (!doc) return;

  const list = normalizePeers(peers, you);
  const youId = you && you.id != null ? String(you.id) : null;

  while (el.firstChild) el.removeChild(el.firstChild);

  const shown = list.slice(0, MAX_CHIPS);
  const hidden = list.slice(MAX_CHIPS);

  for (const peer of shown) {
    const isYou = youId !== null && peer.id !== '' && peer.id === youId;
    const chip = doc.createElement('span');
    chip.className = isYou ? 'sz-peer sz-peer-you' : 'sz-peer';
    if (peer.id) chip.setAttribute('data-id', peer.id);
    const label = isYou ? peer.name + ' (나)' : peer.name;
    chip.title = label;
    chip.setAttribute('aria-label', label);
    chip.textContent = initials(peer.name);
    styleChip(chip, peer.color, isYou);
    el.appendChild(chip);
  }

  if (hidden.length > 0) {
    const more = doc.createElement('span');
    more.className = 'sz-peer sz-peer-more';
    more.textContent = '+' + hidden.length;
    const label = '외 ' + hidden.length + '명: ' + hidden.map((p) => p.name).join(', ');
    more.title = label;
    more.setAttribute('aria-label', label);
    styleChip(more, '#5f6368', false);
    el.appendChild(more);
  }
}
