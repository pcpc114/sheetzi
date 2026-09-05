// format.js — turns engine values into the strings painted in a cell.
//
// Value domain (see docs/SPEC.md section 6):
//   number | string | boolean | null | FormulaError | RangeValue
//
// Style keys consumed here: { fmt, decimals, align }.

import { serialToDate } from '/shared/formula/values.js';

const NUM_ERROR = '#NUM!'; // shown for NaN / Infinity, which have no display form

/** Duck-typed FormulaError check (avoids an instanceof across module copies). */
function isFormulaError(v) {
  return !!v && typeof v === 'object' && typeof v.code === 'string' && v.code.charAt(0) === '#';
}

/** Duck-typed RangeValue check. */
function isRangeValue(v) {
  return !!v && typeof v === 'object' && Array.isArray(v.rows) && typeof v.flat === 'function';
}

function pad2(n) {
  return n < 10 ? '0' + n : String(n);
}

function pad4(n) {
  const neg = n < 0;
  let s = String(Math.abs(n));
  while (s.length < 4) s = '0' + s;
  return neg ? '-' + s : s;
}

/** Clamp a style.decimals value into a range toFixed can honour. */
function clampDecimals(d, fallback) {
  const n = Number(d);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(20, Math.max(0, Math.round(n)));
}

/** Insert thousands separators into an integer digit string. */
function group(intDigits) {
  return intDigits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** Fixed-decimal rendering with thousands separators; never yields "-0.00". */
function groupFixed(n, decimals) {
  if (!Number.isFinite(n)) return NUM_ERROR;
  if (Math.abs(n) >= 1e21) return formatGeneral(n); // toFixed would go exponential
  let s = n.toFixed(decimals);
  let neg = s.charAt(0) === '-';
  if (neg) s = s.slice(1);
  if (!/[1-9]/.test(s)) neg = false; // rounded down to zero
  const dot = s.indexOf('.');
  const int = dot < 0 ? s : s.slice(0, dot);
  const frac = dot < 0 ? '' : s.slice(dot + 1);
  const out = frac ? group(int) + '.' + frac : group(int);
  return neg ? '-' + out : out;
}

/**
 * "general": up to 10 significant digits, no trailing zeros, switching to
 * exponential notation at or beyond 1e11 and below 1e-10.
 */
function formatGeneral(n) {
  if (!Number.isFinite(n)) return NUM_ERROR;
  if (n === 0) return '0';
  const abs = Math.abs(n);

  if (abs >= 1e11 || abs < 1e-10) {
    const parts = n.toExponential(9).split('e'); // 10 significant digits
    let mantissa = parts[0];
    if (mantissa.indexOf('.') >= 0) {
      mantissa = mantissa.replace(/0+$/, '').replace(/\.$/, '');
    }
    const expPart = parts[1] || '+0';
    const sign = expPart.charAt(0) === '-' ? '-' : '+';
    const digits = expPart.replace(/^[+-]/, '');
    return mantissa + 'E' + sign + digits;
  }

  const exp = Math.floor(Math.log10(abs));
  const decimals = Math.min(20, Math.max(0, 9 - exp));
  let s = n.toFixed(decimals);
  if (s.indexOf('.') >= 0) s = s.replace(/0+$/, '').replace(/\.$/, '');
  if (s === '-0') return '0';
  return s;
}

/** Excel/Sheets date serial -> YYYY-MM-DD (the serial epoch is UTC). */
function formatDateSerial(n) {
  if (!Number.isFinite(n)) return NUM_ERROR;
  const d = serialToDate(n);
  if (!(d instanceof Date) || Number.isNaN(d.getTime())) return formatGeneral(n);
  return formatDateObject(d);
}

function formatDateObject(d) {
  return pad4(d.getUTCFullYear()) + '-' + pad2(d.getUTCMonth() + 1) + '-' + pad2(d.getUTCDate());
}

/** Fractional part of a date serial -> HH:MM:SS. */
function formatTimeSerial(n) {
  if (!Number.isFinite(n)) return NUM_ERROR;
  const frac = n - Math.floor(n); // always in [0, 1), including for negatives
  let secs = Math.round(frac * 86400);
  if (secs >= 86400) secs -= 86400; // rounding may push 23:59:59.7 to a full day
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  return pad2(h) + ':' + pad2(m) + ':' + pad2(s);
}

function formatTimeObject(d) {
  return pad2(d.getUTCHours()) + ':' + pad2(d.getUTCMinutes()) + ':' + pad2(d.getUTCSeconds());
}

/** Shortest round-trip text for a number (matches toText semantics). */
function numberToText(n) {
  if (!Number.isFinite(n)) return NUM_ERROR;
  return String(n);
}

function formatNumber(n, fmt, style) {
  switch (fmt) {
    case 'number':
      return groupFixed(n, clampDecimals(style.decimals, 2));
    case 'currency': {
      const decimals = clampDecimals(style.decimals, 0);
      const body = groupFixed(Math.abs(n), decimals);
      const negative = n < 0 && /[1-9]/.test(body);
      return (negative ? '-₩' : '₩') + body;
    }
    case 'percent':
      return groupFixed(n * 100, clampDecimals(style.decimals, 0)) + '%';
    case 'date':
      return formatDateSerial(n);
    case 'time':
      return formatTimeSerial(n);
    case 'text':
      return numberToText(n);
    case 'general':
    default:
      return formatGeneral(n);
  }
}

/**
 * Render a cell value for display.
 * @param {*} value  number | string | boolean | null | FormulaError | RangeValue
 * @param {object} [style]
 * @returns {string}
 */
export function formatValue(value, style) {
  const st = style && typeof style === 'object' ? style : {};
  const fmt = typeof st.fmt === 'string' ? st.fmt : 'general';

  if (value === null || value === undefined) return '';
  if (isFormulaError(value)) return value.code;
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';

  if (typeof value === 'number') return formatNumber(value, fmt, st);

  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return NUM_ERROR;
    if (fmt === 'time') return formatTimeObject(value);
    return formatDateObject(value);
  }

  if (isRangeValue(value)) {
    // A range that reached a cell coerces to its top-left value.
    const first = value.flat()[0];
    if (isRangeValue(first)) return '';
    return formatValue(first === undefined ? null : first, style);
  }

  return String(value);
}

/**
 * Default horizontal alignment for a value, overridable by style.align.
 * @returns {'left'|'center'|'right'}
 */
export function alignFor(value, style) {
  const st = style && typeof style === 'object' ? style : {};
  if (st.align === 'left' || st.align === 'center' || st.align === 'right') return st.align;

  if (isFormulaError(value)) return 'center';
  if (value === null || value === undefined) return 'left';
  if (st.fmt === 'text') return 'left'; // text format renders numbers as raw text
  if (typeof value === 'number') return 'right';
  if (typeof value === 'boolean') return 'right';
  if (value instanceof Date) return 'right';
  if (isRangeValue(value)) {
    const first = value.flat()[0];
    return isRangeValue(first) ? 'left' : alignFor(first === undefined ? null : first, style);
  }
  return 'left';
}
