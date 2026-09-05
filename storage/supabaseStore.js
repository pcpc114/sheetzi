// storage/supabaseStore.js — the Supabase document store (SPEC 29.3).
//
// The same documents the file store keeps in data/, kept in Postgres instead, so the disk
// under one machine stops being the only copy. Reached over PostgREST with plain `fetch`:
// there is no client library and there must not be one.
//
// Three tables, created once by docs/supabase.sql:
//
//   sz_documents (id, doc, rev, updated_at)   the compacted snapshot, one row per document
//   sz_journal   (seq, doc_id, rec, at)       the append-only journal of SPEC 27.1
//   sz_backups   (seq, doc_id, doc, at)       the snapshots SPEC 27.2 keeps
//
// The durability contract is unchanged, and it is the reason for most of what follows.
// `appendJournal` resolves true ONLY on a response it actually received carrying a 2xx
// status and a body it could read. A committed row IS durable — there is no fsync
// equivalent and no window where the bytes are "with the operating system" but not yet
// safe — so this backend is strictly safer than the file one. What it adds instead is a
// network, and a network fails: a timeout, a dropped connection, a 502, or a 2xx whose
// body arrived damaged all resolve FALSE, the operation is not acknowledged, and the
// client keeps it in its outbox (SPEC 27.4).
//
// The rule that follows from that, and the one this file is built around: a response this
// process could not READ is a failed request, never an empty result. "No rows" is a fact
// about the database that compaction is allowed to delete against; an unreadable answer
// is not, and the two must never arrive at a caller looking the same.
//
// Rejecting is only half of SPEC 27.6, and it was the half this file had. The other half is
// the QUARANTINE: one unreadable answer for a document takes that document out of service
// for the rest of the process — saveSnapshot, truncateJournal and deleteDoc reject for it,
// appendJournal resolves false, and the state is never lifted, not even by a later
// successful read. It lives here rather than only in server.js because SPEC 29.1 makes it a
// property of the INTERFACE: a second caller that trusted the documented contract must get
// the same refusals whichever backend it is pointed at, without having to reimplement the
// guard. There was such a caller — the migration tool, which inherited exactly this loss
// while the guard lived only in server.js — and it has since been deleted (SPEC 29.4).
// Its absence is not an argument for moving the guard back up: the reason it could lose
// data is that a store trusted its caller, and the next caller is not here to be asked.
//
// WHERE that refusal is enforced is the shape of this file, and it is not at the call
// sites. Every statement leaves this process through the single `fetch` inside `fetchOnce`,
// which asks whether the document is readable as its last act before sending and again as
// soon as the answer is back; `request` will not even BUILD a POST, PATCH, PUT or DELETE
// without being told which document it changes, so there is no anonymous way to write and
// therefore no way to add a write that misses the guard. The second ask is the honest half:
// a statement already on the wire when the quarantine landed may have committed, and
// nothing can recall it — but it is answered as a failure, because a duplicate the client
// resends costs nothing (replay is idempotent, SPEC 27.4) and a row claimed under doubt
// costs somebody's typing.
//
// The alternative was tried three times and failed three times. A check at the top of
// `saveSnapshot`'s task passed, and the upsert, the backup INSERT and the prune DELETE that
// followed it all went out under a quarantine — verified through a proxy holding the upsert
// on the wire. `tools/check-writes.mjs` runs in `npm run verify` and fails the build if
// `fetch` appears anywhere but inside the gate, so this cannot decay back into a rule
// somebody has to remember.
//
// In database terms the three outcomes read:
//
//   ABSENT   a 2xx with no matching row. A fact about the database; create it, carry on.
//   CORRUPT  a row that arrived IN FULL whose jsonb is not a usable document or record.
//            Skipped and counted, exactly as the file store skips a line that will not
//            parse: one bad row must never cost the whole document.
//   UNREAD   anything that stops this process from seeing what the rows hold — a timeout,
//            a dropped connection, a 4xx, a 5xx that survived its retries, a 2xx whose body
//            will not parse, a paging walk that could not prove it reached the end. The
//            rows ARE there and we failed to read them.
//
// The service key opens the whole database. It travels in a request header and nowhere
// else: it is never logged, never placed in an error message, never returned to a caller
// and never sent to the browser. Everything printed from here goes through redact().
//
// There are now TWO key formats and both are live, so this file speaks both and picks
// between them from the key itself rather than from a setting an operator has to
// understand. A legacy key is a JWT and goes on `apikey` AND `Authorization: Bearer`,
// which is what PostgREST verifies. A current key — `sb_secret_...` — is a short opaque
// string that is not a JWT, so it goes on `apikey` ALONE: that header is what resolves it
// to the `service_role` Postgres role with BYPASSRLS, and a bearer header carrying it
// would only ask the other end to verify something that cannot be verified. The choice is
// made once in config() (see classifyKey) and read by buildHeaders. init() prints which
// format it found — the format, never the key — and refuses to start on a key that has no
// privileges at all, because a server that boots and cannot save is worse than one that
// does not boot.
//
// As in the file store, this module decides WHAT to do, never WHEN: the save debounce,
// the compaction order (snapshot, then truncate) and the flush before a clean exit are
// policy and stay in server.js.

import { sanitizeDoc } from '../shared/model.js';

/** Which backend this is, for the boot log (SPEC 29.1). */
export const name = 'supabase';

const T_DOCS = 'sz_documents';
const T_JOURNAL = 'sz_journal';
const T_BACKUPS = 'sz_backups';

// The columns each table must have. init() selects exactly these, so a table that exists
// with the wrong shape is caught at boot rather than at the first save.
const TABLE_COLUMNS = {
  [T_DOCS]: 'id,doc,rev,updated_at',
  [T_JOURNAL]: 'seq,doc_id,rec,at',
  [T_BACKUPS]: 'seq,doc_id,doc,at',
};

// The file the operator runs once, named in every failure that means "the database is not
// set up". Starting up half-working against a database with no tables is the worst
// outcome, so this string appears in the loud failure rather than in a log nobody reads.
const SQL_FILE = 'docs/supabase.sql';

// How many previous snapshots are kept per document (SPEC 27.2), matching the file store's
// <id>.bak.1 .. <id>.bak.5.
const BACKUP_COUNT = 5;

// A request that hangs must not stall the server for ever: a dead network has to become a
// failed append (and therefore a withheld ack) in bounded time, not an eternal await.
const REQUEST_TIMEOUT_MS = 8000;

// Two retries with a short backoff. A transient 502 from a hosted database is ordinary; a
// 4xx is not retried, because it will not get better.
const RETRY_DELAYS_MS = [200, 600];

// Rows per page when a whole table has to be walked. Paging uses a key cursor
// (`seq=gt.<last>`, `id=gt.<last>`) rather than offset, so a row inserted mid-walk can
// never shift a page boundary and hide a row behind it.
const PAGE_SIZE = 500;

// A hard stop for every paging loop, so a server that ignored the cursor filter cannot
// spin for ever. Far above any realistic document count.
const MAX_PAGES = 5000;

// Ids arrive from URLs and from database rows, so the pattern is re-checked here at the
// last possible moment rather than trusted.
const DOC_ID_RE = /^[a-z0-9]{6,24}$/;

// The code every UNREAD failure carries (SPEC 29.1). A string, compared the way `ENOENT`
// is compared, so no caller needs an import to recognise one. It is duplicated here rather
// than imported from the file store, because this backend must satisfy the same contract
// without importing the other one to do it.
const UNREAD_CODE = 'ESTOREUNREAD';

// ---------------------------------------------------------------------------
// configuration
// ---------------------------------------------------------------------------

function envString(key) {
  const value = process.env[key];
  return typeof value === 'string' ? value.trim() : '';
}

// A JWT is three dot-separated base64url segments, and the first one always begins `eyJ`
// because a JWT header is a JSON object and `{"` base64url-encodes to exactly that. Both
// halves are tested, because the question this file has to answer is not "does this look
// like a Supabase key" but "is this a JWT" — that is what decides whether an
// `Authorization: Bearer` header can be verified at the other end.
const JWT_RE = /^eyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

// The two prefixes Supabase's current key system uses. They are recognised only to NAME
// what was configured — the header decision above is made on shape alone, so a third form
// Supabase adds later is handled correctly the day it appears rather than the day someone
// adds a prefix here.
const PUBLISHABLE_PREFIX = 'sb_publishable_';
const SECRET_PREFIX = 'sb_secret_';

/**
 * The `role` claim of a legacy Supabase key, or null.
 *
 * This decodes the JWT's PAYLOAD, which is the middle segment: base64url, not encrypted,
 * and readable by anyone holding the token — the signature is the part that makes a JWT a
 * secret, and it is neither decoded nor inspected here. Nothing decoded is ever printed:
 * the answer is narrowed to the two role names Supabase actually mints, so the only values
 * that can escape this function are two string literals written above. An unrecognised or
 * unreadable payload answers null, and null is never a refusal — a key this process cannot
 * classify is used as configured, because refusing on a guess would lock an operator out of
 * a project that works.
 */
function jwtRole(key) {
  const payload = key.split('.')[1];
  if (!payload) return null;
  let claims;
  try {
    claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (!claims || typeof claims !== 'object') return null;
  return claims.role === 'anon' || claims.role === 'service_role' ? claims.role : null;
}

/**
 * What kind of key this is, and therefore which headers carry it.
 *
 * Supabase now issues two kinds of key and both systems work at once, so this file has to
 * speak both without asking the operator which one they pasted:
 *
 *   legacy JWT   `eyJ...`               `apikey` AND `Authorization: Bearer`
 *   anything else, `sb_secret_...` included   `apikey` ALONE
 *
 * The new keys are not JWTs — they are short opaque strings — so anything that tries to
 * verify one as a JWT fails, and a `Bearer` header carrying one is a token the other end
 * cannot check. `apikey` on its own is sufficient for them: a secret key resolves to the
 * `service_role` Postgres role, which has BYPASSRLS, exactly as the legacy key did.
 *
 * Sending `Bearer` for a legacy key is not a courtesy either — it is what PostgREST
 * authenticates with — so the answer really does depend on the key and cannot be a
 * constant. It is decided ONCE, here, at configuration time; `buildHeaders` only reads the
 * result, so no request re-examines the key.
 *
 * `label` is the boot line's words and contains no part of the key: a fixed phrase, and for
 * a legacy key one of two known role names. `kind` is what init() refuses on.
 *
 * @param {string} key
 * @returns {{kind: 'jwt'|'secret'|'publishable'|'opaque', role: string|null,
 *            sendBearer: boolean, label: string}}
 */
function classifyKey(key) {
  if (JWT_RE.test(key)) {
    const role = jwtRole(key);
    const named = role ? role : '역할 미상';
    return {
      kind: 'jwt',
      role,
      sendBearer: true,
      label: `레거시 JWT 키 (${named})`,
    };
  }
  if (key.startsWith(PUBLISHABLE_PREFIX)) {
    return { kind: 'publishable', role: 'anon', sendBearer: false, label: '새 형식 공개 키 (sb_publishable_)' };
  }
  if (key.startsWith(SECRET_PREFIX)) {
    return { kind: 'secret', role: 'service_role', sendBearer: false, label: '새 형식 비밀 키 (sb_secret_)' };
  }
  // A key shape this file has never seen. It is not a JWT, so it goes on `apikey` alone —
  // the same treatment sb_secret_ gets, and the right answer for whatever Supabase issues
  // next. It is not refused: refusing an unrecognised key would turn every future format
  // into an outage that only a code change could clear.
  return { kind: 'opaque', role: null, sendBearer: false, label: 'JWT 가 아닌 키' };
}

/**
 * Read the environment fresh, memoised on the values themselves so a process that changes
 * them (a test harness pointing at a stand-in server) is followed rather than ignored.
 *
 * Throws when the configuration is incomplete. init() turns that into a loud boot failure;
 * appendJournal turns it into a false, never into an unacknowledged claim of durability.
 *
 * @type {{url: string, key: string, schema: string, rest: string, host: string,
 *         keyKind: string, keyRole: string|null, keyLabel: string,
 *         sendBearer: boolean}|null}
 */
let configCache = null;

function config() {
  const url = envString('SUPABASE_URL');
  const key = envString('SUPABASE_SERVICE_KEY');
  const schema = envString('SUPABASE_SCHEMA') || 'public';
  if (configCache && configCache.url === url && configCache.key === key && configCache.schema === schema) {
    return configCache;
  }
  if (!url) {
    throw new Error('SUPABASE_URL 이 비어 있습니다. .env 를 확인하세요.');
  }
  if (!key) {
    throw new Error(
      'SUPABASE_SERVICE_KEY 가 비어 있습니다. Supabase 대시보드의 '
        + 'Project Settings → API Keys → Secret keys 에서 sb_secret_ 로 시작하는 키를 만들어 .env 에 넣으세요. '
        + '(예전 프로젝트라면 같은 화면의 레거시 service_role 키도 그대로 됩니다.)',
    );
  }
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('SUPABASE_URL 이 올바른 주소가 아닙니다. 예: https://프로젝트이름.supabase.co');
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error('SUPABASE_URL 은 http:// 또는 https:// 로 시작해야 합니다.');
  }
  // Both `https://<project>.supabase.co` and a URL that already points at the REST root
  // are accepted, because an operator copying from the dashboard may paste either.
  const root = `${parsed.origin}${parsed.pathname.replace(/\/+$/, '')}`;
  const rest = /\/rest\/v1$/.test(root) ? root : `${root}/rest/v1`;
  // Decided here, once, and read from the cache by every request afterwards. It is a
  // property of the CONFIGURATION, not of a request, and re-deriving it per request would
  // mean touching the key on the hot path for an answer that cannot have changed.
  const format = classifyKey(key);
  configCache = {
    url,
    key,
    schema,
    rest,
    host: parsed.host,
    keyKind: format.kind,
    keyRole: format.role,
    keyLabel: format.label,
    sendBearer: format.sendBearer,
  };
  return configCache;
}

/**
 * Strip anything secret out of a string that is about to be logged or thrown.
 *
 * The service key is only ever sent as a header, so a URL should never contain it — but
 * "should never" is not a guarantee, and one leaked line in a log file hands over the
 * whole database. Both current key shapes are matched (a JWT and the newer `sb_secret_`
 * form), plus any key-looking query parameter, whatever produced it.
 */
function redact(text) {
  let out = typeof text === 'string' ? text : String(text == null ? '' : text);
  const key = envString('SUPABASE_SERVICE_KEY');
  if (key.length >= 8) out = out.split(key).join('***');
  const anon = envString('SUPABASE_ANON_KEY');
  if (anon.length >= 8) out = out.split(anon).join('***');
  // A whole JWT, and also a TRUNCATED one: a response body that was cut short can carry
  // the first part of a key, and half a secret is still half a secret in a log file.
  out = out.replace(/\beyJ[A-Za-z0-9_-]{8,}(?:\.[A-Za-z0-9_-]+){0,2}/g, '***');
  out = out.replace(/\bsb_(?:secret|publishable)_[A-Za-z0-9_-]+/g, '***');
  out = out.replace(/([?&](?:apikey|api_key|access_token|key|token)=)[^&\s]+/gi, '$1***');
  return out;
}

// ---------------------------------------------------------------------------
// quarantine — a document whose stored state could not be READ (SPEC 27.6)
// ---------------------------------------------------------------------------

// Ids arrive from URLs and from database rows; the pattern is re-checked at the last
// possible moment rather than trusted.
function assertDocId(id) {
  if (typeof id !== 'string' || !DOC_ID_RE.test(id)) throw new Error('invalid document id');
  return id;
}


/**
 * The documents this process refuses to touch, and why.
 *
 * Set by the two reads that look at a document's stored state — `loadDoc` and
 * `readJournal` — and never cleared. Checked by every call that could overwrite, truncate
 * or delete. This is the file store's `io.get(id).unread` with the same lifetime and the
 * same refusals, because SPEC 29.1 says the interface behaves identically whichever backend
 * is configured, and a guard that lives in one caller is a guard the next caller will miss.
 *
 * WHY AN IN-PROCESS MAP IS SOUND HERE, given the shape of the bug two rounds ago.
 *
 * That bug was an in-memory guard that refused ONE destructive step — the truncate — while
 * the document went on being served. Its rev climbed past the unread records into snapshots
 * that did not contain them; the next boot then read the journal perfectly, replayed
 * nothing (replay skips every record with `rev <= doc.rev`) and truncated with a clear
 * conscience. The guard did not fail. It succeeded, and handed the deletion to the next
 * boot. The lesson is not "never keep the state in memory"; it is that the state only holds
 * across a restart if NOTHING THE NEXT BOOT WILL READ can change while it is in force.
 *
 * This map covers every statement this backend can issue for a quarantined document:
 *
 *   sz_journal    no INSERT (appendJournal answers false), no DELETE (truncateJournal and
 *                 deleteDoc reject)
 *   sz_documents  no upsert (saveSnapshot rejects), no DELETE (deleteDoc rejects)
 *   sz_backups    no INSERT and no prune, both of which only ever run inside saveSnapshot
 *
 * So not one tuple for that document is created, replaced or removed. `rev` in
 * `sz_documents` moves only in `saveSnapshot`, and refusing that single statement is what
 * keeps the snapshot from advancing past journal rows nobody read — which was the entire
 * mechanism of the earlier loss. The next boot therefore issues the same queries against the
 * same rows and re-derives the same answer: either the read succeeds, and replay is then
 * CORRECT because the snapshot's rev never moved past the rows the journal still holds, or
 * it fails again and the document is quarantined again. The state is re-derived from the
 * database every boot, never remembered — which is why no marker row is written, and why
 * one would be worse: a marker is a row in the database that just failed to answer, and it
 * would outlive the fault as a permanent outage nobody can clear without SQL.
 *
 * One difference from the file store is worth naming, because it makes the refusal matter
 * MORE here rather than less. A file snapshot is replaced by `rename`, so the bytes this
 * process could not read survive as `<id>.bak.1` even when the store was wrong to write.
 * A Postgres upsert has no such consolation: `sz_documents` holds one row per document and
 * the merge REPLACES it, so a snapshot written over an unread document would leave that
 * document's stored value nowhere at all except whatever `sz_backups` happens to hold — and
 * that insert is explicitly best-effort. There is no rotation to fall back on. Refusing is
 * the only thing standing between an unread row and an unrecoverable overwrite.
 *
 * The in-memory truncation watermark cannot outlive the quarantine into a delete either:
 * `snapshotSeq` is published only after an upsert commits, that upsert is refused, and
 * `truncateJournal` rejects before it reads the map at all.
 *
 * @type {Map<string, {what: string, cause: unknown, at: number, warnedAppend: boolean}>}
 */
const unread = new Map();

/**
 * The error every UNREAD outcome travels in (SPEC 29.1).
 *
 * `code` is what a caller compares, exactly as it would compare `ENOENT`; `cause` keeps the
 * original failure reachable, so the HTTP status survives the wrapping. The message says
 * what could not be read and what is therefore NOT going to happen to it, because a person
 * reading the log needs the consequence more than the verb.
 *
 * The detail is redacted before it is embedded. Everything `request` throws is redacted
 * already, but this string ends up in a log line and in `err.message`, and one leaked
 * fragment of the service key hands over the whole database — so it is redacted again here
 * rather than trusted to have been.
 */
function unreadError(id, what, cause) {
  const detail = redact(cause && cause.message ? cause.message : String(cause));
  const err = new Error(
    `${id}: ${what}을 읽지 못했습니다 (${detail}). 내용을 확인할 수 없어 이 문서는 손대지 않습니다.`,
  );
  err.code = UNREAD_CODE;
  err.docId = id;
  err.cause = cause;
  return err;
}

/**
 * Quarantine this document and return the error to throw (SPEC 27.6).
 *
 * The FIRST failure is the one kept: it is the one that names the read this process could
 * not complete, and every later refusal is only a consequence of it. The line is printed
 * once per document, at error level, because it is the operator's whole cue — the document
 * will not come back without a restart, and nothing else says so.
 */
function markUnread(id, what, cause) {
  const err = unreadError(id, what, cause);
  if (!unread.has(id)) {
    unread.set(id, { what, cause, at: Date.now(), warnedAppend: false });
    console.error(`[시트지] ${err.message} 원인을 고친 뒤 서버를 다시 시작하세요.`);
  }
  return err;
}

/**
 * Throw if this document is quarantined (SPEC 29.1).
 *
 * Called in two kinds of place, and only one of them is the guarantee. At the top of a
 * public call and at the top of a queued task it is an EARLY-OUT, so a document that is
 * already refusing everything does not queue work or open a connection to be refused
 * later. Inside `fetchOnce` — the one function in this file that can put a statement on the
 * wire — it is the GUARD, asked as the last thing before the request goes out and again
 * once the answer is back.
 *
 * The distinction is the whole of the fix. A check at the top of `saveSnapshot`'s task
 * passed, the `sz_documents` upsert then replaced the only row, an `sz_backups` INSERT
 * followed and a prune DELETE ground two surviving copies off the ring — all of it after a
 * quarantine was in force, all of it verified through a proxy holding the upsert on the
 * wire. Placing checks at call sites is what failed three review rounds running; the guard
 * is now on the transport, where a new call site cannot get past it by being new.
 */
function assertReadable(id) {
  const state = unread.get(id);
  if (state) throw unreadError(id, state.what, state.cause);
}

/** Is this the quarantine refusal, as opposed to a transient network or HTTP failure? */
function isUnread(err) {
  return Boolean(err) && err.code === UNREAD_CODE;
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

function buildUrl(cfg, table, query) {
  const params = new URLSearchParams();
  if (query) {
    for (const [param, value] of Object.entries(query)) {
      if (value === undefined || value === null) continue;
      params.append(param, String(value));
    }
  }
  const qs = params.toString();
  return qs ? `${cfg.rest}/${table}?${qs}` : `${cfg.rest}/${table}`;
}

function buildHeaders(cfg, method, prefer) {
  // `apikey` is what the Supabase gateway routes on, and it is ALWAYS sent: it is what
  // resolves the key to a Postgres role, and for a secret key that role is `service_role`
  // with BYPASSRLS — the same privilege the legacy key carried, from the one header.
  //
  // `Authorization: Bearer` is what PostgREST authenticates with, and it is sent ONLY for
  // a legacy JWT key, because only a JWT can be verified as one. The current keys are
  // short opaque strings; presenting one as a bearer token asks the other end to verify
  // something that is not a token, and that verification fails — so a header meant to
  // authenticate would be the thing refusing the request. The decision was made once in
  // config(); this reads it rather than re-examining the key on every request.
  const headers = {
    apikey: cfg.key,
    Accept: 'application/json',
  };
  if (cfg.sendBearer) headers.Authorization = `Bearer ${cfg.key}`;
  if (method === 'GET' || method === 'HEAD') {
    headers['Accept-Profile'] = cfg.schema;
  } else {
    headers['Content-Profile'] = cfg.schema;
    headers['Content-Type'] = 'application/json';
  }
  if (prefer) headers.Prefer = prefer;
  return headers;
}

/**
 * The pause between two attempts of the same request.
 *
 * The timer is deliberately REF'D, and that is the whole of this function. Between two
 * attempts it is the only pending work this process has: unref it and an event loop
 * holding nothing else does not wait — it exits, code 0, with no error and no log line,
 * in the middle of the backoff. The awaited promise never settles, so the caller's
 * question is not answered false, it is not answered at all. `appendJournal` promising a
 * plain yes or no (SPEC 29.1) would then be broken by the one thing a caller cannot
 * defend against.
 *
 * `server.js` happens to be shielded — its listening socket holds the loop — but the
 * second caller SPEC 29.1 names is not: a script run by hand, a backup job, an exporter,
 * none of which own a socket. `fetchOnce`'s abort timer is ref'd for exactly this reason
 * and cleared in its `finally`; this one is cleared by firing, which is the only way out
 * of this promise. A backoff can hold the loop for at most the longest RETRY_DELAYS_MS,
 * and it holds it for work that is really about to happen.
 */
function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

// The verbs that can create, replace or destroy a row. `request` refuses to build one of
// these without being told which document it is for, and `fetchOnce` refuses to send it
// for a document whose stored state this process could not read.
const MUTATING_METHODS = new Set(['POST', 'PATCH', 'PUT', 'DELETE']);

/**
 * One attempt, with the timeout covering the BODY as well as the headers: a response that
 * starts and never finishes is a hang like any other.
 *
 * This is also THE MUTATION GATE. Every statement this backend can issue leaves the
 * process through the `fetch` below and through no other call, so a write cannot happen
 * without passing the two checks around it:
 *
 *   before   `assertReadable(guardId)` is the last statement before the request goes out,
 *            with no `await` in between. There is no gap for a read to fail in, because
 *            there is no gap. This is what makes a NEW call site safe by default: the
 *            author has to say which document the statement is for (see `request`) and
 *            gets the refusal whether or not they have ever heard of SPEC 27.6.
 *   after    the ACK RULE. A statement already on the wire when the quarantine landed may
 *            have committed, and nothing can recall it — but it must not be REPORTED as
 *            done. `appendJournal` then answers false and the client keeps the frame
 *            (SPEC 27.4); `saveSnapshot` rejects, so the caller never truncates the
 *            journal. A duplicate a client resends costs nothing, because replay is
 *            idempotent. A record claimed under doubt costs somebody's typing.
 *
 * `guardId` is null for a GET or a HEAD. Reading is not writing: `listBackups` and the
 * boot-time table check must keep working for a quarantined document (SPEC 29.1), and the
 * reads that DO quarantine mark the document themselves.
 *
 * >>> MUTATION GATE — begin (tools/check-writes.mjs)
 */
async function fetchOnce(url, init, timeoutMs, guardId) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    if (guardId !== null) assertReadable(guardId);
    const res = await fetch(url, { ...init, signal: controller.signal });
    const text = await res.text();
    if (guardId !== null) assertReadable(guardId);
    return { status: res.status, ok: res.status >= 200 && res.status < 300, text };
  } catch (err) {
    // A quarantine is not a transient failure and must not be retried into one: it leaves
    // as itself, so `request` stops instead of trying the same statement twice more.
    if (isUnread(err)) throw err;
    if (controller.signal.aborted) {
      const timeout = new Error(`응답이 ${timeoutMs}ms 안에 오지 않았습니다`);
      timeout.timedOut = true;
      throw timeout;
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
// <<< MUTATION GATE — end (tools/check-writes.mjs)

// A hosted database returns these while it is briefly unavailable; the same request a
// moment later usually succeeds. Everything else in the 4xx range is a request that is
// wrong and will stay wrong.
function isRetryable(status) {
  return status >= 500 || status === 408 || status === 429;
}

// PostgREST reports failures as { message, code, details, hint }. Anything else — an HTML
// error page from a proxy, say — is kept as a short prefix so the log stays readable.
function describeFailure(text) {
  const body = (text || '').trim();
  if (!body) return '(본문 없음)';
  try {
    const parsed = JSON.parse(body);
    if (parsed && typeof parsed === 'object') {
      const parts = [];
      if (parsed.code) parts.push(String(parsed.code));
      if (parsed.message) parts.push(String(parsed.message));
      if (parsed.hint) parts.push(`힌트: ${String(parsed.hint)}`);
      if (parts.length) return redact(parts.join(' — ')).slice(0, 300);
    }
  } catch {
    /* not JSON: fall through to the raw prefix */
  }
  return redact(body).slice(0, 200);
}

/** True when the request asked PostgREST not to send a representation back. */
function wantsNoBody(prefer) {
  return typeof prefer === 'string' && prefer.toLowerCase().includes('return=minimal');
}

/**
 * A 2xx response's body into a value — or a THROWN error.
 *
 * The distinction this makes is the entire point of the function. `null` means "no body
 * arrived and none was asked for": a `return=minimal` write, or a 204. It must NEVER also
 * mean "a body arrived and I could not read it", because a caller cannot tell that apart
 * from "no rows" — and readJournal reporting no rows is how a compaction comes to truncate
 * records it never managed to read. A body that will not parse is a FAILED request: it is
 * retried like any other transient failure and then rejected, so the read fails loudly and
 * boot stops instead of quietly replaying nothing.
 *
 * An empty body where one was expected is the same fault wearing a different hat. A GET
 * always answers with a JSON array — `[]` when nothing matched — so zero bytes there is a
 * response that lost its payload on the way, not an empty table.
 */
function parseBody(label, method, prefer, status, text) {
  const body = (text || '').trim();
  if (!body) {
    if (status === 204 || status === 205 || method === 'HEAD' || wantsNoBody(prefer)) return null;
    const empty = new Error(`${label} 응답 본문이 비어 있습니다 (HTTP ${status})`);
    empty.unreadableBody = true;
    throw empty;
  }
  try {
    return JSON.parse(body);
  } catch (err) {
    // The prefix is redacted before it is truncated, so nothing secret can survive in a
    // fragment. It is here because "the proxy sent an HTML error page" and "the bytes were
    // cut short" need different fixes and the operator has to be able to tell which it was.
    // The parser's own message quotes the body back, so its quoted part is dropped: the
    // redacted prefix below already shows what arrived, and it shows it redacted.
    const reason = redact(err && err.message).replace(/"[^"]*"/g, '…');
    const bad = new Error(
      `${label} 응답을 해석하지 못했습니다 (HTTP ${status}, ${body.length}바이트): `
        + `${reason} / 본문 앞부분: ${redact(body).slice(0, 120)}`,
    );
    bad.unreadableBody = true;
    throw bad;
  }
}

/**
 * One PostgREST request, retried twice with a short backoff.
 *
 * Resolves with the parsed body (null for `return=minimal`). Rejects with an Error whose
 * `status` is set for an HTTP failure and absent for a network failure, a timeout, or a
 * 2xx whose body could not be read. The message never contains the URL or the key — only
 * the table, the verb and what the database said.
 *
 * A 2xx with an unreadable body is a FAILURE, not an empty result. It is the one thing
 * this layer must never soften, because every caller above treats "no rows" as a fact
 * about the database and some of them delete against it.
 *
 * A retried POST can duplicate a row when the first attempt actually committed and only
 * its response was lost. That is deliberate: journal replay is idempotent (records are
 * applied last-write-wins and guarded by `rev`), so a duplicate costs nothing, while a
 * record dropped because the write was not retried costs somebody's typing.
 *
 * A MUTATING request must name the document it changes, in `options.docId`. That is not a
 * convention: this function throws without it, so there is no way to write to the database
 * anonymously and therefore no way to add a write that skips the quarantine. `saveSnapshot`
 * used to check once and then issue three statements — an upsert, a backup INSERT and a
 * prune DELETE — of which only the first was ever anywhere near a check. Now all three are
 * gated because all three are statements, not because somebody remembered them.
 */
async function request(method, table, options = {}) {
  const verb = String(method).toUpperCase();
  let guardId = null;
  if (MUTATING_METHODS.has(verb)) {
    if (typeof options.docId !== 'string' || options.docId === '') {
      throw new Error(
        `${table} ${verb}: 어느 문서를 바꾸는 요청인지 밝히지 않았습니다 (docId 없음). `
          + '쓰기 요청은 문서를 지정해야 합니다.',
      );
    }
    guardId = assertDocId(options.docId);
  }
  const cfg = config();
  const url = buildUrl(cfg, table, options.query);
  const init = { method, headers: buildHeaders(cfg, method, options.prefer) };
  if (options.body !== undefined) init.body = options.body;
  const timeoutMs = options.timeoutMs || REQUEST_TIMEOUT_MS;
  const label = `${table} ${method}`;

  let lastError = null;
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    if (attempt > 0) await delay(RETRY_DELAYS_MS[attempt - 1]);
    let res;
    try {
      res = await fetchOnce(url, init, timeoutMs, guardId);
    } catch (err) {
      // A quarantine landed on this document — before this attempt or while it was in
      // flight. Retrying would only send the same statement twice more, so it leaves as
      // itself and every caller reads it as SPEC 29.1's ESTOREUNREAD.
      if (isUnread(err)) throw err;
      // A network error or a timeout: transient by nature, so it is worth another try.
      lastError = new Error(`${label} 요청 실패: ${redact(err && err.message)}`);
      continue;
    }
    if (res.ok) {
      try {
        return parseBody(label, method, options.prefer, res.status, res.text);
      } catch (err) {
        // A 2xx whose body did not survive the trip. Treated exactly like a network
        // failure — worth another attempt, and a rejection if it keeps happening — and
        // never as a null the caller would read as "no rows".
        lastError = err;
        continue;
      }
    }
    const failure = new Error(`${label} 실패 (HTTP ${res.status}): ${describeFailure(res.text)}`);
    failure.status = res.status;
    if (!isRetryable(res.status)) throw failure;
    lastError = failure;
  }
  throw lastError || new Error(`${label} 실패`);
}

/**
 * A parsed body into rows — or a throw.
 *
 * PostgREST answers a GET with a JSON array, `[]` when nothing matched, so anything else
 * is a response this code does not understand. Returning an empty list for it would be the
 * same mistake parseBody just stopped making one layer down: an unreadable answer that a
 * caller reads as "the table is empty", and then deletes against.
 *
 * A singular representation (a bare object) is still accepted as a one-row page. We never
 * ask for one, but a gateway that answers with it is telling us about a row that exists.
 */
function rowsOf(data, what) {
  if (Array.isArray(data)) return data;
  if (data && typeof data === 'object') return [data];
  throw new Error(`${what}: 행 목록이 아닌 응답을 받았습니다 (${data === null ? '본문 없음' : typeof data})`);
}


// ---------------------------------------------------------------------------
// per-document serialisation and the truncation watermark
// ---------------------------------------------------------------------------

/**
 * One promise chain per document, exactly as the file store keeps one per file: journal
 * appends, snapshots and truncations for a single document never overlap, so `seq` order
 * always matches the order the operations were accepted in, and no append can land
 * between a snapshot and the truncation that follows it.
 *
 * @type {Map<string, Promise<unknown>>}
 */
const chains = new Map();

// How many tasks have ever been queued. flush() watches it to tell "everything in flight
// has finished" from "everything I knew about when I started has finished".
let queuedTotal = 0;

function queue(id, task) {
  queuedTotal++;
  const previous = chains.get(id) || Promise.resolve();
  const done = previous.then(task);
  // The chain itself is kept alive with a neutralised copy, so one failure cannot poison
  // every later operation for this document.
  chains.set(id, done.then(() => {}, () => {}));
  return done;
}

/**
 * The bound the last successful snapshot was taken against: rows at or below it are
 * contained in that snapshot and may be deleted. Set only AFTER the snapshot lands, and
 * captured BEFORE it is written, which is the whole reason truncation is never a blanket
 * delete — a record appended while the snapshot was being written has a higher seq and
 * survives.
 *
 * This map is the ONLY thing a delete is ever allowed to aim at. There is deliberately no
 * second source for the bound: a "highest seq we happened to read" fallback would delete
 * records that live only in this process's memory, which is precisely the window SPEC 27.1
 * closes by demanding the snapshot be written first.
 *
 * @type {Map<string, number>}
 */
const snapshotSeq = new Map();

/**
 * The highest seq the journal currently holds for one document, or 0 if it is empty.
 *
 * This is the number a truncation deletes against, so it has exactly two honest answers:
 * a seq the database reported, or a throw. An unreadable seq is NOT a 0 — it is an
 * unknown, and turning an unknown into a default here is one map lookup away from a DELETE
 * with the wrong bound.
 */
async function maxJournalSeq(id) {
  const rows = rowsOf(
    await request('GET', T_JOURNAL, {
      query: { select: 'seq', doc_id: `eq.${id}`, order: 'seq.desc', limit: '1' },
    }),
    `${T_JOURNAL} 최대 seq 조회 (${id})`,
  );
  if (!rows.length) return 0; // an empty journal: there is nothing to truncate against
  const seq = Number(rows[0] && rows[0].seq);
  if (!Number.isFinite(seq) || seq <= 0) {
    throw new Error(`${T_JOURNAL}: seq 값을 읽지 못했습니다 (${id}). 저널을 자를 기준을 알 수 없습니다.`);
  }
  return seq;
}

// ---------------------------------------------------------------------------
// lifecycle
// ---------------------------------------------------------------------------

/**
 * Verify the database is actually set up, and fail LOUDLY naming the SQL file if it is
 * not. A server that boots against a database with no tables looks healthy and loses
 * everything typed into it, which is the worst outcome available here — so this throws,
 * and server.js never reaches the point of accepting an edit.
 */
export async function init() {
  const cfg = config(); // an incomplete environment throws here, before any request
  // The FORMAT, never the key. This one line is what lets an operator tell a wrong-key
  // problem from a wrong-URL problem without pasting a secret to anybody: everything after
  // it is about the address and the tables, so a failure below with this line above it has
  // already ruled the key's shape in or out.
  console.log(
    `[시트지] Supabase 키 형식: ${cfg.keyLabel} — ${cfg.sendBearer
      ? 'apikey 와 Authorization: Bearer 두 헤더로 보냅니다.'
      : 'apikey 헤더로만 보냅니다.'}`,
  );
  assertPrivilegedKey(cfg);
  for (const [table, columns] of Object.entries(TABLE_COLUMNS)) {
    try {
      await request('GET', table, { query: { select: columns, limit: '1' } });
    } catch (err) {
      throw describeSetupFailure(table, columns, err);
    }
  }
  console.log(
    `[시트지] Supabase 테이블 확인 완료: ${Object.keys(TABLE_COLUMNS).join(', ')} (스키마 ${cfg.schema})`,
  );
}

/**
 * Refuse to start on a key that HAS NO PRIVILEGES (SPEC 29.3).
 *
 * This is a CONFIGURATION error, not an authentication failure, and the difference is the
 * reason it is caught here rather than left to the first request. A publishable key is a
 * real, valid key: the gateway accepts it, it resolves to the `anon` role, and `anon` is
 * exactly the role docs/supabase.sql leaves with RLS on, no policies and no grants. So the
 * server would boot, serve the login page, seat people in a document and refuse every
 * single write — a site that runs and cannot save, which is the hardest failure to read
 * from the outside and the one that quietly costs somebody's typing. Failing loudly costs
 * a restart; this is the same asymmetry SPEC 27.6 is built on.
 *
 * Two keys are refused and they are refused for one reason — no privileges:
 *
 *   sb_publishable_…   the browser-safe half of the current pair. Named by its prefix,
 *                      which is the only thing that distinguishes it: it is opaque, so
 *                      there is nothing inside it to read.
 *   a legacy JWT whose `role` claim is `anon`. The claim is in the payload, which is not
 *                      the secret part of a JWT, and it is read for this one comparison
 *                      and never printed. It is refused only on a POSITIVE answer: a
 *                      payload that will not decode, or that names a role this file does
 *                      not know, is left alone and used as configured.
 *
 * Everything else is allowed through, including a key shape this file has never seen. The
 * two refusals above are the ones where a WRONG configuration is provable from the key
 * itself; refusing anything further would be refusing on a guess, and an over-refusal is
 * an outage in the costume of caution.
 *
 * The message names the screen the right key is on, because "use the service key" is the
 * instruction that sends an operator back to a dashboard that no longer offers one.
 */
function assertPrivilegedKey(cfg) {
  if (cfg.keyKind !== 'publishable' && !(cfg.keyKind === 'jwt' && cfg.keyRole === 'anon')) return;
  const what = cfg.keyKind === 'publishable'
    ? 'SUPABASE_SERVICE_KEY 에 공개용(publishable) 키가 들어 있습니다.'
    : 'SUPABASE_SERVICE_KEY 에 anon 키가 들어 있습니다 (레거시 JWT 의 role 이 anon).';
  const lines = [
    `[시트지] ${what} 이 키에는 아무 권한이 없어 서버는 켜지지만 저장이 전부 실패합니다.`,
    '[시트지] 해결: Supabase 대시보드 → Project Settings → API Keys → Secret keys 에서 '
      + 'sb_secret_ 로 시작하는 키를 만들어 SUPABASE_SERVICE_KEY 에 넣으세요.',
    '[시트지] (예전 프로젝트의 레거시 service_role 키도 그대로 됩니다. 브라우저에 넣는 키는 어느 쪽도 아닙니다.)',
  ];
  for (const line of lines) console.error(line);
  const err = new Error(
    '권한이 없는 Supabase 키입니다. Project Settings → API Keys → Secret keys 의 sb_secret_ 키를 넣으세요.',
  );
  err.configuration = true;
  throw err;
}

/**
 * Turn a failed table check into an instruction a person can act on. Every branch names
 * docs/supabase.sql when running it is the fix, because "table not found" on its own
 * sends the operator hunting.
 */
function describeSetupFailure(table, columns, err) {
  const status = err && err.status;
  const detail = redact(err && err.message);
  const lines = [];
  // The FORMAT the store decided on, so a 401 can be read without anyone pasting a key
  // anywhere. It is built from string literals in classifyKey and holds no part of the key.
  // config() can itself be the thing that is broken, hence the guard.
  let keyLabel = '알 수 없음';
  try {
    keyLabel = config().keyLabel;
  } catch {
    /* the configuration is incomplete; the format is simply not known */
  }
  if (status === 404 || /PGRST205|PGRST202|does not exist|42P01/i.test(detail)) {
    lines.push(`[시트지] Supabase 에 '${table}' 테이블이 없습니다.`);
    lines.push(`[시트지] 해결: Supabase 대시보드 → SQL Editor → New query 에 ${SQL_FILE} 내용을 전부 붙여넣고 Run 하세요.`);
  } else if (status === 400 && /PGRST100|PGRST118|42703|column/i.test(detail)) {
    lines.push(`[시트지] '${table}' 테이블의 열 구성이 다릅니다. 필요한 열: ${columns}`);
    lines.push(`[시트지] 해결: ${SQL_FILE} 을 다시 확인해 테이블을 이 구조로 맞추세요.`);
  } else if (status === 401 || status === 403) {
    lines.push(
      `[시트지] Supabase 인증에 실패했습니다. 이 서버가 읽은 키 형식은 '${keyLabel}' 입니다.`,
    );
    lines.push(
      '[시트지] Project Settings → API Keys → Secret keys 의 sb_secret_ 키, 또는 예전 프로젝트라면 '
        + '레거시 service_role 키가 맞는지 확인하세요.',
    );
    lines.push('[시트지] (브라우저용 공개 키로는 아무것도 읽고 쓸 수 없습니다. 이는 의도된 설정입니다.)');
  } else {
    lines.push('[시트지] Supabase 에 연결하지 못했습니다. SUPABASE_URL 과 네트워크를 확인하세요.');
  }
  lines.push(`[시트지] 원인: ${detail}`);
  for (const line of lines) console.error(line);
  const summary = new Error(`Supabase 저장소를 사용할 수 없습니다 (${table}) — ${SQL_FILE} 을 실행했는지 확인하세요.`);
  summary.status = status;
  return summary;
}

/**
 * Before a clean exit (SPEC 27.1).
 *
 * There is nothing buffered to force out: a row this backend reported as durable was
 * committed by Postgres before `appendJournal` resolved, so there is no fsync equivalent
 * and no window to lose. All that remains is to let work already in flight finish.
 *
 * Draining ONCE is not enough. A task queued while the first pass was awaiting would not
 * be in the list that pass took, and at a clean exit "not waited for" means a journal row
 * that never got written. So the drain repeats until a pass completes with nothing new
 * having been queued, bounded so a caller that keeps queueing cannot hold the exit open
 * for ever.
 */
export async function flush() {
  for (let pass = 0; pass < 20; pass++) {
    const before = queuedTotal;
    await Promise.all([...chains.values()].map((chain) => chain.catch(() => {})));
    if (queuedTotal === before) return;
  }
  console.warn('[시트지] 저장 작업이 계속 추가되어 종료 전 정리를 20회에서 멈춥니다.');
}

// ---------------------------------------------------------------------------
// journal
// ---------------------------------------------------------------------------

/**
 * Append one accepted operation to this document's journal (SPEC 27.1).
 *
 * Resolves `true` ONLY on a response this process actually received carrying a 2xx: at
 * that point the row is committed and therefore durable. A network error, a timeout, a
 * 4xx and a 5xx that survived its retries all resolve `false`, so the operation is not
 * acknowledged and the client keeps holding it (SPEC 27.4). Nothing here is optimistic —
 * an ack is the client's licence to forget the frame, and it is only ever issued for a
 * write the database confirmed.
 *
 * Never throws: a rejected promise here would become an exception on the edit path, and
 * the answer to "did it save?" must always be a plain yes or no.
 *
 * A quarantined document (SPEC 27.6) answers `false` and writes nothing. Appending is not
 * itself destructive, but a row appended to a journal this process could not read would
 * carry a `rev` minted from a snapshot that did not include the unread rows — colliding
 * with them, and making the journal impossible to replay unambiguously afterwards. `false`
 * is the answer that already exists for "not durable": the ack is withheld, the client
 * keeps the frame in its outbox (SPEC 27.4), and nothing is lost while the operator
 * restarts. This is the one place UNREAD is not a throw, because `false` is what every call
 * site here already handles.
 */
export function appendJournal(id, record) {
  let body;
  try {
    assertDocId(id);
    if (!record || typeof record !== 'object' || Array.isArray(record)) {
      throw new Error('저널 레코드가 객체가 아닙니다');
    }
    // `at` is a bigint column: a fractional value is rejected by Postgres, and a rejected
    // append is an edit that can never be acknowledged however often the client resends
    // it. The record's own `at` inside `rec` is untouched.
    const at = Number.isFinite(record.at) ? Math.floor(record.at) : Date.now();
    // The record is serialised on its own FIRST, because `JSON.stringify` answers
    // `undefined` — not a string, and without throwing — for a value it cannot represent,
    // which a record whose own `toJSON()` returns nothing really is. A property whose
    // value serialises to `undefined` is then DROPPED from the enclosing object, so the
    // body below would carry no `rec` at all: a row the NOT NULL column of
    // docs/supabase.sql refuses, and a row holding no record where a hand-made table does
    // not. Refused locally instead, so the answer is this store's rather than a column
    // constraint's, costs no request, and is the same refusal the file store makes
    // (SPEC 29.1).
    const rec = JSON.stringify(record);
    if (typeof rec !== 'string') {
      throw new Error('저널 레코드를 JSON 으로 만들 수 없습니다');
    }
    body = JSON.stringify({ doc_id: id, rec: record, at });
  } catch (err) {
    console.error(`[시트지] 저널 레코드를 만들지 못했습니다 (${id}): ${redact(err && err.message)}`);
    return Promise.resolve(false);
  }
  // Answered before anything is queued, so a quarantined document does not grow a chain of
  // refusals at typing speed.
  if (unread.has(id)) {
    warnAppendRefused(id);
    return Promise.resolve(false);
  }
  return queue(id, async () => {
    // Checked again HERE, because the quarantine can arrive while this task waits its turn
    // and the insert must be decided on the state at the moment it would run.
    if (unread.has(id)) {
      warnAppendRefused(id);
      return false;
    }
    // return=minimal: the insert's own row is not needed. The truncation bound is taken
    // from the journal itself at snapshot time (see saveSnapshot), so asking for a
    // representation on every keystroke would only make the hot path heavier.
    await request('POST', T_JOURNAL, { docId: id, body, prefer: 'return=minimal' });
    return true;
  }).then(
    (ok) => ok === true,
    (err) => {
      console.error(`[시트지] 저널 기록 실패 (${id}): ${redact(err && err.message)}`);
      return false;
    },
  );
}

// Once per document: the line that quarantined it already said why, and this one would
// otherwise repeat itself at typing speed.
function warnAppendRefused(id) {
  const state = unread.get(id);
  if (!state || state.warnedAppend) return;
  state.warnedAppend = true;
  console.warn(
    `[시트지] ${id}: 저장된 내용을 읽지 못한 문서라 새 편집을 기록하지 않습니다. 서버를 다시 시작해야 합니다.`,
  );
}

/**
 * Every journal record for a document, oldest first, plus the seq it read up to.
 *
 * Returns `{ records, badLines, seq }`. `records` are the stored `rec` objects exactly as
 * they were written; `seq` is the COMPANION FIELD carrying the journal seq this read is
 * certain to have covered, so a caller that compacts afterwards can truncate to precisely
 * that point and no further. It is reported alongside the records rather than injected
 * into them, because the records are replayed into the document model and must keep the
 * shapes SPEC 27.1 defines. It is NOT remembered as a truncation bound here: only a
 * committed snapshot may licence a delete.
 *
 * A row whose `rec` is not an object is skipped and counted, the way the file store skips
 * a line that will not parse: one bad record must never cost the whole document. That is
 * the ONLY thing this function is allowed to be quiet about, because a single unreadable
 * record is a known, bounded loss — everything else here is unbounded.
 *
 * A read that fails after its retries throws rather than returning a short list. A
 * partial journal would replay as a document missing edits, and the compaction that
 * follows boot would then write that partial state over the good snapshot and delete the
 * rows it never read. So the paging loop ends on ONE condition only: a page with no rows
 * in it. A short page is not an ending — a server applying its own max-rows cap answers
 * every request with fewer rows than asked for, and "fewer than I asked for" would have
 * been read as "that is all there is" for every document in the database.
 *
 * Every one of those failures QUARANTINES the document as well as rejecting (SPEC 27.6).
 * The rejection alone protects this call; the quarantine is what protects the calls that
 * come after it, which are the ones that overwrite and delete.
 */
export async function readJournal(id) {
  assertDocId(id);
  assertReadable(id);
  try {
    return await readJournalRows(id);
  } catch (err) {
    throw markUnread(id, '저널', err);
  }
}

async function readJournalRows(id) {
  const records = [];
  let badLines = 0;
  let cursor = 0;

  for (let page = 0; ; page++) {
    if (page >= MAX_PAGES) {
      throw new Error(
        `${id}: 저널을 ${MAX_PAGES}쪽까지 읽어도 끝이 나오지 않았습니다. 일부만 읽은 저널로는 복구할 수 없습니다.`,
      );
    }
    const query = {
      select: 'seq,rec',
      doc_id: `eq.${id}`,
      order: 'seq.asc',
      limit: String(PAGE_SIZE),
    };
    if (cursor > 0) query.seq = `gt.${cursor}`;
    const rows = rowsOf(await request('GET', T_JOURNAL, { query }), `${T_JOURNAL} 읽기 (${id})`);
    if (!rows.length) break; // an empty page is the only end of a journal there is

    for (const row of rows) {
      const rec = row ? row.rec : null;
      if (!rec || typeof rec !== 'object' || Array.isArray(rec)) {
        badLines++;
        continue;
      }
      records.push(rec);
    }

    // The cursor is the LAST row the server returned, not the largest seq in the page.
    // The server ordered these rows; taking the maximum instead would step past any row
    // it had not sent yet if that ordering were ever wrong, and a skipped row is a lost
    // edit. Re-reading a row costs a duplicate, which replay is built to absorb.
    const lastSeq = Number(rows[rows.length - 1] && rows[rows.length - 1].seq);
    if (!Number.isFinite(lastSeq) || lastSeq <= cursor) {
      // Either seq is unreadable or the cursor filter was ignored. Both mean this read
      // cannot be trusted to have covered the journal, and a caller must not be handed a
      // list it would treat as complete.
      throw new Error(
        `${id}: 저널 페이지가 seq 순서대로 오지 않았습니다 (기준 ${cursor}). 저널을 끝까지 읽지 못했습니다.`,
      );
    }
    cursor = lastSeq;
  }

  if (badLines) console.warn(`[시트지] ${id}: 읽을 수 없는 저널 레코드 ${badLines}개를 건너뜁니다.`);
  // `seq` is the point this read is CERTAIN to have covered — the contiguous cursor, never
  // the largest seq glimpsed in a page. A caller may pass it back as a truncation bound,
  // so it may only ever understate what was read.
  return { records, badLines, seq: cursor };
}

/**
 * Drop the journal records the freshly written snapshot already contains (SPEC 27.1).
 *
 * NEVER a blanket delete. The bound is the seq captured before that snapshot was written,
 * so a record appended while it was being written — which has a higher seq and is not in
 * it — survives to be replayed.
 *
 * The bound has exactly ONE source: a snapshot that committed in this process and
 * published the mark it was taken against. There is no fallback. A "highest seq we read at
 * boot" bound would look reasonable and would delete records that exist only in memory, so
 * with no published mark this does nothing at all — keeping records that are already
 * compacted is free, losing one is not.
 *
 * `upTo` is optional. A caller that knows exactly which seq its snapshot covered may pass
 * it, and the lower of the two bounds is used, because the safe direction is always to
 * delete less. A malformed `upTo` throws rather than being ignored: ignoring it would
 * silently widen the delete back to the full snapshot bound, which is the opposite of what
 * the caller was asking for.
 *
 * It REJECTS for a quarantined document (SPEC 27.6): a read failed for it, so rows this
 * process never saw may be in the journal, they are in no snapshot, and this is the one
 * step that would actually destroy them. A rejection rather than a quiet return, because
 * the caller has just written a snapshot it believes covers this journal and has to be told
 * that belief is wrong. Nothing is lost by refusing — the journal keeps growing, and
 * growing is recoverable.
 */
export function truncateJournal(id, upTo) {
  assertDocId(id);
  return queue(id, async () => {
    assertReadable(id); // an early-out; the gate refuses the DELETE itself
    const published = snapshotSeq.get(id);
    let bound = Number.isFinite(published) ? published : 0;
    if (upTo !== undefined && upTo !== null) {
      if (!Number.isFinite(upTo) || upTo < 0) {
        throw new Error(`truncateJournal(${id}): upTo 값이 올바르지 않아 저널을 자르지 않았습니다.`);
      }
      bound = Math.min(bound, upTo);
    }
    if (!(bound > 0)) return;
    await request('DELETE', T_JOURNAL, {
      docId: id,
      query: { doc_id: `eq.${id}`, seq: `lte.${bound}` },
      prefer: 'return=minimal',
    });
    // Only now, with the delete confirmed, is the mark spent. A failed delete keeps it, so
    // the next compaction's truncate is the one that clears these rows.
    snapshotSeq.delete(id);
  });
}

// ---------------------------------------------------------------------------
// snapshots and backups
// ---------------------------------------------------------------------------

/**
 * Write the snapshot (SPEC 27.1, 29.3). It is not the source of truth; it is a compaction
 * of the journal, and the order below is the whole point:
 *
 *   1. read the journal's current high-water mark AND the document row this save is about
 *      to replace — BEFORE anything is written, so a record that arrives during the write
 *      is above the mark and cannot be truncated away, and so the copy kept in step 5 is
 *      the OUTGOING generation rather than the incoming one;
 *   2. serialise the document, after that mark is fixed, so the payload can only ever be
 *      newer than the mark and never older;
 *   3. upsert sz_documents — one statement, so the row is never half-replaced;
 *   4. publish the mark for truncateJournal, only now that the snapshot is committed;
 *   5. put the REPLACED document in sz_backups and drop everything past the newest
 *      BACKUP_COUNT.
 *
 * Step 5 keeps what was replaced, not what was just written, and that is the whole of
 * SPEC 27.2 restated for a table: `<id>.bak.1` on a disk is the snapshot the last save
 * rotated out, so `listBackups` index 1 has to mean the same thing here. Inserting the
 * document being WRITTEN instead made index 1 a copy of the live row — a "backup" that
 * differs from the document in no respect at all — and left only BACKUP_COUNT - 1
 * recoverable previous generations where the file store keeps BACKUP_COUNT. A person
 * undoing a regretted bulk edit by hand reads that list and picks from it (SPEC 27.2),
 * and it must not mean one thing on a disk and another in Postgres (SPEC 29.1). With no
 * prior row there is nothing to keep and the insert is skipped, which is the same thing
 * the file store's rotation does on a first save, when `<id>.json` does not exist yet.
 *
 * The prior read is part of step 1 and not part of step 5, so its failure fails the save
 * before anything is written rather than being swallowed as best-effort. An answer this
 * process could not read does not say "there was no prior row"; treating it as one would
 * silently drop a generation out of the ring, which is SPEC 27.6's ABSENT/UNREAD collapse
 * in the one place the ring is filled. It is a read inside a WRITE, so like the
 * high-water mark it quarantines nothing: nothing was written, the caller does not
 * truncate, and the next debounce simply tries again.
 *
 * Step 5 stays best-effort once step 1 has answered, exactly like the file store's backup
 * rotation: a failure there is logged and never fails the save. Steps 3 and 4 are not —
 * if the upsert fails this rejects, the caller never truncates, and the journal keeps
 * everything.
 *
 * The order of 3 and 5 is deliberate and is NOT the file store's. There the outgoing copy
 * is moved aside by a rename before the new one lands; here the backup is inserted after
 * the upsert commits, because inserting first would mean a run of failed upserts each
 * added another copy of the same unchanged live document and BACKUP_COUNT of them would
 * push every genuine older generation off the end of the ring. A failed upsert must leave
 * the ring untouched, and it does.
 *
 * It REJECTS for a quarantined document (SPEC 27.6). A snapshot is an overwrite, and here
 * it is a REPLACE: `sz_documents` holds one row per document, so a merge over a row this
 * process could not read leaves its stored value nowhere but `sz_backups`, whose insert is
 * best-effort — there is no rename putting the unread copy safely in a backup ring first.
 * Refusing here is also what makes the quarantine stateless: with no upsert, the stored
 * `rev` cannot advance past the unread journal rows, so the next boot either reads them and
 * replays them correctly or fails again.
 *
 * A failure of the `maxJournalSeq` read in step 1 is NOT a quarantine. It is a failed write
 * that wrote nothing: the caller never truncates, the journal keeps everything, and the
 * next debounce simply tries again. Quarantining on it would turn one transient 502 during
 * a save into a document nobody can open until the server is restarted — an over-refusal is
 * an outage wearing the costume of caution, and the reads that DO quarantine are the ones
 * whose answer a caller would otherwise mistake for "absent" or "damaged".
 */
export function saveSnapshot(id, doc) {
  assertDocId(id);
  return queue(id, async () => {
    assertReadable(id); // an early-out; the gate in fetchOnce is the guard
    // A read that cannot report the mark throws here, before anything is written: without
    // a trustworthy bound there must be no snapshot to truncate against.
    const upTo = await maxJournalSeq(id);
    // The generation this save is about to replace, read in the same step and for the same
    // reason: both have to be known before the upsert, because afterwards neither can be.
    // A failure throws here too, and nothing has been written when it does.
    const replaced = await outgoingSnapshot(id);
    // A document that cannot be serialised is refused rather than sent. `doc` is a NOT NULL
    // jsonb column, so an object `JSON.stringify` renders as `undefined` would be dropped
    // from the body and the row refused by the database anyway — this makes the answer the
    // store's own, at no request, and identical to the file store's (SPEC 29.1).
    if (!doc || typeof doc !== 'object' || Array.isArray(doc)
      || typeof JSON.stringify(doc) !== 'string') {
      throw new Error(`${id}: 스냅숏으로 만들 수 없는 문서라 저장하지 않았습니다.`);
    }
    // `rev` is a bigint column; a fractional value would fail the upsert outright.
    const rev = Number.isFinite(doc.rev) ? Math.trunc(doc.rev) : 0;
    const body = JSON.stringify({ id, doc, rev, updated_at: Date.now() });

    // There is deliberately no hand-placed re-check between here and the upsert any more.
    // One stood exactly here and was still wrong: it covered the upsert and nothing else,
    // while the `sz_backups` INSERT and the prune DELETE below went out unguarded — and a
    // proxy holding the upsert on the wire showed all three landing after a quarantine was
    // already in force, grinding two surviving copies off the backup ring at the one moment
    // the upsert had replaced the only `sz_documents` row. All three now pass the gate,
    // because all three are statements.
    // resolution=merge-duplicates is what makes POST an upsert on the primary key.
    await request('POST', T_DOCS, {
      docId: id,
      body,
      prefer: 'resolution=merge-duplicates,return=minimal',
    });
    snapshotSeq.set(id, upTo);

    // Nothing to keep on the first save for this id: there was no prior row, so there is no
    // outgoing generation, and the ring stays empty exactly as `<id>.bak.1` does not exist
    // until a second save has something to rotate.
    if (!replaced) return;
    try {
      await request('POST', T_BACKUPS, {
        docId: id,
        // `at` is when THAT generation was written, not when it was pushed down the ring,
        // which is what the file store reports too: rotation is a rename, and a rename
        // carries the file's mtime with it.
        body: JSON.stringify({ doc_id: id, doc: replaced.doc, at: replaced.at }),
        prefer: 'return=minimal',
      });
      await pruneBackups(id);
    } catch (err) {
      // Best-effort covers a backup that could not be written. It does not cover one that
      // must not be written. A quarantine reaching this point landed AFTER the upsert
      // committed, so the stored `rev` has already moved and the caller must not be told
      // the snapshot is safe to truncate against — it would delete journal rows nobody has
      // read. Swallowing this was how the prune DELETE came to run under a quarantine.
      if (isUnread(err)) throw err;
      console.warn(`[시트지] 백업 저장 실패 (${id}): ${redact(err && err.message)}`);
    }
  });
}

/**
 * The document row this save is about to replace, or null when there is none.
 *
 * `{ doc, at }` — the stored jsonb verbatim, and the moment it was written, so the backup
 * row that carries it can report the age of that generation rather than the age of the
 * save that displaced it. The value is passed through untouched and is deliberately not
 * sanitised: a backup is worth most when it is what was really there, and the file store
 * renames the previous bytes into the ring whatever they held.
 *
 * Three answers, and the difference between them is SPEC 27.6:
 *
 *   a row with a document   `{ doc, at }` — keep it
 *   no row, or a row whose `doc` is null   null: ABSENT, there is nothing to keep
 *   a query that failed     THROWS — an answer this process could not read is not
 *                           "no prior row", and reading it as one would drop a
 *                           recoverable generation out of the ring without a word
 *
 * The throw reaches `saveSnapshot` before anything has been written, so it costs one
 * retried save and never a quarantine (SPEC 29.3: nothing inside a write marks).
 */
async function outgoingSnapshot(id) {
  const rows = rowsOf(
    await request('GET', T_DOCS, {
      query: { select: 'doc,updated_at', id: `eq.${id}`, limit: '1' },
    }),
    `${T_DOCS} 이전 스냅숏 조회 (${id})`,
  );
  if (!rows.length) return null; // the first save for this id: nothing to rotate
  const stored = rows[0] ? rows[0].doc : null;
  if (stored === null || stored === undefined) return null; // a row with no document in it
  const at = Number(rows[0].updated_at);
  return { doc: stored, at: Number.isFinite(at) ? at : Date.now() };
}

/**
 * Keep the newest BACKUP_COUNT rows for this document and delete the rest (SPEC 27.2).
 *
 * The cutoff is read rather than computed: ask for the newest BACKUP_COUNT seqs, and the
 * smallest of them is the oldest row worth keeping. Fewer rows than that means there is
 * nothing to prune yet.
 *
 * The smallest is taken across the whole page rather than from its last row, so this does
 * not depend on the ordering having been applied. If it were not, the minimum can only be
 * lower than intended, and a cutoff that is too low keeps backups that could have gone —
 * where one that was too high would delete a copy somebody may need.
 */
async function pruneBackups(id) {
  const rows = rowsOf(
    await request('GET', T_BACKUPS, {
      query: { select: 'seq', doc_id: `eq.${id}`, order: 'seq.desc', limit: String(BACKUP_COUNT) },
    }),
    `${T_BACKUPS} seq 조회 (${id})`,
  );
  if (rows.length < BACKUP_COUNT) return;
  let oldestKept = Infinity;
  for (const row of rows) {
    const seq = Number(row && row.seq);
    if (!Number.isFinite(seq)) return; // an unreadable seq: prune nothing rather than guess
    if (seq < oldestKept) oldestKept = seq;
  }
  if (!Number.isFinite(oldestKept)) return;
  await request('DELETE', T_BACKUPS, {
    docId: id,
    query: { doc_id: `eq.${id}`, seq: `lt.${oldestKept}` },
    prefer: 'return=minimal',
  });
}

/**
 * What SPEC 27.2 kept, newest first, in the same shape the file store reports so
 * GET /api/docs/:id/backups reads identically on both backends.
 *
 * `index` 1 is the snapshot the most recent save REPLACED — the same thing `<id>.bak.1`
 * is on a disk, because `saveSnapshot` keeps the outgoing generation rather than the
 * incoming one. Both stores therefore hold BACKUP_COUNT previous generations, and both
 * report an empty list until a save has actually replaced something.
 *
 * `size` is the byte length of that document as JSON — the closest true equivalent of the
 * file size, and the same bytes the file store would have written, which is why the
 * documents themselves are fetched here. Only BACKUP_COUNT rows are read, and only when
 * somebody asks for the list.
 *
 * The one thing that cannot be identical is what a HOLE in the ring looks like. These
 * indices are positions in the answer and so always run 1..N with no gaps; the file
 * store's are the numbers in the file names, so a `<id>.bak.2` with no `<id>.bak.1`
 * beside it is reported as index 2 — the index there has to name the file a person will
 * open by hand.
 */
export async function listBackups(id) {
  assertDocId(id);
  const rows = rowsOf(
    await request('GET', T_BACKUPS, {
      query: {
        select: 'seq,at,doc',
        doc_id: `eq.${id}`,
        order: 'seq.desc',
        limit: String(BACKUP_COUNT),
      },
    }),
    `${T_BACKUPS} 목록 (${id})`,
  );
  const backups = [];
  rows.forEach((row, i) => {
    const index = i + 1;
    let size = 0;
    try {
      size = Buffer.byteLength(JSON.stringify((row && row.doc) ?? null), 'utf8');
    } catch {
      // Only the reported SIZE is lost here, never the backup: this list is what
      // GET /api/docs/:id/backups shows, and a 0 next to a copy that exists is a cosmetic
      // wrong number, not a missing row.
      size = 0;
    }
    const at = Number(row && row.at);
    backups.push({
      index,
      name: `${id}.bak.${index}`,
      at: Number.isFinite(at) ? at : 0,
      size,
    });
  });
  return backups;
}

// ---------------------------------------------------------------------------
// loading
// ---------------------------------------------------------------------------

/**
 * Every document id the database holds something for — a snapshot, journal rows, or only
 * backups.
 *
 * A journal with no snapshot is a real state (a crash before the first compaction) and it
 * must still load, exactly as it does from data/. So is a document with nothing left but
 * its backups: `storage/fileStore.js` finds those ids from `<id>.bak.N` on purpose, and
 * `loadDoc` below really does recover such a document from its newest backup row. Walking
 * only the first two tables was not an optimisation — it made those documents invisible on
 * this backend and only on this backend: never listed, never loaded, never served, and
 * their rows unreachable by any operation the interface offers.
 *
 * A list that could not be read REJECTS, carrying the UNREAD code (SPEC 29.1), because boot
 * ACTS on an empty one: it loads nothing and mints a starter document. A database that is
 * merely unreachable would make every document invisible at once and invite new ones on top
 * of them, which is the empty-journal lie at a larger scale. No row is a fact and stays one.
 *
 * It quarantines no document, and that is not an omission. This call names none — the very
 * thing that failed is finding out which ids exist — so there is nothing to quarantine, and
 * inventing a process-wide refusal here would be a different behaviour from the file store,
 * where the same failure simply stops the boot. The rejection is what stops it.
 */
export async function listDocIds() {
  try {
    return await listStoredDocIds();
  } catch (err) {
    if (err && err.code === UNREAD_CODE) throw err;
    const detail = redact(err && err.message ? err.message : String(err));
    const failure = new Error(
      `문서 목록을 읽지 못했습니다 (${detail}). 문서가 없는 것인지 못 읽은 것인지 알 수 없어 중단합니다.`,
    );
    failure.code = UNREAD_CODE;
    failure.cause = err;
    throw failure;
  }
}

async function listStoredDocIds() {
  const ids = new Set();

  // Both loops end on an empty page and on nothing else. A document missing from this list
  // is never loaded, never replayed and never served — and the request that would create
  // it again at the same id would write over what is still in the database. So a walk that
  // cannot prove it reached the end throws, and boot stops.
  let cursor = null;
  const seenCursors = new Set();
  for (let page = 0; ; page++) {
    if (page >= MAX_PAGES) {
      throw new Error(`${T_DOCS}: 문서 목록이 ${MAX_PAGES}쪽을 넘어 끝나지 않았습니다.`);
    }
    const query = { select: 'id', order: 'id.asc', limit: String(PAGE_SIZE) };
    if (cursor !== null) query.id = `gt.${cursor}`;
    const rows = rowsOf(await request('GET', T_DOCS, { query }), `${T_DOCS} 목록`);
    if (!rows.length) break;
    for (const row of rows) {
      if (row && typeof row.id === 'string') addDocId(ids, row.id, T_DOCS);
    }
    // The server's own last row is the cursor, not the greatest id this process would pick
    // out of the page: `id` is text, and text ordering in Postgres is a collation, not
    // JavaScript's comparison. Stepping past a row Postgres would still have sent is how a
    // document goes missing, so the ordering is left entirely to the side that applied it.
    const lastRow = rows[rows.length - 1];
    const next = lastRow && typeof lastRow.id === 'string' ? lastRow.id : null;
    if (next === null || next === cursor || seenCursors.has(next)) {
      throw new Error(`${T_DOCS}: 문서 목록 페이지가 진행되지 않았습니다. 목록을 끝까지 읽지 못했습니다.`);
    }
    seenCursors.add(next);
    cursor = next;
  }

  let seqCursor = 0;
  for (let page = 0; ; page++) {
    if (page >= MAX_PAGES) {
      throw new Error(`${T_JOURNAL}: 문서 id 목록이 ${MAX_PAGES}쪽을 넘어 끝나지 않았습니다.`);
    }
    const query = { select: 'seq,doc_id', order: 'seq.asc', limit: String(PAGE_SIZE) };
    if (seqCursor > 0) query.seq = `gt.${seqCursor}`;
    const rows = rowsOf(await request('GET', T_JOURNAL, { query }), `${T_JOURNAL} 문서 id 목록`);
    if (!rows.length) break;
    for (const row of rows) {
      if (row && typeof row.doc_id === 'string') addDocId(ids, row.doc_id, T_JOURNAL);
    }
    const lastSeq = Number(rows[rows.length - 1] && rows[rows.length - 1].seq);
    if (!Number.isFinite(lastSeq) || lastSeq <= seqCursor) {
      throw new Error(`${T_JOURNAL}: 문서 id 목록 페이지가 seq 순서대로 오지 않았습니다 (기준 ${seqCursor}).`);
    }
    seqCursor = lastSeq;
  }

  // The third walk, and the one that keeps the two backends finding the same documents.
  // A document whose sz_documents row is gone but whose sz_backups rows survive is exactly
  // the file store's <id>.bak.N with no <id>.json: loadDoc recovers it from the newest
  // backup, so leaving it out of this list would hide a recoverable document rather than
  // report a missing one. It ends on an empty page and on nothing else, for the same reason
  // the two walks above do.
  let backupCursor = 0;
  for (let page = 0; ; page++) {
    if (page >= MAX_PAGES) {
      throw new Error(`${T_BACKUPS}: 문서 id 목록이 ${MAX_PAGES}쪽을 넘어 끝나지 않았습니다.`);
    }
    const query = { select: 'seq,doc_id', order: 'seq.asc', limit: String(PAGE_SIZE) };
    if (backupCursor > 0) query.seq = `gt.${backupCursor}`;
    const rows = rowsOf(await request('GET', T_BACKUPS, { query }), `${T_BACKUPS} 문서 id 목록`);
    if (!rows.length) break;
    for (const row of rows) {
      if (row && typeof row.doc_id === 'string') addDocId(ids, row.doc_id, T_BACKUPS);
    }
    const lastSeq = Number(rows[rows.length - 1] && rows[rows.length - 1].seq);
    if (!Number.isFinite(lastSeq) || lastSeq <= backupCursor) {
      throw new Error(`${T_BACKUPS}: 문서 id 목록 페이지가 seq 순서대로 오지 않았습니다 (기준 ${backupCursor}).`);
    }
    backupCursor = lastSeq;
  }

  return [...ids];
}

function addDocId(ids, id, table) {
  if (!DOC_ID_RE.test(id)) {
    console.warn(`[시트지] 문서 id 형식이 올바르지 않아 건너뜁니다 (${table}): ${String(id).slice(0, 40)}`);
    return;
  }
  ids.add(id);
}

/**
 * The newest readable snapshot for a document: its sz_documents row, else the newest
 * sz_backups row that can be read (SPEC 27.2). Returns `{ doc, fromBackup, raw }`, or null
 * when nothing readable exists.
 *
 * `raw` is the stored document BEFORE sanitizeDoc migrated it in memory, which is how the
 * caller tells that what is stored is an older document shape and has to be rewritten once
 * (SPEC 10, legacy migration).
 *
 * A read that fails REJECTS and quarantines the document (SPEC 27.6), and that covers the
 * backup query as well as the document one: stepping over a copy this process could not
 * read, on to an older one, is the silent rollback the file store's scan stops dead for —
 * the caller sees `fromBackup`, rewrites, and the newer copy is gone. `null` stays reserved
 * for the one honest answer: every query succeeded and there is nothing usable stored.
 */
export async function loadDoc(id) {
  assertDocId(id);
  assertReadable(id);
  try {
    return await loadStoredDoc(id);
  } catch (err) {
    throw markUnread(id, '문서 내용', err);
  }
}

async function loadStoredDoc(id) {
  const rows = rowsOf(
    await request('GET', T_DOCS, {
      query: { select: 'doc', id: `eq.${id}`, limit: '1' },
    }),
    `${T_DOCS} 읽기 (${id})`,
  );
  const current = rows.length && rows[0] ? rows[0].doc : null;
  const restored = toDoc(id, current, `${T_DOCS} 행`);
  if (restored) return { doc: restored.doc, fromBackup: false, raw: restored.raw };

  const backups = rowsOf(
    await request('GET', T_BACKUPS, {
      query: {
        select: 'doc',
        doc_id: `eq.${id}`,
        order: 'seq.desc',
        limit: String(BACKUP_COUNT),
      },
    }),
    `${T_BACKUPS} 읽기 (${id})`,
  );
  for (let i = 0; i < backups.length; i++) {
    const fromBackup = toDoc(id, backups[i] && backups[i].doc, `백업 ${i + 1}번`);
    if (fromBackup) {
      console.warn(`[시트지] ${id}: 스냅숏 대신 백업 ${i + 1}번을 사용합니다.`);
      return { doc: fromBackup.doc, fromBackup: true, raw: fromBackup.raw };
    }
  }
  return null;
}

// One stored jsonb value into a live document. A row that cannot be sanitised is skipped
// with a warning rather than throwing, so one corrupt copy falls through to the next.
function toDoc(id, stored, what) {
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return null;
  try {
    // sanitizeDoc is where v1 -> v2 migration happens, and it is idempotent.
    const doc = sanitizeDoc(stored);
    doc.id = id; // the row's id is authoritative
    return { doc, raw: stored };
  } catch (err) {
    console.warn(`[시트지] 손상된 문서를 건너뜁니다 (${id}, ${what}): ${redact(err && err.message)}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// deletion
// ---------------------------------------------------------------------------

/**
 * Everything this document owned: its journal, its backups and its snapshot.
 *
 * The journal goes FIRST and the snapshot LAST, and the order is not cosmetic. Journal
 * rows left behind after the document row is gone would be replayed on the next boot and
 * bring the deleted document back — the opposite of what DELETE promised. Failing partway
 * therefore leaves a document that still exists, which is recoverable, rather than one
 * that comes back from the dead.
 *
 * It REJECTS for a quarantined document (SPEC 27.6). Deleting is the most final thing here,
 * and a document nobody has been able to read is the one nobody can judge: the person
 * asking may well be asking BECAUSE it looked broken. A restart makes it readable again, or
 * proves it is not; either way the decision is then made with the contents in view.
 */
export async function deleteDoc(id) {
  assertDocId(id);
  // An early-out matching the file store's, so a document already quarantined is refused
  // without queuing anything. SPEC 29.1 promises the two backends behave identically
  // through storage/index.js, and that includes when the refusal happens.
  assertReadable(id);
  await queue(id, async () => {
    assertReadable(id); // still only an early-out; the gate refuses each statement
    await request('DELETE', T_JOURNAL, {
      docId: id,
      query: { doc_id: `eq.${id}` },
      prefer: 'return=minimal',
    });
    await request('DELETE', T_BACKUPS, {
      docId: id,
      query: { doc_id: `eq.${id}` },
      prefer: 'return=minimal',
    });
    await request('DELETE', T_DOCS, {
      docId: id,
      query: { id: `eq.${id}` },
      prefer: 'return=minimal',
    });
    snapshotSeq.delete(id);
  });
  // The chain entry itself is kept. Dropping it would let a later operation for the same
  // id start on a fresh chain and overlap with one already queued behind this delete,
  // and an empty promise costs nothing next to that.
}
