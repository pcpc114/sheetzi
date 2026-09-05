#!/usr/bin/env node
/**
 * Access-control harness (SPEC section 28).
 *
 * Everything here is written from the attacker's side: it boots the real server
 * with the gate ON and then tries to get in WITHOUT the password, every way there
 * is — plain pages, the API, the static assets, the document JSON, the CSV export
 * and, above all, the WebSocket.
 *
 * The WebSocket is the case this file exists for. `/ws` can read and write every
 * document in the system, so a gate that covers the HTTP routes and leaves the
 * upgrade handshake open is not a gate at all. It is checked with no cookie, with
 * a malformed cookie, with an expired payload, with a payload whose signature was
 * flipped by one byte, and with a correctly signed payload carrying the wrong
 * token version — each of which must be refused before the handshake completes.
 *
 * The second half boots the server again with no SZ_PASSWORD and proves the gate
 * is OFF: pages load, the API answers, the WebSocket connects and the boot log
 * says so in plain language. That is the default for someone running this on their
 * own laptop, and it is what the other harnesses (smoke, crash, browser) rely on.
 *
 * Usage: node tools/auth.mjs
 * Prints PASS/FAIL per case and exits non-zero on any failure.
 */
import { mkdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHmac } from 'node:crypto';
import { WebSocket } from 'ws';
import { harnessEnv, spawnServer } from './harness-env.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// Two ports so the locked server and the open one can be booted one after the
// other without waiting for a socket to drain. They sit clear of the ports the
// other harnesses use (39517 smoke, 39531 crash, 39621/39622 browser).
const LOCKED_PORT = Number(process.env.AUTH_PORT || 39641);
const OPEN_PORT = Number(process.env.AUTH_OPEN_PORT || 39643);
// A third server, booted with a session lifetime measured in seconds, so the expiry of
// an OPEN socket can be observed rather than assumed.
const EXPIRE_PORT = Number(process.env.AUTH_EXPIRE_PORT || 39645);

// A password with a space and Hangul in it: the round trip through the environment,
// JSON and scrypt has to survive more than [a-z]. It is a test fixture and is never
// printed — the log scan at the end proves the server never printed it either.
const PASSWORD = '열려라 참깨 42!';
const WRONG_PASSWORD = '열려라 참깨 43!';
// Fixed so this file can mint and tamper with its own tokens.
const SECRET = 'auth-harness-fixed-session-secret-do-not-use-in-production';
const COOKIE_NAME = 'sz_session';
const SESSION_DAYS_DEFAULT = 14;
const MAX_LOGIN_ATTEMPTS = 10;
// Planted in a cell so a leak through an unauthenticated route is visible as a
// string rather than as a subtle shape difference.
const MARKER = 'AUTHMARKER9137비밀';

const HTML_ACCEPT = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8';

let passed = 0;
const failures = [];
const servers = [];

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

function section(title) {
  console.log(`\n${title}`);
}

/** An observation worth seeing on a green run, but not itself a pass/fail. */
function note(text) {
  console.log(`    · ${text}`);
}

// ---------------------------------------------------------------- server boot

/**
 * Boot server.js on `port` with exactly the given auth variables.
 *
 * The four SZ_* variables are always written explicitly (empty when they should be
 * absent) so a value in the operator's own environment can never change what this
 * harness is testing.
 */
function startServer({ port, label, password = '', secret = '', days = '' }) {
  // Every guarded variable is written explicitly by harnessEnv — empty where this case
  // wants it absent, which is what "not configured" means to server.js. Deleting the key
  // instead would be worse than useless now that server.js reads .env at startup: an
  // absent variable is exactly the one the operator's file gets to fill in, so a machine
  // with SZ_PASSWORD in .env would silently test a gate that is on when this case needs
  // it off. The same helper blanks SUPABASE_URL, so a suite that creates and deletes
  // documents can never reach the operator's real project.
  const proc = spawnServer({
    env: harnessEnv({
      PORT: String(port),
      SZ_PASSWORD: password,
      SZ_PASSWORD_HASH: '',
      SZ_SESSION_SECRET: secret,
      SZ_SESSION_DAYS: days,
    }, { label }),
    label,
  });
  const log = [];
  proc.stdout.on('data', (d) => log.push(d.toString()));
  proc.stderr.on('data', (d) => log.push(d.toString()));
  proc.on('exit', (code, sig) => {
    if (code !== 0 && code !== null) log.push(`\n[server exited code=${code} signal=${sig}]\n`);
  });

  const entry = {
    label,
    proc,
    log,
    port,
    base: `http://127.0.0.1:${port}`,
    wsUrl: `ws://127.0.0.1:${port}/ws`,
    text: () => log.join(''),
  };
  servers.push(entry);
  return entry;
}

async function waitForServer(srv, timeoutMs = 25000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${srv.base}/healthz`, { signal: AbortSignal.timeout(1000) });
      if (r.ok) return true;
    } catch { /* not up yet */ }
    if (srv.proc.exitCode !== null) {
      throw new Error(`${srv.label}: server exited early (code ${srv.proc.exitCode})\n${srv.text()}`);
    }
    await sleep(150);
  }
  throw new Error(`${srv.label}: server did not become healthy within ${timeoutMs}ms\n${srv.text()}`);
}

function stopServer(srv) {
  try {
    if (srv.proc.exitCode === null) srv.proc.kill();
  } catch { /* already gone */ }
}

// ----------------------------------------------------------------- http calls

/**
 * One HTTP request, with redirects left unfollowed so a 302 can be inspected.
 *
 * `html: true` sends a browser's Accept header, which is what tells the gate a
 * navigation from a redirect-able page apart from an API call.
 */
async function http(srv, path, opts = {}) {
  const headers = { ...(opts.headers || {}) };
  if (opts.cookie) headers.Cookie = opts.cookie;
  if (opts.html) headers.Accept = HTML_ACCEPT;
  let body;
  if (opts.json !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(opts.json);
  } else if (opts.body !== undefined) {
    body = opts.body;
  }
  const res = await fetch(`${srv.base}${path}`, {
    method: opts.method || 'GET',
    headers,
    body,
    redirect: 'manual',
    signal: AbortSignal.timeout(opts.timeout || 15000),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON; text is enough */ }
  const setCookie = typeof res.headers.getSetCookie === 'function'
    ? res.headers.getSetCookie()
    : (res.headers.get('set-cookie') ? [res.headers.get('set-cookie')] : []);
  return {
    status: res.status,
    headers: res.headers,
    location: res.headers.get('location') || '',
    retryAfter: res.headers.get('retry-after') || '',
    text,
    json,
    setCookie,
  };
}

/** The `sz_session=<value>` Set-Cookie line from a response, or ''. */
function sessionSetCookie(res) {
  return res.setCookie.find((c) => c.startsWith(`${COOKIE_NAME}=`)) || '';
}

/** Turn a Set-Cookie line into the Cookie header a browser would send back. */
function cookieHeaderFrom(setCookieLine) {
  if (!setCookieLine) return '';
  const first = setCookieLine.split(';')[0].trim();
  return first;
}

/** The token inside a `sz_session=...` cookie header. */
function tokenOf(cookieHeader) {
  const eq = cookieHeader.indexOf('=');
  return eq === -1 ? '' : cookieHeader.slice(eq + 1);
}

// --------------------------------------------------------------- token forging

const secretBuf = Buffer.from(SECRET, 'utf8');

function signPayload(payloadObj) {
  const payload = Buffer.from(JSON.stringify(payloadObj), 'utf8').toString('base64url');
  const sig = createHmac('sha256', secretBuf).update(payload, 'utf8').digest('base64url');
  return `${payload}.${sig}`;
}

function payloadOf(token) {
  const dot = token.indexOf('.');
  if (dot <= 0) return null;
  try {
    return JSON.parse(Buffer.from(token.slice(0, dot), 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

/** Flip one byte of the signature, leaving the payload untouched. */
function flipSignatureByte(token) {
  const dot = token.indexOf('.');
  const payload = token.slice(0, dot);
  const sig = Buffer.from(token.slice(dot + 1), 'base64url');
  sig[0] ^= 0x01;
  return `${payload}.${sig.toString('base64url')}`;
}

// ------------------------------------------------------------------ websocket

/**
 * Attempt one WebSocket upgrade and report what happened, without ever throwing.
 *
 * `open:false` is a refusal however it arrived: an HTTP status line (which ws
 * surfaces as `unexpected-response`), a socket the server destroyed, or a hang
 * that ran out the clock. The status and reason are reported so a green run still
 * shows HOW the door was shut.
 */
function wsAttempt(srv, cookie, { timeout = 8000 } = {}) {
  return new Promise((resolveOne) => {
    const started = Date.now();
    let ws = null;
    let settled = false;
    const done = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      result.ms = Date.now() - started;
      try {
        if (ws) {
          if (result.open) ws.close();
          else ws.terminate();
        }
      } catch { /* nothing left to close */ }
      resolveOne(result);
    };
    const timer = setTimeout(() => done({ open: false, reason: 'timed out with no answer' }), timeout);
    try {
      ws = new WebSocket(srv.wsUrl, cookie ? { headers: { Cookie: cookie } } : {});
    } catch (err) {
      done({ open: false, reason: `threw: ${err && err.message}` });
      return;
    }
    ws.on('open', () => done({ open: true, reason: 'handshake completed' }));
    ws.on('unexpected-response', (_req, res) => {
      done({ open: false, status: res.statusCode, reason: `HTTP ${res.statusCode}` });
    });
    ws.on('error', (err) => done({ open: false, reason: (err && err.message) || String(err) }));
    ws.on('close', () => done({ open: false, reason: 'closed before opening' }));
  });
}

/** A WebSocket client that records frames, modelled on the one in smoke.mjs. */
class Client {
  constructor(srv, name, cookie = '') {
    this.srv = srv;
    this.name = name;
    this.cookie = cookie;
    this.frames = [];
    this.ws = null;
  }
  async open() {
    this.ws = new WebSocket(this.srv.wsUrl, this.cookie ? { headers: { Cookie: this.cookie } } : {});
    this.ws.on('message', (buf) => {
      let msg;
      try { msg = JSON.parse(buf.toString()); } catch { msg = { t: '<unparseable>' }; }
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
  async await(pred, { timeout = 5000, label = 'frame' } = {}) {
    const deadline = Date.now() + timeout;
    let i = 0;
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

// ---------------------------------------------------------------------- exit

function finish() {
  for (const srv of servers) stopServer(srv);
  console.log('');
  if (failures.length === 0) {
    console.log(`auth: OK — ${passed} checks passed.`);
    process.exit(0);
  }
  console.log(`auth: ${failures.length} FAILED (${passed} passed)\n`);
  for (const f of failures) console.log(`  - ${f}`);
  for (const srv of servers) {
    const text = srv.text();
    if (!text) continue;
    console.log(`\n--- ${srv.label} server output ---`);
    console.log(text.slice(-3000));
  }
  process.exit(1);
}

// ===========================================================================

if (!existsSync(join(ROOT, 'server.js'))) {
  console.error('auth: server.js does not exist yet');
  process.exit(2);
}
await mkdir(join(ROOT, 'data'), { recursive: true });

let docId = null;
let goodCookie = '';
const locked = startServer({
  port: LOCKED_PORT,
  label: 'locked',
  password: PASSWORD,
  secret: SECRET,
});

console.log(`auth: booting the locked server on :${LOCKED_PORT}`);

try {
  await waitForServer(locked);

  // ============================================== 1. no cookie, HTTP surface
  section('1. an unauthenticated visitor over HTTP');

  const rootRes = await http(locked, '/', { html: true });
  check('GET / without a cookie redirects', rootRes.status === 302, `status=${rootRes.status}`);
  check('GET / redirects to the login page', rootRes.location.startsWith('/login'), `location=${rootRes.location}`);
  check('GET / does not leak the page body', !rootRes.text.includes('<table') && rootRes.text.length < 1000,
    `${rootRes.text.length} bytes`);

  const editRes = await http(locked, '/edit', { html: true });
  check('GET /edit without a cookie redirects to the login page',
    editRes.status === 302 && editRes.location.startsWith('/login'), `${editRes.status} ${editRes.location}`);

  const editQuery = await http(locked, '/edit?doc=abc123def456', { html: true });
  check('the redirect carries the requested path as next=',
    editQuery.location === `/login?next=${encodeURIComponent('/edit?doc=abc123def456')}`,
    `location=${editQuery.location}`);

  const docsRes = await http(locked, '/api/docs');
  check('GET /api/docs without a cookie is 401', docsRes.status === 401, `status=${docsRes.status}`);
  check('GET /api/docs answers {error:"auth_required"}', docsRes.json?.error === 'auth_required',
    `body=${docsRes.text.slice(0, 120)}`);
  check('GET /api/docs is NOT a redirect', !docsRes.location, `location=${docsRes.location}`);

  // An API call from a page that also accepts HTML must still get the 401: the
  // client has to be able to tell "log in" from "here is a page".
  const docsHtmlAccept = await http(locked, '/api/docs', { html: true });
  check('an API call is 401 even when the request accepts HTML',
    docsHtmlAccept.status === 401 && docsHtmlAccept.json?.error === 'auth_required',
    `status=${docsHtmlAccept.status}`);

  const postDocs = await http(locked, '/api/docs', { method: 'POST', json: { name: '침입' } });
  check('POST /api/docs without a cookie is refused', postDocs.status === 401, `status=${postDocs.status}`);

  const healthRes = await http(locked, '/healthz');
  check('GET /healthz is reachable without a cookie', healthRes.status === 200 && healthRes.json?.ok === true,
    `status=${healthRes.status}`);

  const loginPage = await http(locked, '/login', { html: true });
  check('the login page is reachable without a cookie', loginPage.status === 200, `status=${loginPage.status}`);
  check('the login page is really the login page', /<form|password/i.test(loginPage.text));
  check('the login page never contains the password', !loginPage.text.includes(PASSWORD));

  const loginCss = await http(locked, '/css/style.css');
  check('the CSS the login page needs is reachable', loginCss.status === 200, `status=${loginCss.status}`);
  const loginJs = await http(locked, '/js/login.js');
  check('the JS the login page needs is reachable', loginJs.status === 200, `status=${loginJs.status}`);

  // Everything else static stays behind the gate: the editor is application code
  // and there is no reason to hand it to someone who cannot log in.
  const mainJs = await http(locked, '/js/main.js');
  check('the editor bundle is NOT served without a cookie', mainJs.status === 401 || mainJs.status === 302,
    `status=${mainJs.status}`);
  const sharedJs = await http(locked, '/shared/model.js');
  check('the shared modules are NOT served without a cookie', sharedJs.status === 401 || sharedJs.status === 302,
    `status=${sharedJs.status}`);

  // ================================================ 2. the WebSocket, unauthed
  section('2. the WebSocket without a session (the one that matters)');

  const wsNone = await wsAttempt(locked, '');
  check('a WebSocket with NO cookie is refused', wsNone.open === false, `reason=${wsNone.reason}`);
  note(`no cookie: ${wsNone.reason} after ${wsNone.ms}ms`);
  check('the refusal is immediate, not a hang', wsNone.ms < 5000, `${wsNone.ms}ms`);

  const wsGarbage = await wsAttempt(locked, `${COOKIE_NAME}=not-a-real-token`);
  check('a WebSocket with a malformed cookie is refused', wsGarbage.open === false, `reason=${wsGarbage.reason}`);

  const wsEmpty = await wsAttempt(locked, `${COOKIE_NAME}=`);
  check('a WebSocket with an empty cookie value is refused', wsEmpty.open === false, `reason=${wsEmpty.reason}`);

  const wsDotted = await wsAttempt(locked, `${COOKIE_NAME}=eyJ4IjoxfQ.deadbeef`);
  check('a WebSocket with a well-shaped but unsigned token is refused', wsDotted.open === false,
    `reason=${wsDotted.reason}`);

  // ================================================== 3. logging in properly
  section('3. POST /api/login');

  const badLogin = await http(locked, '/api/login', { method: 'POST', json: { password: WRONG_PASSWORD } });
  check('the wrong password is refused', badLogin.status === 401, `status=${badLogin.status}`);
  check('the wrong password sets no cookie', sessionSetCookie(badLogin) === '',
    `set-cookie=${badLogin.setCookie.join(' | ')}`);
  check('the refusal body never contains the password', !badLogin.text.includes(PASSWORD));
  check('the refusal body never contains the session secret', !badLogin.text.includes(SECRET));

  const noPassword = await http(locked, '/api/login', { method: 'POST', json: {} });
  check('a login with no password field is refused', noPassword.status === 401, `status=${noPassword.status}`);
  check('a missing password is refused exactly like a wrong one',
    noPassword.status === badLogin.status && noPassword.json?.error === badLogin.json?.error,
    `${noPassword.json?.error} vs ${badLogin.json?.error}`);

  const goodLogin = await http(locked, '/api/login', { method: 'POST', json: { password: PASSWORD } });
  check('the right password is accepted', goodLogin.status === 200 && goodLogin.json?.ok === true,
    `status=${goodLogin.status} body=${goodLogin.text.slice(0, 120)}`);

  const setCookieLine = sessionSetCookie(goodLogin);
  check('a session cookie is set', setCookieLine !== '');
  check('the cookie is HttpOnly', /;\s*HttpOnly/i.test(setCookieLine));
  check('the cookie is SameSite=Lax', /;\s*SameSite=Lax/i.test(setCookieLine));
  check('the cookie is scoped to Path=/', /;\s*Path=\//i.test(setCookieLine));
  const maxAge = Number((setCookieLine.match(/;\s*Max-Age=(-?\d+)/i) || [])[1]);
  check('the cookie has a Max-Age of the default 14 days',
    maxAge === SESSION_DAYS_DEFAULT * 24 * 60 * 60, `Max-Age=${maxAge}`);
  // Secure over plain http would make the browser throw the cookie away, so the
  // flag has to follow the scheme rather than be set unconditionally.
  check('the cookie is not marked Secure over plain http', !/;\s*Secure/i.test(setCookieLine));
  check('the cookie value is not the password', !setCookieLine.includes(PASSWORD));
  check('the cookie value is not the session secret', !setCookieLine.includes(SECRET));

  goodCookie = cookieHeaderFrom(setCookieLine);
  const goodToken = tokenOf(goodCookie);
  const goodPayload = payloadOf(goodToken);
  check('the cookie payload is a signed {exp, v} pair',
    !!goodPayload && typeof goodPayload.exp === 'number' && goodPayload.exp > Date.now() && !!goodPayload.v,
    `payload=${JSON.stringify(goodPayload)}`);

  // ================================================ 4. the door, with the key
  section('4. with a valid session');

  const rootIn = await http(locked, '/', { html: true, cookie: goodCookie });
  check('GET / loads with the cookie', rootIn.status === 200 && rootIn.text.includes('<'), `status=${rootIn.status}`);
  const editIn = await http(locked, '/edit', { html: true, cookie: goodCookie });
  check('GET /edit loads with the cookie', editIn.status === 200, `status=${editIn.status}`);
  const docsIn = await http(locked, '/api/docs', { cookie: goodCookie });
  check('GET /api/docs answers with the cookie', docsIn.status === 200 && Array.isArray(docsIn.json),
    `status=${docsIn.status}`);
  const mainIn = await http(locked, '/js/main.js', { cookie: goodCookie });
  check('the editor bundle is served with the cookie', mainIn.status === 200, `status=${mainIn.status}`);
  const versionIn = await http(locked, '/api/version', { cookie: goodCookie });
  check('GET /api/version reports auth:true so the client can show 로그아웃',
    versionIn.status === 200 && versionIn.json?.auth === true, `body=${versionIn.text.slice(0, 120)}`);

  const created = await http(locked, '/api/docs', { method: 'POST', cookie: goodCookie, json: { name: '인증 시험' } });
  check('POST /api/docs creates a document with the cookie', created.status === 200 || created.status === 201,
    `status=${created.status}`);
  docId = created.json?.id || null;
  check('the created document has an id', typeof docId === 'string' && docId.length >= 6, `id=${docId}`);

  const sheetId = created.json?.sheets?.[0]?.id;
  const wsGood = await wsAttempt(locked, goodCookie);
  check('a WebSocket WITH the cookie connects', wsGood.open === true, `reason=${wsGood.reason}`);
  const client = await new Client(locked, 'A', goodCookie).open();
  client.send({ t: 'hello', docId, name: '가나', color: '#1a73e8' });
  const welcome = await client.await((f) => f.t === 'welcome', { label: 'welcome' });
  check('the authenticated socket receives welcome', !!welcome.doc && welcome.doc.id === docId);
  client.send({ t: 'edit', docId, sheetId, cells: { A1: { input: MARKER } } });
  const echoed = await client.await((f) => f.t === 'edit' && f.cells?.A1?.input === MARKER, { label: 'edit echo' });
  check('the authenticated socket can edit', !!echoed);
  client.close();

  const readBack = await http(locked, `/api/docs/${docId}`, { cookie: goodCookie });
  check('the edit really landed in the document', readBack.json?.sheets?.[0]?.cells?.A1?.input === MARKER,
    `A1=${JSON.stringify(readBack.json?.sheets?.[0]?.cells?.A1)}`);

  // The document now holds a marker string, so an unauthenticated read of it is
  // visible as a leak rather than as a subtle difference in shape.
  const stealDoc = await http(locked, `/api/docs/${docId}`);
  check('the document JSON is not readable without a cookie', stealDoc.status === 401, `status=${stealDoc.status}`);
  check('the document JSON leaks no cell content', !stealDoc.text.includes(MARKER));
  const stealCsv = await http(locked, `/api/docs/${docId}/csv`);
  check('the CSV export is not readable without a cookie', stealCsv.status === 401, `status=${stealCsv.status}`);
  check('the CSV export leaks no cell content', !stealCsv.text.includes(MARKER));

  // =========================================== 5. forged and stale session cookies
  section('5. forged, stale and tampered cookies');

  const expiredToken = signPayload({ exp: Date.now() - 60_000, v: goodPayload.v });
  const expiredCookie = `${COOKIE_NAME}=${expiredToken}`;
  const wsExpired = await wsAttempt(locked, expiredCookie);
  check('a WebSocket with an EXPIRED payload is refused', wsExpired.open === false, `reason=${wsExpired.reason}`);
  const httpExpired = await http(locked, '/api/docs', { cookie: expiredCookie });
  check('the API refuses an expired payload', httpExpired.status === 401, `status=${httpExpired.status}`);

  const tamperedToken = flipSignatureByte(goodToken);
  check('the tampered token really differs from the good one', tamperedToken !== goodToken);
  const tamperedCookie = `${COOKIE_NAME}=${tamperedToken}`;
  const wsTampered = await wsAttempt(locked, tamperedCookie);
  check('a WebSocket with a TAMPERED signature is refused', wsTampered.open === false, `reason=${wsTampered.reason}`);
  const httpTampered = await http(locked, '/api/docs', { cookie: tamperedCookie });
  check('the API refuses a tampered signature', httpTampered.status === 401, `status=${httpTampered.status}`);
  const pageTampered = await http(locked, '/edit', { html: true, cookie: tamperedCookie });
  check('a page request with a tampered signature goes back to the login page',
    pageTampered.status === 302 && pageTampered.location.startsWith('/login'),
    `${pageTampered.status} ${pageTampered.location}`);

  // Correctly signed, unexpired, but minted against a different configuration:
  // the token version is the only revocation a stateless cookie can have, so it
  // has to be checked as strictly as the signature.
  const wrongVersionToken = signPayload({ exp: Date.now() + 3_600_000, v: 'ffffffffffff' });
  const wsWrongVersion = await wsAttempt(locked, `${COOKIE_NAME}=${wrongVersionToken}`);
  check('a WebSocket with a wrong token version is refused', wsWrongVersion.open === false,
    `reason=${wsWrongVersion.reason}`);

  // A payload that is not even JSON, signed correctly: the verifier must not throw.
  const junkPayload = Buffer.from('not json at all', 'utf8').toString('base64url');
  const junkSig = createHmac('sha256', secretBuf).update(junkPayload, 'utf8').digest('base64url');
  const wsJunk = await wsAttempt(locked, `${COOKIE_NAME}=${junkPayload}.${junkSig}`);
  check('a signed but non-JSON payload is refused', wsJunk.open === false, `reason=${wsJunk.reason}`);
  check('the server survived every forged cookie', locked.proc.exitCode === null);

  // ================================================================ 6. next=
  section('6. next= must not become an open redirect');

  const nextSame = await http(locked, '/api/login', {
    method: 'POST', json: { password: PASSWORD, next: '/edit?doc=abc123def456' },
  });
  check('a same-origin path is honoured as next', nextSame.json?.next === '/edit?doc=abc123def456',
    `next=${nextSame.json?.next}`);

  const hostile = [
    ['an absolute URL', 'https://evil.example/steal'],
    ['a scheme-relative URL', '//evil.example/steal'],
    ['a backslash path', '/\\evil.example/steal'],
    ['a backslash-only prefix', '\\\\evil.example'],
    ['a javascript: URL', 'javascript:alert(1)'],
    ['a CRLF-smuggled path', '/edit\r\nLocation: https://evil.example'],
  ];
  for (const [label, value] of hostile) {
    const res = await http(locked, '/api/login', { method: 'POST', json: { password: PASSWORD, next: value } });
    const next = res.json?.next;
    check(`next= refuses ${label}`, next === '/', `next=${JSON.stringify(next)}`);
  }

  // The same rule has to hold on the redirect the gate itself builds, or the
  // login page could be reached with a next= that came from the attacker's link.
  const nextFromGate = await http(locked, '//evil.example/steal', { html: true });
  check('the gate never builds a redirect to another origin',
    !nextFromGate.location || /^\/login(\?|$)/.test(nextFromGate.location),
    `location=${nextFromGate.location}`);
  if (nextFromGate.location) {
    const encoded = nextFromGate.location.split('next=')[1] || '';
    const decoded = decodeURIComponent(encoded);
    check('the next= the gate builds is a same-origin path',
      decoded === '/' || (decoded.startsWith('/') && decoded[1] !== '/' && decoded[1] !== '\\'),
      `next=${decoded}`);
  }

  // ================================================================ 7. logout
  section('7. logout');

  const logout = await http(locked, '/api/logout', { method: 'POST', cookie: goodCookie });
  check('POST /api/logout answers ok', logout.status === 200 && logout.json?.ok === true, `status=${logout.status}`);
  const clearLine = sessionSetCookie(logout);
  check('logout sends a Set-Cookie for the session', clearLine !== '');
  check('logout clears the cookie value', /^sz_session=(;|$)/.test(clearLine.trim()), `set-cookie=${clearLine}`);
  check('logout expires the cookie immediately', /;\s*Max-Age=0\b/i.test(clearLine), `set-cookie=${clearLine}`);
  check('the cleared cookie keeps Path=/ so it replaces the real one',
    /;\s*Path=\//i.test(clearLine), `set-cookie=${clearLine}`);

  // What the browser holds after a logout is the cleared cookie, so that is what
  // gets tried against the socket. (A stateless cookie cannot be revoked at the
  // server; the guarantee logout makes is that the client no longer sends a
  // usable one, and the token version is what invalidates issued cookies.)
  const afterLogout = cookieHeaderFrom(clearLine);
  const wsAfterLogout = await wsAttempt(locked, afterLogout);
  check('the WebSocket is refused again after logout', wsAfterLogout.open === false,
    `reason=${wsAfterLogout.reason}`);
  const httpAfterLogout = await http(locked, '/api/docs', { cookie: afterLogout });
  check('the API is refused again after logout', httpAfterLogout.status === 401, `status=${httpAfterLogout.status}`);

  // ========================================================= 8. rate limiting
  section('8. rate limiting');

  // A successful login clears this address's counter, so the count below starts
  // from a known zero however many failures the sections above produced.
  const reset = await http(locked, '/api/login', { method: 'POST', json: { password: PASSWORD } });
  check('a successful login clears the failure counter', reset.status === 200, `status=${reset.status}`);

  let allRefusedWith401 = true;
  let firstBlockedAt = 0;
  for (let i = 1; i <= MAX_LOGIN_ATTEMPTS; i++) {
    const res = await http(locked, '/api/login', { method: 'POST', json: { password: WRONG_PASSWORD } });
    if (res.status !== 401) {
      allRefusedWith401 = false;
      if (!firstBlockedAt) firstBlockedAt = i;
    }
  }
  check(`the first ${MAX_LOGIN_ATTEMPTS} wrong passwords are plain 401s`, allRefusedWith401,
    `attempt ${firstBlockedAt} was not a 401`);

  const blocked = await http(locked, '/api/login', { method: 'POST', json: { password: WRONG_PASSWORD } });
  check(`attempt ${MAX_LOGIN_ATTEMPTS + 1} is 429`, blocked.status === 429, `status=${blocked.status}`);
  const retryAfter = Number(blocked.retryAfter);
  check('the 429 carries a Retry-After', Number.isInteger(retryAfter) && retryAfter > 0 && retryAfter <= 900,
    `Retry-After=${blocked.retryAfter}`);
  check('the 429 body never contains the password', !blocked.text.includes(PASSWORD));

  // The whole point of the limit: it does not stand aside for a correct guess.
  const blockedCorrect = await http(locked, '/api/login', { method: 'POST', json: { password: PASSWORD } });
  check('the CORRECT password is also refused while the limit is in force',
    blockedCorrect.status === 429, `status=${blockedCorrect.status}`);
  check('the blocked correct password sets no cookie', sessionSetCookie(blockedCorrect) === '',
    `set-cookie=${blockedCorrect.setCookie.join(' | ')}`);

  // Being rate limited must not become a way in through another door.
  const wsWhileBlocked = await wsAttempt(locked, '');
  check('the WebSocket stays shut while an address is rate limited', wsWhileBlocked.open === false,
    `reason=${wsWhileBlocked.reason}`);


// ---------------------------------------------------------------------------
// 8b. a session that expires must end its open socket
// ---------------------------------------------------------------------------
//
// The upgrade is checked once. Without something to retire the socket afterwards, a
// connection opened a minute before the cookie ran out would keep full read and write
// access to every document for as long as the tab stayed open — the session lifetime
// would bound page loads and nothing else.
//
// SZ_SESSION_DAYS is given a tiny fractional value so the cookie expires while this
// test watches, rather than in a fortnight.
{
  const shortLived = startServer({
    port: EXPIRE_PORT,
    label: 'expiring',
    password: PASSWORD,
    secret: SECRET,
    days: String(4 / 86400),   // ~4 seconds, expressed in days
  });
  await waitForServer(shortLived);

  section('8b. an expired session ends the open socket');

  const res = await http(shortLived, '/api/login', {
    method: 'POST',
    body: JSON.stringify({ password: PASSWORD }),
    headers: { 'content-type': 'application/json' },
  });
  const setCookie = sessionSetCookie(res);
  const cookie = setCookie ? cookieHeaderFrom(setCookie) : null;
  check('a short-lived session logs in', !!cookie);

  if (cookie) {
    const first = await wsAttempt(shortLived, cookie);
    check('it connects while the session is valid', first.open, first.reason || '');

    // Reconnect and hold it, so the close can be observed rather than raced.
    const held = new WebSocket(`ws://127.0.0.1:${EXPIRE_PORT}/ws`, { headers: { cookie } });
    const opened = await new Promise((done) => {
      const to = setTimeout(() => done(false), 6000);
      held.once('open', () => { clearTimeout(to); done(true); });
      held.once('error', () => { clearTimeout(to); done(false); });
    });
    check('a held connection opens', opened);

    if (opened) {
      const code = await new Promise((done) => {
        // Past the 4 s expiry plus a heartbeat tick, with room to spare.
        const to = setTimeout(() => done(null), 45000);
        held.once('close', (c) => { clearTimeout(to); done(c); });
      });
      check('the socket is closed once the session expires', code !== null,
        `close code=${code}`);
    }
    try { held.terminate(); } catch { /* already gone */ }

    // The cookie itself is dead, so a fresh upgrade is refused outright.
    const after = await wsAttempt(shortLived, cookie);
    check('a new connection with the expired cookie is refused', !after.open,
      after.reason || 'it opened');
  }

  stopServer(shortLived);
}

  // ============================================================ 9. the log
  section('9. what the server printed');

  const lockedLog = locked.text();
  check('the boot log says the gate is ON',
    /접근 제한이 켜져|access control[^\n]*on/i.test(lockedLog), lockedLog.split('\n')[0] || '');
  check('the log never contains the password', !lockedLog.includes(PASSWORD));
  check('the log never contains the session secret', !lockedLog.includes(SECRET));
  const issuedToken = tokenOf(goodCookie);
  check('the log never contains a session cookie', !issuedToken || !lockedLog.includes(issuedToken));
  check('the log never contains a password hash', !/scrypt\$\d+\$/.test(lockedLog));
} catch (e) {
  failures.push(`locked phase threw: ${e && e.stack ? e.stack.split('\n').slice(0, 4).join(' | ') : e}`);
  console.log(`  ✗ ${failures.at(-1)}`);
} finally {
  if (docId) {
    try { await http(locked, `/api/docs/${docId}`, { method: 'DELETE', cookie: goodCookie }); } catch { /* ignore */ }
    await sleep(200);
    try { await rm(join(ROOT, 'data', `${docId}.json`), { force: true }); } catch { /* ignore */ }
  }
  stopServer(locked);
}

// ===========================================================================
// The gate OFF — the default for a laptop, and what the other harnesses assume.
// ===========================================================================

let openDocId = null;
const open = startServer({ port: OPEN_PORT, label: 'open' });
console.log(`\nauth: booting the open server on :${OPEN_PORT} with no SZ_PASSWORD`);

try {
  await waitForServer(open);

  section('10. with no SZ_PASSWORD the gate is off');

  const rootOpen = await http(open, '/', { html: true });
  check('GET / loads with no cookie', rootOpen.status === 200, `status=${rootOpen.status}`);
  const editOpen = await http(open, '/edit', { html: true });
  check('GET /edit loads with no cookie', editOpen.status === 200, `status=${editOpen.status}`);
  const docsOpen = await http(open, '/api/docs');
  check('GET /api/docs answers with no cookie', docsOpen.status === 200 && Array.isArray(docsOpen.json),
    `status=${docsOpen.status}`);
  const versionOpen = await http(open, '/api/version');
  check('GET /api/version reports auth:false', versionOpen.json?.auth === false,
    `body=${versionOpen.text.slice(0, 120)}`);
  const mainOpen = await http(open, '/js/main.js');
  check('the client modules are served with no cookie', mainOpen.status === 200, `status=${mainOpen.status}`);
  const sharedOpen = await http(open, '/shared/model.js');
  check('the shared modules are served with no cookie', sharedOpen.status === 200, `status=${sharedOpen.status}`);
  const healthOpen = await http(open, '/healthz');
  check('GET /healthz still answers', healthOpen.status === 200, `status=${healthOpen.status}`);
  const loginOpen = await http(open, '/login', { html: true });
  check('the login page is still reachable with the gate off (never a dead link)',
    loginOpen.status === 200, `status=${loginOpen.status}`);

  const createdOpen = await http(open, '/api/docs', { method: 'POST', json: { name: '잠금 없음' } });
  check('POST /api/docs works with no cookie', createdOpen.status === 200 || createdOpen.status === 201,
    `status=${createdOpen.status}`);
  openDocId = createdOpen.json?.id || null;

  const wsOpen = await wsAttempt(open, '');
  check('a WebSocket with no cookie CONNECTS when the gate is off', wsOpen.open === true, `reason=${wsOpen.reason}`);
  const openClient = await new Client(open, 'O').open();
  openClient.send({ t: 'hello', docId: openDocId, name: '나다', color: '#188038' });
  const openWelcome = await openClient.await((f) => f.t === 'welcome', { label: 'welcome' });
  check('the open socket receives welcome', openWelcome.doc?.id === openDocId);
  openClient.send({
    t: 'edit', docId: openDocId, sheetId: createdOpen.json?.sheets?.[0]?.id, cells: { A1: { input: '42' } },
  });
  const openEcho = await openClient.await((f) => f.t === 'edit' && f.cells?.A1?.input === '42', { label: 'edit echo' });
  check('the open socket can edit', !!openEcho);
  openClient.close();

  const openLog = open.text();
  check('the boot log says the gate is OFF, in plain language',
    /접근 제한이 (꺼져|해제)|비밀번호[^\n]*(없|설정되지)|access control[^\n]*off/i.test(openLog),
    openLog.split('\n').slice(0, 3).join(' / '));
  check('the boot log does not claim the gate is on', !/접근 제한이 켜져/.test(openLog));
} catch (e) {
  failures.push(`open phase threw: ${e && e.stack ? e.stack.split('\n').slice(0, 4).join(' | ') : e}`);
  console.log(`  ✗ ${failures.at(-1)}`);
} finally {
  if (openDocId) {
    try { await http(open, `/api/docs/${openDocId}`, { method: 'DELETE' }); } catch { /* ignore */ }
    await sleep(200);
    try { await rm(join(ROOT, 'data', `${openDocId}.json`), { force: true }); } catch { /* ignore */ }
  }
  stopServer(open);
}

finish();
