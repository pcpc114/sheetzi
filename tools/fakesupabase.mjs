#!/usr/bin/env node
/**
 * fakesupabase — a PostgREST stand-in for the three 시트지 tables (SPEC 29.5).
 *
 * The Supabase backend (SPEC 29.3) is the copy of the document store that survives the
 * disk dying, so its durability guarantees have to be TESTED, not asserted. Testing them
 * against a real project would mean a real service key, which no harness may carry and no
 * contributor should need. This is the stand-in: the same wire protocol over the same
 * three tables, kept in memory, spoken with node:http and nothing else.
 *
 *   import { start } from './fakesupabase.mjs';
 *   const fake = await start(0);            // 0 picks a free port
 *   // spawn the server with SUPABASE_URL = fake.url and any non-empty SUPABASE_SERVICE_KEY
 *   await fake.stop();
 *
 * It runs in the HARNESS process, not the server's, and that is the whole point:
 * SIGKILLing the server leaves the database standing, exactly as a hosted Postgres would.
 *
 * It is deliberately STRICT. A stand-in that accepts what the real service rejects is
 * worse than no stand-in, because it turns "tested" into "tested against something
 * friendlier than production":
 *
 *   - a request with no `apikey` is 401; `Authorization` is OPTIONAL, because it is
 *     optional at the real service too — see requireAuth, which is where the two key
 *     formats Supabase runs today are modelled;
 *   - an unknown table, column or operator, and a NOT NULL violation, are the errors
 *     PostgREST returns, with its codes;
 *   - a duplicate primary key is 23505 unless the request asked for
 *     `Prefer: resolution=merge-duplicates`;
 *   - json columns behave like `jsonb`: key order is NOT preserved, so code that depends
 *     on it fails here rather than in production;
 *   - the path is `/rest/v1/<table>`, which is where Supabase serves PostgREST. Anything
 *     else is a 404 naming the expected prefix, because a store that talked to the wrong
 *     path would pass a lenient fake and then fail against the real project.
 *
 * What it is NOT: a database. No transactions, no RLS (the service key bypasses it
 * anyway), no relationships, no `and=`/`or=` logic trees, no RPC. None of those are on
 * the wire between storage/supabaseStore.js and Supabase, so emulating them would only be
 * a way to be wrong about them.
 *
 * The error bodies below are English on purpose: they imitate a specific external service
 * whose messages are English, and translating them would make the imitation less faithful.
 * Everything this file says in its own voice — the CLI, the warnings — is Korean.
 *
 * Run it directly for manual work:
 *
 *   node tools/fakesupabase.mjs --port 54321
 *
 * It never prints a key. It accepts any non-empty one, and printing keys is the habit
 * that eventually prints a real one.
 */
import { createServer } from 'node:http';

// ---------------------------------------------------------------------------
// the schema (SPEC 29.3 — docs/supabase.sql creates exactly this)
// ---------------------------------------------------------------------------

/**
 * `json` columns are jsonb. `bigint` accepts an integer or a string of digits, the way
 * Postgres does, and rejects anything else — a store sending a fractional timestamp for
 * `at` must find that out here, not in production.
 */
const SCHEMA = {
  sz_documents: {
    columns: {
      id: { type: 'text', notNull: true },
      doc: { type: 'json', notNull: true },
      rev: { type: 'bigint', notNull: false },
      updated_at: { type: 'bigint', notNull: false },
    },
    primaryKey: ['id'],
    serial: null,
  },
  sz_journal: {
    columns: {
      seq: { type: 'bigint', notNull: true },
      doc_id: { type: 'text', notNull: true },
      rec: { type: 'json', notNull: true },
      at: { type: 'bigint', notNull: false },
    },
    primaryKey: ['seq'],
    serial: 'seq',
  },
  sz_backups: {
    columns: {
      seq: { type: 'bigint', notNull: true },
      doc_id: { type: 'text', notNull: true },
      doc: { type: 'json', notNull: true },
      at: { type: 'bigint', notNull: false },
    },
    primaryKey: ['seq'],
    serial: 'seq',
  },
};

const TABLE_NAMES = Object.keys(SCHEMA);

/** Where Supabase mounts PostgREST. */
const REST_PREFIX = '/rest/v1/';

/** Query keys PostgREST reserves; everything else in the query string is a filter. */
const RESERVED_PARAMS = new Set(['select', 'order', 'limit', 'offset', 'on_conflict', 'columns']);

/** The operator set this stand-in speaks. Anything else is a parse error, not a guess. */
const OPERATORS = new Set(['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'like', 'ilike', 'in', 'is']);

/** A body larger than this is refused rather than accumulated. */
const MAX_BODY_BYTES = 64 * 1024 * 1024;

/** How many handled requests the log keeps, so a long run cannot grow without bound. */
const MAX_REQUEST_LOG = 10000;

// ---------------------------------------------------------------------------
// API keys — the two formats the real service runs at the same time
// ---------------------------------------------------------------------------

/**
 * A JWT: three dot-separated base64url segments whose first begins `eyJ`, because a JWT
 * header is a JSON object. The same test storage/supabaseStore.js applies, deliberately —
 * the store decides which headers to send from it, and the stand-in decides what to accept
 * from it, so a disagreement between the two would be a disagreement about the same
 * question.
 */
const JWT_RE = /^eyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

/** The browser-safe half of the current key pair. It resolves to the `anon` role. */
const PUBLISHABLE_PREFIX = 'sb_publishable_';

/**
 * Which Postgres role a key resolves to, as far as this stand-in can tell.
 *
 * `sb_publishable_` says so in its prefix; a legacy key says so in its JWT payload, which
 * is base64url and carries no secret (the signature is the secret, and nothing here looks
 * at it). Anything else — `sb_secret_`, or the opaque strings the harnesses use — is
 * treated as `service_role`, which is what the real project does with a secret key.
 *
 * This exists for ONE purpose: so a key with no privileges fails here the way it fails
 * against a project built by docs/supabase.sql, instead of being served data it could
 * never really read.
 */
function roleOfKey(key) {
  if (key.startsWith(PUBLISHABLE_PREFIX)) return 'anon';
  if (!JWT_RE.test(key)) return 'service_role';
  try {
    const claims = JSON.parse(Buffer.from(key.split('.')[1], 'base64url').toString('utf8'));
    if (claims && claims.role === 'anon') return 'anon';
  } catch {
    /* an unreadable payload says nothing; treat it as the privileged case and let the
       request proceed, because guessing "no privileges" would fail a valid key */
  }
  return 'service_role';
}

// ---------------------------------------------------------------------------
// errors
// ---------------------------------------------------------------------------

/** A PostgREST-shaped failure: a status plus the { code, details, hint, message } body. */
class RestError extends Error {
  constructor(status, code, message, hint = null, details = null) {
    super(message);
    this.status = status;
    this.code = code;
    this.hint = hint;
    this.details = details;
  }

  body() {
    return { code: this.code, details: this.details, hint: this.hint, message: this.message };
  }
}

function unknownColumn(table, column) {
  return new RestError(400, '42703', `column ${table}.${column} does not exist`);
}

function badFilter(text) {
  return new RestError(400, 'PGRST100', `"failed to parse filter (${text})" (line 1, column 1)`);
}

// ---------------------------------------------------------------------------
// jsonb
// ---------------------------------------------------------------------------

/**
 * Postgres jsonb does not store the text it was given: it parses it, drops duplicate keys
 * and reorders the remaining ones (by key length, then bytewise). Reproducing that here
 * means a store that quietly relies on key order breaks in the harness rather than in
 * somebody's data.
 */
function jsonbKeyOrder(a, b) {
  if (a.length !== b.length) return a.length - b.length;
  return a < b ? -1 : a > b ? 1 : 0;
}

function toJsonb(value) {
  if (Array.isArray(value)) return value.map(toJsonb);
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort(jsonbKeyOrder)) out[key] = toJsonb(value[key]);
    return out;
  }
  return value;
}

function cloneValue(value) {
  if (value === null || typeof value !== 'object') return value;
  return JSON.parse(JSON.stringify(value));
}

// ---------------------------------------------------------------------------
// column values
// ---------------------------------------------------------------------------

function describe(value) {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/** Coerce one value on its way INTO a column, the way Postgres would, or reject it. */
function coerceForColumn(table, column, spec, value) {
  if (value === null || value === undefined) {
    if (spec.notNull) {
      throw new RestError(
        400,
        '23502',
        `null value in column "${column}" of relation "${table}" violates not-null constraint`,
      );
    }
    return null;
  }
  if (spec.type === 'json') return toJsonb(value);
  if (spec.type === 'text') {
    if (typeof value === 'string') return value;
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
    throw new RestError(400, '22P02', `invalid input syntax for type text: "${describe(value)}"`);
  }
  // bigint
  if (typeof value === 'number') {
    if (!Number.isInteger(value)) {
      throw new RestError(400, '22P02', `invalid input syntax for type bigint: "${value}"`);
    }
    return value;
  }
  if (typeof value === 'string' && /^-?\d+$/.test(value.trim())) return Number(value.trim());
  throw new RestError(400, '22P02', `invalid input syntax for type bigint: "${describe(value)}"`);
}

/** Coerce a value arriving in a FILTER, where everything starts life as a string. */
function coerceFilterValue(table, column, spec, raw) {
  if (raw === null) return null;
  if (spec.type === 'bigint') {
    const text = String(raw).trim();
    if (!/^-?\d+$/.test(text)) {
      throw new RestError(400, '22P02', `invalid input syntax for type bigint: "${raw}"`);
    }
    return Number(text);
  }
  return String(raw);
}

function compareScalar(a, b) {
  if (typeof a === 'number' && typeof b === 'number') return a < b ? -1 : a > b ? 1 : 0;
  const left = typeof a === 'string' ? a : describe(a);
  const right = typeof b === 'string' ? b : describe(b);
  return left < right ? -1 : left > right ? 1 : 0;
}

// ---------------------------------------------------------------------------
// query parsing
// ---------------------------------------------------------------------------

/** Split `a,"b,c",d` on the commas that are not inside quotes. */
function splitQuotedList(inner) {
  const out = [];
  let current = '';
  let quoted = false;
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (quoted) {
      if (ch === '\\' && i + 1 < inner.length) {
        current += inner[++i];
        continue;
      }
      if (ch === '"') {
        quoted = false;
        continue;
      }
      current += ch;
      continue;
    }
    if (ch === '"') {
      quoted = true;
      continue;
    }
    if (ch === ',') {
      out.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  out.push(current);
  return out;
}

/** Strip one layer of PostgREST's optional double quotes from a scalar value. */
function unquoteScalar(text) {
  if (text.length >= 2 && text.startsWith('"') && text.endsWith('"')) {
    return { value: text.slice(1, -1).replace(/\\(.)/g, '$1'), quoted: true };
  }
  return { value: text, quoted: false };
}

function likeToRegExp(pattern, caseInsensitive) {
  let source = '';
  for (const ch of pattern) {
    if (ch === '*' || ch === '%') source += '.*';
    else if (ch === '_') source += '.';
    else source += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${source}$`, caseInsensitive ? 'is' : 's');
}

function buildTest(table, column, spec, op, argument, expression) {
  if (op === 'is') {
    const word = argument.toLowerCase();
    if (word === 'null') return (row) => row[column] === null || row[column] === undefined;
    if (word === 'true') return (row) => row[column] === true;
    if (word === 'false') return (row) => row[column] === false;
    throw badFilter(`${column}.${expression}`);
  }

  if (op === 'in') {
    if (!(argument.startsWith('(') && argument.endsWith(')'))) {
      throw badFilter(`${column}.${expression}`);
    }
    const inner = argument.slice(1, -1);
    if (inner.trim() === '') {
      // PostgREST rejects an empty list, and so must this: a store that builds one out of
      // an empty array has to learn to skip the request rather than send it.
      throw badFilter(`${column}.${expression}`);
    }
    const members = splitQuotedList(inner).map((part) => {
      const { value } = unquoteScalar(part.trim());
      return coerceFilterValue(table, column, spec, value);
    });
    const set = new Set(members);
    return (row) => {
      const value = row[column];
      if (value === null || value === undefined) return false;
      return set.has(value);
    };
  }

  if (op === 'like' || op === 'ilike') {
    const { value } = unquoteScalar(argument);
    const pattern = likeToRegExp(value, op === 'ilike');
    return (row) => {
      const candidate = row[column];
      if (typeof candidate !== 'string') return false;
      return pattern.test(candidate);
    };
  }

  const { value: text, quoted } = unquoteScalar(argument);
  // An unquoted `null` is SQL NULL, and every comparison with NULL is NULL — never true.
  if (!quoted && text.toLowerCase() === 'null') return () => false;
  const wanted = coerceFilterValue(table, column, spec, text);
  return (row) => {
    const value = row[column];
    if (value === null || value === undefined) return false;
    switch (op) {
      case 'eq': return value === wanted;
      case 'neq': return value !== wanted;
      case 'gt': return compareScalar(value, wanted) > 0;
      case 'gte': return compareScalar(value, wanted) >= 0;
      case 'lt': return compareScalar(value, wanted) < 0;
      case 'lte': return compareScalar(value, wanted) <= 0;
      default: return false;
    }
  };
}

/** One `<column>=<op>.<value>` (or `<column>=not.<op>.<value>`) turned into a predicate. */
function parseFilter(table, column, expression) {
  const spec = SCHEMA[table].columns[column];
  if (!spec) throw unknownColumn(table, column);

  let rest = expression;
  let negated = false;
  if (rest.startsWith('not.')) {
    negated = true;
    rest = rest.slice(4);
  }
  const dot = rest.indexOf('.');
  if (dot === -1) throw badFilter(`${column}.${expression}`);
  const op = rest.slice(0, dot);
  const argument = rest.slice(dot + 1);
  if (!OPERATORS.has(op)) throw badFilter(`${column}.${expression}`);

  const test = buildTest(table, column, spec, op, argument, expression);
  if (!negated) return { column, op, test };
  // NOT over a comparison that yielded NULL is still NULL in Postgres — still excluded.
  return {
    column,
    op: `not.${op}`,
    test: (row) => {
      const value = row[column];
      if ((value === null || value === undefined) && op !== 'is') return false;
      return !test(row);
    },
  };
}

/** `order=at.desc.nullslast,seq.asc` -> ordering terms. */
function parseOrder(table, text) {
  const terms = [];
  for (const part of String(text).split(',')) {
    const piece = part.trim();
    if (!piece) continue;
    const bits = piece.split('.');
    const column = bits.shift();
    if (!SCHEMA[table].columns[column]) throw unknownColumn(table, column);
    let descending = false;
    let nullsFirst = null;
    for (const flag of bits) {
      const word = flag.toLowerCase();
      if (word === 'asc') descending = false;
      else if (word === 'desc') descending = true;
      else if (word === 'nullsfirst') nullsFirst = true;
      else if (word === 'nullslast') nullsFirst = false;
      else throw badFilter(`order=${piece}`);
    }
    // Postgres puts NULLs last for ASC and first for DESC unless told otherwise.
    terms.push({ column, descending, nullsFirst: nullsFirst === null ? descending : nullsFirst });
  }
  return terms;
}

/** `select=id,doc` or `select=alias:doc`, but no embedded resources — there are none. */
function parseSelect(table, text) {
  const trimmed = (text || '').trim();
  if (trimmed === '' || trimmed === '*') return null;
  const parts = [];
  for (const raw of trimmed.split(',')) {
    const piece = raw.trim();
    if (!piece) continue;
    if (piece.includes('(')) {
      throw new RestError(
        400,
        'PGRST100',
        `"failed to parse select parameter (${trimmed})" (line 1, column 1)`,
        'this stand-in has no relationships to embed',
      );
    }
    const colon = piece.indexOf(':');
    const alias = colon === -1 ? null : piece.slice(0, colon).trim();
    const column = (colon === -1 ? piece : piece.slice(colon + 1)).trim().split('::')[0];
    if (!SCHEMA[table].columns[column]) throw unknownColumn(table, column);
    parts.push({ column, alias: alias || column });
  }
  return parts.length ? parts : null;
}

function parseCount(text, name) {
  if (text === null || text === undefined) return null;
  if (!/^\d+$/.test(String(text).trim())) {
    throw new RestError(400, 'PGRST100', `"failed to parse ${name} (${text})" (line 1, column 1)`);
  }
  return Number(String(text).trim());
}

// ---------------------------------------------------------------------------
// headers
// ---------------------------------------------------------------------------

function header(req, name) {
  const value = req.headers[name];
  if (Array.isArray(value)) return value[0];
  return typeof value === 'string' ? value : '';
}

/** `Prefer: return=representation, count=exact` -> { return: 'representation', ... }. */
function parsePrefer(raw) {
  const out = {};
  if (!raw) return out;
  for (const piece of String(raw).split(',')) {
    const token = piece.trim();
    if (!token) continue;
    const eq = token.indexOf('=');
    if (eq === -1) continue;
    out[token.slice(0, eq).trim().toLowerCase()] = token.slice(eq + 1).trim().toLowerCase();
  }
  return out;
}

/** PostgREST's `Range: 0-9` pagination, which pairs with the Content-Range it answers. */
function parseRange(raw) {
  if (!raw) return null;
  const match = /^(\d+)-(\d*)$/.exec(String(raw).trim());
  if (!match) return null;
  const from = Number(match[1]);
  const to = match[2] === '' ? null : Number(match[2]);
  if (to !== null && to < from) return null;
  return { offset: from, limit: to === null ? null : to - from + 1 };
}

function wantsSingleObject(req) {
  return /application\/vnd\.pgrst\.object\+json/i.test(header(req, 'accept'));
}

// ---------------------------------------------------------------------------
// response helpers
// ---------------------------------------------------------------------------

function project(row, projection) {
  if (!projection) return cloneValue(row);
  const out = {};
  for (const part of projection) out[part.alias] = cloneValue(row[part.column]);
  return out;
}

function orderRows(rows, order) {
  if (!order.length) return rows;
  const decorated = rows.map((row, index) => ({ row, index }));
  decorated.sort((left, right) => {
    for (const term of order) {
      const a = left.row[term.column];
      const b = right.row[term.column];
      const aNull = a === null || a === undefined;
      const bNull = b === null || b === undefined;
      if (aNull || bNull) {
        if (aNull && bNull) continue;
        const first = term.nullsFirst ? -1 : 1;
        return aNull ? first : -first;
      }
      const cmp = compareScalar(a, b);
      if (cmp !== 0) return term.descending ? -cmp : cmp;
    }
    return left.index - right.index; // a stable sort, so equal keys keep insertion order
  });
  return decorated.map((entry) => entry.row);
}

function rangeHeaderFor(length, offset, total) {
  const totalText = total === null || total === undefined ? '*' : String(total);
  if (length === 0) return `*/${totalText}`;
  return `${offset}-${offset + length - 1}/${totalText}`;
}

function applyPreferenceApplied(res, prefer) {
  const applied = [];
  if (prefer.return) applied.push(`return=${prefer.return}`);
  if (prefer.resolution) applied.push(`resolution=${prefer.resolution}`);
  if (prefer.count) applied.push(`count=${prefer.count}`);
  if (applied.length) res.setHeader('Preference-Applied', applied.join(', '));
}

/**
 * Damage a response body the way the wire does: the status is still 2xx and the request
 * really was carried out, but what comes back cannot be parsed.
 *
 * This is not an exotic failure. A proxy that truncates a large response, a gateway that
 * substitutes its own HTML error page while keeping the status, a connection that ends a
 * few bytes early — every one of them produces a successful-looking response whose body
 * is not the JSON the caller is about to treat as fact. For a store that reads "no rows"
 * as "the table is empty" and then DELETES against it, that is a data-loss path, so the
 * harness has to be able to produce it on demand.
 */
function damageBody(text, mode) {
  const body = typeof text === 'string' ? text : '';
  if (mode === 'empty') return '';
  if (mode === 'gateway') return '<html><head><title>502 Bad Gateway</title></head><body>502</body></html>';
  // 'truncate', the default: half the bytes, which cuts a JSON array or object open.
  if (body.length >= 2) return body.slice(0, Math.floor(body.length / 2));
  return '<html><body>truncated</body></html>';
}

/**
 * Wrap one response so whatever it is about to send is damaged on the way out.
 *
 * Content-Length is recomputed, deliberately: a short body under the original length
 * would hang the client until its timeout, which is a DIFFERENT failure (and one the
 * store already handles). What is being reproduced here is a response that arrives whole,
 * looks successful, and does not parse.
 */
function corruptResponse(res, mode) {
  const realWriteHead = res.writeHead.bind(res);
  const realEnd = res.end.bind(res);
  let status = 200;
  let headers = null;
  res.writeHead = (code, value) => {
    status = code;
    headers = value && typeof value === 'object' ? { ...value } : null;
    return res;
  };
  res.end = (chunk) => {
    const original = chunk === undefined || chunk === null ? '' : Buffer.from(chunk).toString('utf8');
    const buf = Buffer.from(damageBody(original, mode), 'utf8');
    const out = headers || {};
    for (const key of Object.keys(out)) {
      if (key.toLowerCase() === 'content-length') delete out[key];
    }
    out['Content-Length'] = String(buf.length);
    realWriteHead(status, out);
    return realEnd(buf);
  };
}

function sendJson(res, status, payload, headOnly = false) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': String(body.length),
  });
  if (headOnly) res.end();
  else res.end(body);
}

/** `Accept: application/vnd.pgrst.object+json` wants exactly one row, or it is a 406. */
function sendSingular(res, rows, headOnly, status = 200) {
  if (rows.length !== 1) {
    const error = new RestError(
      406,
      'PGRST116',
      'JSON object requested, multiple (or no) rows returned',
      null,
      `Results contain ${rows.length} rows`,
    );
    sendJson(res, 406, error.body(), headOnly);
    return;
  }
  const body = Buffer.from(JSON.stringify(rows[0]), 'utf8');
  res.writeHead(status, {
    'Content-Type': 'application/vnd.pgrst.object+json; charset=utf-8',
    'Content-Length': String(body.length),
  });
  if (headOnly) res.end();
  else res.end(body);
}

function methodNotAllowed(method) {
  return new RestError(405, 'FAKE405', `method ${method} is not supported`);
}

function openApiRoot() {
  const paths = {};
  for (const name of TABLE_NAMES) paths[`/${name}`] = {};
  return { swagger: '2.0', info: { title: 'fakesupabase', version: '1' }, paths };
}

// ---------------------------------------------------------------------------
// the server
// ---------------------------------------------------------------------------

/**
 * Start the stand-in.
 *
 * @param {number} [port] 0 (the default) picks a free one; the handle reports which.
 * @param {{key?: string, host?: string, schema?: string}} [options]
 *   `key` pins the key that must arrive on the `apikey` header. Left out, any non-empty
 *   one is accepted. `Authorization` is not required either way: whether it is sent
 *   depends on the key's FORMAT, and requireAuth is where that is modelled.
 * @returns {Promise<object>} a handle; it resolves once the port is actually listening.
 */
export function start(port = 0, options = {}) {
  const host = options.host || '127.0.0.1';
  const schema = options.schema || 'public';
  const expectedKey = typeof options.key === 'string' && options.key !== ''
    ? options.key
    : (process.env.FAKE_SUPABASE_KEY || '');

  /** @type {Map<string, object[]>} */
  const tables = new Map();
  /** @type {Map<string, number>} the bigserial counters */
  const sequences = new Map();
  for (const name of TABLE_NAMES) {
    tables.set(name, []);
    sequences.set(name, 0);
  }

  const requests = [];
  const faults = { statuses: [], offline: false, corrupt: [] };
  const sockets = new Set();

  /**
   * The next queued body corruption that matches this request, if any. A fault may name
   * a table and a method, so a harness can spoil exactly the read it is testing and leave
   * every other request the server makes alone.
   */
  function takeCorruption(url, method) {
    if (!faults.corrupt.length) return null;
    const table = url.pathname.startsWith(REST_PREFIX)
      ? decodeURIComponent(url.pathname.slice(REST_PREFIX.length))
      : null;
    const where = decodeURIComponent(`${url.pathname}${url.search}`);
    for (let i = 0; i < faults.corrupt.length; i++) {
      const fault = faults.corrupt[i];
      if (fault.table && fault.table !== table) continue;
      if (fault.method && fault.method !== method) continue;
      if (fault.contains && !where.includes(fault.contains)) continue;
      fault.count--;
      if (fault.count <= 0) faults.corrupt.splice(i, 1);
      return fault;
    }
    return null;
  }

  function nextSeq(table) {
    const value = sequences.get(table) + 1;
    sequences.set(table, value);
    return value;
  }

  function noteSeq(table, value) {
    // Postgres would leave the sequence alone and let a later insert collide; advancing it
    // instead only ever avoids a collision the caller did not ask for.
    if (typeof value === 'number' && value > sequences.get(table)) sequences.set(table, value);
  }

  function collectFilters(table, params) {
    const filters = [];
    for (const [key, value] of params.entries()) {
      if (RESERVED_PARAMS.has(key)) continue;
      if (key === 'and' || key === 'or' || key === 'not.and' || key === 'not.or') {
        throw new RestError(
          400,
          'PGRST100',
          `"failed to parse filter (${key}=${value})" (line 1, column 1)`,
          'this stand-in has no logic trees; storage/supabaseStore.js sends none',
        );
      }
      filters.push(parseFilter(table, key, value));
    }
    return filters;
  }

  function findConflict(table, columns, candidate) {
    if (!columns.length) return null;
    for (const row of tables.get(table)) {
      let same = true;
      for (const column of columns) {
        if (row[column] !== candidate[column]) {
          same = false;
          break;
        }
      }
      if (same) return row;
    }
    return null;
  }

  // -------------------------------------------------------------- operations

  function selectRows(table, params, prefer, rangeHeader) {
    const filters = collectFilters(table, params);
    let matched = tables.get(table).filter((row) => filters.every((f) => f.test(row)));
    const total = matched.length;

    const order = params.has('order') ? parseOrder(table, params.get('order')) : [];
    matched = orderRows(matched, order);

    const range = parseRange(rangeHeader);
    let offset = parseCount(params.get('offset'), 'offset');
    let limit = parseCount(params.get('limit'), 'limit');
    if (offset === null && range) offset = range.offset;
    if (limit === null && range) limit = range.limit;
    if (offset) matched = matched.slice(offset);
    if (limit !== null && limit !== undefined) matched = matched.slice(0, limit);

    const projection = parseSelect(table, params.get('select'));
    return {
      rows: matched.map((row) => project(row, projection)),
      total,
      offset: offset || 0,
      counted: prefer.count === 'exact',
      filters,
    };
  }

  function insertRows(table, payload, params, prefer) {
    const definition = SCHEMA[table];
    const resolution = prefer.resolution || '';
    const merge = resolution === 'merge-duplicates';
    const ignore = resolution === 'ignore-duplicates';
    const conflictColumns = params.has('on_conflict')
      ? params.get('on_conflict').split(',').map((c) => c.trim()).filter(Boolean)
      : definition.primaryKey;
    for (const column of conflictColumns) {
      if (!definition.columns[column]) throw unknownColumn(table, column);
    }

    const affected = [];
    for (const item of payload) {
      const incoming = {};
      for (const [key, value] of Object.entries(item)) {
        const spec = definition.columns[key];
        if (!spec) {
          throw new RestError(
            400,
            'PGRST204',
            `Could not find the '${key}' column of '${table}' in the schema cache`,
          );
        }
        incoming[key] = coerceForColumn(table, key, spec, value);
      }

      const existing = findConflict(table, conflictColumns, incoming);
      if (existing) {
        if (ignore) continue;
        if (!merge) {
          throw new RestError(
            409,
            '23505',
            `duplicate key value violates unique constraint "${table}_pkey"`,
            null,
            `Key (${conflictColumns.join(', ')})=(${conflictColumns
              .map((c) => describe(incoming[c]))
              .join(', ')}) already exists.`,
          );
        }
        // ON CONFLICT DO UPDATE sets the columns the statement carried, and only those.
        for (const [key, value] of Object.entries(incoming)) existing[key] = value;
        affected.push(existing);
        continue;
      }

      const row = {};
      for (const [key, spec] of Object.entries(definition.columns)) {
        if (Object.prototype.hasOwnProperty.call(incoming, key)) {
          row[key] = incoming[key];
          if (key === definition.serial) noteSeq(table, row[key]);
          continue;
        }
        if (key === definition.serial) {
          row[key] = nextSeq(table);
          continue;
        }
        if (spec.notNull) {
          throw new RestError(
            400,
            '23502',
            `null value in column "${key}" of relation "${table}" violates not-null constraint`,
          );
        }
        row[key] = null;
      }
      if (findConflict(table, definition.primaryKey, row)) {
        throw new RestError(
          409,
          '23505',
          `duplicate key value violates unique constraint "${table}_pkey"`,
        );
      }
      tables.get(table).push(row);
      affected.push(row);
    }

    const projection = parseSelect(table, params.get('select'));
    return affected.map((row) => project(row, projection));
  }

  function updateRows(table, patch, params) {
    const definition = SCHEMA[table];
    const changes = {};
    for (const [key, value] of Object.entries(patch)) {
      const spec = definition.columns[key];
      if (!spec) {
        throw new RestError(
          400,
          'PGRST204',
          `Could not find the '${key}' column of '${table}' in the schema cache`,
        );
      }
      changes[key] = coerceForColumn(table, key, spec, value);
    }
    const filters = collectFilters(table, params);
    const matched = tables.get(table).filter((row) => filters.every((f) => f.test(row)));
    for (const row of matched) Object.assign(row, changes);
    const projection = parseSelect(table, params.get('select'));
    return { rows: matched.map((row) => project(row, projection)), filters };
  }

  function deleteRows(table, params) {
    const filters = collectFilters(table, params);
    const removed = [];
    const kept = [];
    for (const row of tables.get(table)) {
      if (filters.every((f) => f.test(row))) removed.push(row);
      else kept.push(row);
    }
    tables.set(table, kept);
    const projection = parseSelect(table, params.get('select'));
    return { rows: removed.map((row) => project(row, projection)), filters };
  }

  // ------------------------------------------------------------------ wiring

  /**
   * Authentication, modelled on the service that exists NOW rather than the one this file
   * was first written against.
   *
   * Supabase runs two key systems at the same time. A legacy key is a JWT and is what
   * PostgREST verifies on `Authorization: Bearer`; a current key — `sb_secret_...`,
   * `sb_publishable_...` — is a short opaque string that is NOT a JWT, travels on `apikey`
   * alone, and is resolved to a Postgres role before PostgREST is reached. So:
   *
   *   `apikey`          ALWAYS required. It is what names the project and the role.
   *   `Authorization`   OPTIONAL. Present, it must be a bearer token that can be VERIFIED
   *                     as a JWT — a non-JWT there fails, because verifying it is exactly
   *                     what the other end tries and cannot do.
   *
   * Being wrong in either direction has a cost and they are not the same cost. STRICTER
   * than production — the old rule, which demanded both headers — fails a valid
   * configuration in the harness and would have sent someone hunting for a bug in a store
   * that was correct. LOOSER than production lets a broken configuration pass here and
   * fail on the operator, in front of their data, which is worse. Where this file cannot
   * know, it chooses the behaviour that keeps a real misconfiguration failing.
   *
   * Three things below are MODELS of the real service rather than transcripts of it, and
   * they are named so nobody later mistakes them for observed fact:
   *
   *   - the exact PostgREST text for a bearer token that will not decode. The STATUS (401)
   *     and the code (PGRST301) are what PostgREST answers for a token it cannot verify;
   *     the sentence imitates its JWSError wording.
   *   - requiring a bearer token to EQUAL the apikey. The real service would accept a
   *     different valid JWT and act as whatever role it names — that is how end-user auth
   *     works — but this stand-in holds no signing secret and so cannot verify one at all.
   *     Equality is the only check available to it, and it cannot fail a valid
   *     configuration of storage/supabaseStore.js, which sends one key or the same key
   *     twice and never two different ones.
   *   - the privilege refusal at the end. A project built by docs/supabase.sql has RLS on
   *     with no policies and `revoke all ... from anon`, so a key that resolves to `anon`
   *     can read and write nothing. Serving it anyway would make this stand-in friendlier
   *     than production in the one place that matters most: a key with no privileges must
   *     not look like a working one here.
   */
  function requireAuth(req, table = null) {
    const apikey = header(req, 'apikey');
    if (!apikey) {
      throw new RestError(
        401,
        '401',
        'No API key found in request',
        'No `apikey` request header or url param was found.',
      );
    }
    if (expectedKey && apikey !== expectedKey) {
      throw new RestError(401, '401', 'Invalid API key', 'Double check your Supabase API key.');
    }

    // Optional, and only because the real gateway makes it optional. A store sending no
    // Authorization for an sb_secret_ key is CORRECT, and must not be failed here.
    const authorization = header(req, 'authorization');
    if (authorization) {
      const match = /^Bearer\s+(.+)$/i.exec(authorization.trim());
      if (!match) {
        throw new RestError(
          401,
          '401',
          'Invalid authentication credentials',
          'The `Authorization` header must be `Bearer <token>`.',
        );
      }
      const bearer = match[1].trim();
      if (!JWT_RE.test(bearer)) {
        // The whole point of this branch. The new keys are not JWTs, so a store that put
        // one on `Authorization: Bearer` would be handing PostgREST something it must try
        // to verify and cannot — and it fails the request rather than ignoring the header.
        // A harness that never saw this would bless a configuration the operator cannot
        // use.
        const parts = bearer.split('.').length;
        throw new RestError(
          401,
          'PGRST301',
          `JWSError CompactDecodeError Invalid number of parts: Expected 3 parts; got ${parts}`,
          'Supabase\'s newer API keys are not JWTs. Send them on the `apikey` header only.',
        );
      }
      if (bearer !== apikey) {
        throw new RestError(
          401,
          'PGRST301',
          'JWSError JWSInvalidSignature',
          'This stand-in cannot verify a signature; a bearer token must be the same key as `apikey`.',
        );
      }
    }

    // The key is genuine; the question left is whether it may touch anything.
    if (roleOfKey(apikey) === 'anon') {
      throw new RestError(
        403,
        '42501',
        table
          ? `permission denied for table ${table}`
          : `permission denied for schema ${schema}`,
        'docs/supabase.sql revokes everything from `anon` and enables RLS with no policies.',
      );
    }
  }

  /** `Accept-Profile` / `Content-Profile` select the schema (SUPABASE_SCHEMA). */
  function requireProfile(req, method) {
    const raw = method === 'GET' || method === 'HEAD'
      ? header(req, 'accept-profile')
      : header(req, 'content-profile');
    if (!raw) return;
    if (raw.trim() !== schema) {
      throw new RestError(406, 'PGRST106', `The schema must be one of the following: ${schema}`);
    }
  }

  function readBody(req) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let size = 0;
      req.on('data', (chunk) => {
        size += chunk.length;
        if (size > MAX_BODY_BYTES) {
          reject(new RestError(413, 'FAKE413', 'request body is too large'));
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => resolve(Buffer.concat(chunks)));
      req.on('error', (err) => reject(err));
    });
  }

  async function readJsonBody(req, allowArray) {
    const type = header(req, 'content-type') || 'application/json';
    if (!/json/i.test(type)) {
      throw new RestError(415, 'PGRST107', `None of these Content-Types are available: ${type}`);
    }
    const buffer = await readBody(req);
    if (!buffer.length) throw new RestError(400, 'PGRST102', 'Empty or invalid json');
    let parsed;
    try {
      parsed = JSON.parse(buffer.toString('utf8'));
    } catch {
      throw new RestError(400, 'PGRST102', 'Empty or invalid json');
    }
    if (Array.isArray(parsed)) {
      if (!allowArray) throw new RestError(400, 'PGRST102', 'Empty or invalid json');
      for (const item of parsed) {
        if (!item || typeof item !== 'object' || Array.isArray(item)) {
          throw new RestError(400, 'PGRST102', 'Empty or invalid json');
        }
      }
      // PostgREST builds ONE insert for the whole array, so every object must name the
      // same columns. Accepting a ragged array here would hide a real 400.
      if (parsed.length > 1) {
        const first = Object.keys(parsed[0]).sort().join(',');
        for (const item of parsed.slice(1)) {
          if (Object.keys(item).sort().join(',') !== first) {
            throw new RestError(400, 'PGRST102', 'All object keys must match');
          }
        }
      }
      return { items: parsed, single: false };
    }
    if (!parsed || typeof parsed !== 'object') {
      throw new RestError(400, 'PGRST102', 'Empty or invalid json');
    }
    return { items: [parsed], single: true };
  }

  function logRequest(req, status, rows, table = null, filters = null) {
    if (requests.length >= MAX_REQUEST_LOG) requests.shift();
    let query = '';
    try {
      query = new URL(req.url, 'http://x').search.replace(/^\?/, '');
    } catch {
      query = '';
    }
    requests.push({
      at: Date.now(),
      method: (req.method || 'GET').toUpperCase(),
      table,
      query,
      status,
      rows,
      // Whether the statement named any row at all. SPEC 29.3 forbids a blanket delete,
      // and a harness can only assert that if the stand-in remembers.
      filtered: filters ? filters.length > 0 : null,
    });
  }

  function locationFor(table, row) {
    const parts = SCHEMA[table].primaryKey.map(
      (column) => `${column}=eq.${encodeURIComponent(String(row[column]))}`,
    );
    return `/${table}?${parts.join('&')}`;
  }

  async function handle(req, res) {
    // A fault is injected before anything is parsed, because the failures it stands for —
    // a gateway 502, a dropped connection — happen before the request is ever read.
    if (faults.offline) {
      req.destroy();
      res.destroy();
      return;
    }
    if (faults.statuses.length) {
      const status = faults.statuses.shift();
      logRequest(req, status, 0);
      sendJson(res, status, {
        code: 'FAKE_FAULT',
        details: null,
        hint: null,
        message: 'injected failure',
      });
      return;
    }

    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const method = (req.method || 'GET').toUpperCase();

    // A body fault is applied AFTER the request is carried out, not instead of it: the
    // database really did the work and only the answer was lost on the way back. That
    // asymmetry is the whole point — a store that treats the unreadable answer as an
    // empty result is then wrong about rows that exist.
    const corruption = takeCorruption(url, method);
    if (corruption) corruptResponse(res, corruption.mode);

    try {
      if (url.pathname === REST_PREFIX || url.pathname === REST_PREFIX.slice(0, -1)) {
        if (method !== 'GET' && method !== 'HEAD') throw methodNotAllowed(method);
        requireAuth(req);
        logRequest(req, 200, 0);
        sendJson(res, 200, openApiRoot(), method === 'HEAD');
        return;
      }
      if (!url.pathname.startsWith(REST_PREFIX)) {
        throw new RestError(
          404,
          'FAKE404',
          `no route for ${url.pathname}`,
          `PostgREST is served under ${REST_PREFIX}<table>`,
        );
      }

      const table = decodeURIComponent(url.pathname.slice(REST_PREFIX.length));
      requireAuth(req, table);
      requireProfile(req, method);
      if (!Object.prototype.hasOwnProperty.call(SCHEMA, table)) {
        throw new RestError(
          404,
          'PGRST205',
          `Could not find the table '${schema}.${table}' in the schema cache`,
          `Tables in this stand-in: ${TABLE_NAMES.join(', ')}`,
        );
      }

      const params = url.searchParams;
      const prefer = parsePrefer(req.headers.prefer);
      const singular = wantsSingleObject(req);

      if (method === 'GET' || method === 'HEAD') {
        const result = selectRows(table, params, prefer, req.headers.range);
        logRequest(req, 200, result.rows.length, table, result.filters);
        res.setHeader(
          'Content-Range',
          rangeHeaderFor(result.rows.length, result.offset, result.counted ? result.total : null),
        );
        if (singular) sendSingular(res, result.rows, method === 'HEAD');
        else sendJson(res, 200, result.rows, method === 'HEAD');
        return;
      }

      if (method === 'POST') {
        const payload = await readJsonBody(req, true);
        const rows = insertRows(table, payload.items, params, prefer);
        const wantBody = prefer.return === 'representation';
        applyPreferenceApplied(res, prefer);
        logRequest(req, 201, rows.length, table);
        if (!wantBody) {
          if (payload.single && rows.length === 1) {
            res.setHeader('Location', locationFor(table, rows[0]));
          }
          res.writeHead(201, { 'Content-Range': '*/*' });
          res.end();
          return;
        }
        res.setHeader('Content-Range', rangeHeaderFor(rows.length, 0, null));
        if (singular) sendSingular(res, rows, false, 201);
        else sendJson(res, 201, rows);
        return;
      }

      if (method === 'PATCH') {
        const payload = await readJsonBody(req, false);
        const result = updateRows(table, payload.items[0] || {}, params);
        const wantBody = prefer.return === 'representation';
        applyPreferenceApplied(res, prefer);
        logRequest(req, wantBody ? 200 : 204, result.rows.length, table, result.filters);
        if (!wantBody) {
          res.writeHead(204, { 'Content-Range': '*/*' });
          res.end();
          return;
        }
        res.setHeader('Content-Range', rangeHeaderFor(result.rows.length, 0, null));
        if (singular) sendSingular(res, result.rows, false, 200);
        else sendJson(res, 200, result.rows);
        return;
      }

      if (method === 'DELETE') {
        const result = deleteRows(table, params);
        const wantBody = prefer.return === 'representation';
        applyPreferenceApplied(res, prefer);
        logRequest(req, wantBody ? 200 : 204, result.rows.length, table, result.filters);
        if (!wantBody) {
          res.writeHead(204, { 'Content-Range': '*/*' });
          res.end();
          return;
        }
        res.setHeader('Content-Range', rangeHeaderFor(result.rows.length, 0, null));
        sendJson(res, 200, result.rows);
        return;
      }

      throw methodNotAllowed(method);
    } catch (err) {
      const failure = err instanceof RestError
        ? err
        : new RestError(400, 'PGRST100', err && err.message ? err.message : 'bad request');
      logRequest(req, failure.status, 0);
      sendJson(res, failure.status, failure.body(), method === 'HEAD');
    }
  }

  const server = createServer((req, res) => {
    handle(req, res).catch((err) => {
      // Anything that escapes the handler is this file's bug, not the caller's; say so
      // with a 500 rather than leaving the socket open and the harness waiting on it.
      const message = err && err.message ? err.message : String(err);
      try {
        sendJson(res, 500, { code: 'FAKE500', details: null, hint: null, message });
      } catch {
        res.destroy();
      }
    });
  });

  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });

  return new Promise((resolve, reject) => {
    const onError = (err) => reject(err);
    server.once('error', onError);
    server.listen(port, host, () => {
      server.removeListener('error', onError);
      const address = server.address();
      const actualPort = address && typeof address === 'object' ? address.port : port;
      resolve({
        /** Point SUPABASE_URL at this. */
        url: `http://${host}:${actualPort}`,
        port: actualPort,
        host,
        schema,
        /** Every request handled, oldest first; a harness may read or splice it freely. */
        requests,

        /** A deep copy of one table's rows, so an assertion cannot mutate the store. */
        rows(table) {
          if (!tables.has(table)) throw new Error(`unknown table: ${table}`);
          return tables.get(table).map((row) => cloneValue(row));
        },

        count(table) {
          if (!tables.has(table)) throw new Error(`unknown table: ${table}`);
          return tables.get(table).length;
        },

        /** Every table at once, for a whole-database assertion. */
        snapshot() {
          const out = {};
          for (const name of TABLE_NAMES) {
            out[name] = tables.get(name).map((row) => cloneValue(row));
          }
          return out;
        },

        /** Empty every table and forget every fault, between harness cases. */
        reset() {
          for (const name of TABLE_NAMES) {
            tables.set(name, []);
            sequences.set(name, 0);
          }
          requests.length = 0;
          faults.statuses.length = 0;
          faults.offline = false;
          faults.corrupt.length = 0;
        },

        /**
         * Make the next `count` requests answer with `status` and change nothing.
         * A transient 502 from a hosted database is ordinary (SPEC 29.3), so this is how a
         * harness proves the retry happens — and that a request which was never confirmed
         * is never acknowledged.
         */
        failNext(count = 1, status = 503) {
          for (let i = 0; i < count; i++) faults.statuses.push(status);
        },

        /**
         * Drop every connection without answering, which is what a network failure looks
         * like from the store's side: no status at all, just a rejected fetch.
         */
        setOffline(on = true) {
          faults.offline = Boolean(on);
          if (faults.offline) for (const socket of sockets) socket.destroy();
        },

        /**
         * Make the next matching requests answer 2xx with a body that cannot be parsed,
         * having done exactly what they were asked to do.
         *
         * `{ table, method, contains }` narrow it to one kind of request — `contains` is
         * matched against the decoded path and query, which is how a fault is aimed at a
         * single document. `mode` picks the shape of the damage: 'truncate' (half the bytes — a response cut short), 'gateway' (a
         * proxy's HTML page under a 2xx) or 'empty' (the payload lost entirely).
         *
         * This exists because SPEC 29.3's promise — a record is durable when appendJournal
         * resolves true, and the journal is truncated only for rows a snapshot really
         * included — is only worth anything if an answer the store could not read is
         * treated as a failure rather than as "no rows".
         */
        corruptNext({ count = 1, table = null, method = null, contains = null, mode = 'truncate' } = {}) {
          faults.corrupt.push({
            count: Math.max(1, count),
            table,
            method: method ? String(method).toUpperCase() : null,
            // A substring of the decoded path+query, so a fault can be aimed at ONE
            // document. Without it a harness would spoil whichever request happened to
            // come first, and a case about one document's journal would silently be
            // testing another's.
            contains,
            mode,
          });
        },

        clearFaults() {
          faults.statuses.length = 0;
          faults.offline = false;
          faults.corrupt.length = 0;
        },

        /**
         * Stop listening and drop every keep-alive connection, so the process can exit.
         * `server.close` alone would wait on sockets that fetch holds open for minutes.
         */
        stop() {
          return new Promise((done) => {
            server.close(() => done());
            for (const socket of sockets) socket.destroy();
            sockets.clear();
          });
        },
      });
    });
  });
}

// ---------------------------------------------------------------------------
// standalone
// ---------------------------------------------------------------------------

/** True when this file was run directly rather than imported by a harness. */
function runDirectly() {
  const entry = process.argv[1] || '';
  return entry.replace(/\\/g, '/').endsWith('/fakesupabase.mjs');
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log([
      '가짜 Supabase (SPEC 29.5) — 메모리 안에서만 도는 PostgREST 흉내입니다.',
      '',
      '  node tools/fakesupabase.mjs [--port <번호>] [--host <주소>]',
      '',
      '켜 둔 채로, 다른 터미널에서 SUPABASE_URL 을 아래에 찍히는 주소로,',
      'SUPABASE_SERVICE_KEY 를 아무 값으로나 정하고 서버나 도구를 실행하면 됩니다.',
      '끄면 내용은 모두 사라집니다. 진짜 데이터를 여기에 두지 마세요.',
    ].join('\n'));
    return;
  }
  let port = 54321;
  let host = '127.0.0.1';
  for (let i = 0; i < argv.length; i++) {
    if ((argv[i] === '--port' || argv[i] === '-p') && argv[i + 1]) port = Number(argv[++i]);
    else if (argv[i] === '--host' && argv[i + 1]) host = argv[++i];
  }
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    console.error('[가짜 Supabase] 포트 번호가 올바르지 않습니다.');
    process.exitCode = 2;
    return;
  }

  const fake = await start(port, { host });
  console.log(`[가짜 Supabase] 준비됨 — SUPABASE_URL=${fake.url}`);
  console.log('[가짜 Supabase] SUPABASE_SERVICE_KEY 는 비어 있지 않은 아무 값이나 됩니다. 여기에 진짜 키를 쓰지 마세요.');
  console.log('[가짜 Supabase] 저장 위치는 메모리뿐이라 이 프로세스를 끄면 전부 사라집니다. (Ctrl+C 로 종료)');

  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    await fake.stop();
    console.log('[가짜 Supabase] 종료했습니다.');
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

if (runDirectly()) {
  main().catch((err) => {
    console.error(`[가짜 Supabase] 시작하지 못했습니다: ${err && err.message ? err.message : err}`);
    process.exitCode = 1;
  });
}
