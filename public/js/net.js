// net.js — WebSocket client for the 시트지 collaborative spreadsheet.
//
// Responsibilities:
//   - keep a socket to /ws alive across drops (fixed backoff ladder 0.5/1/2/4/8 s)
//   - re-send "hello" on every (re)connect so the server can re-seat this client
//   - coalesce rapid cell edits into one frame every 60 ms (later write wins per cell)
//   - throttle cursor frames to 10/s (leading + trailing edge)
//   - report 'connecting' | 'online' | 'offline' | 'unauthorized' through handlers.onStatus
//   - stamp every document-mutating frame with an `opId`, and route the server's
//     {t:'ack', opId, rev} back to handlers.onAck
//
// Wire protocol: see docs/SPEC.md section 11; acknowledgement is section 27.3.
//
// Durability note: the in-memory queue below covers ONE connection. It is not the
// durability story and never was — a closed tab takes it with it. What survives the
// tab is main.js's persisted outbox (SPEC 27.4), which keeps each frame until its
// `opId` is acknowledged and re-sends whatever is still pending after `welcome`.
//
// Access-control note (SPEC 28.3): the gate covers the UPGRADE, not just the HTTP
// routes — /ws can read and write every document in the system, so a gate that stopped
// at the routes would not be a gate at all. A refused upgrade reaches the browser as a
// close event with no open before it; the 401 status line is not readable through the
// WebSocket API. Retrying that for ever would hammer the server and leave the tab
// silently dead, so after MAX_HANDSHAKE_FAILURES consecutive handshakes that never
// opened this client asks the HTTP gate the same question (GET /api/version, which is
// behind the gate). A 401 there means the session is what is missing: the reconnect
// ladder stops and 'unauthorized' is reported, for the host to show as 로그인이 필요합니다
// with a way to the login page. Any other answer — a 200, a 500, an unreachable server —
// is not an authorisation problem and reconnects exactly as it always did, which is what
// keeps a password-less deployment (and the test harnesses, which connect with no
// session at all) on precisely the behaviour they had before.

const EDIT_COALESCE_MS = 60;
const CURSOR_THROTTLE_MS = 100;
const PING_MS = 25000;
const BACKOFF_LADDER = [500, 1000, 2000, 4000, 8000];
const MAX_CELLS_PER_FRAME = 20000; // server-side cap
// The socket refuses anything over 256 KB by closing, not by answering, so stay well
// under it: room for the envelope plus a margin for UTF-8 bytes that a JS string length
// does not count.
const MAX_FRAME_BODY_BYTES = 160 * 1024;
const FRAME_OVERHEAD_BYTES = 512;
const MAX_QUEUE = 200;
// SPEC 28.3 — the gate's answer, asked over HTTP because the socket cannot report it.
// This path sits behind the gate and answers 401 {error:'auth_required'} without a
// session, so its status alone separates "no session" from "no server".
const AUTH_PROBE_PATH = '/api/version';
// "A couple of immediate failures": one handshake that never opened is ordinary — a
// restart, a proxy hiccup, a sleeping laptop — while two in a row is worth one cheap
// HTTP question before the ladder is allowed to run on for ever.
const MAX_HANDSHAKE_FAILURES = 2;

// Frame types that must always carry the document id.
const DOC_SCOPED = new Set(['hello', 'edit', 'struct', 'meta', 'cursor']);

// Frame types that mutate the document. Every one of them carries an `opId` (SPEC 27.3):
// the server answers with {t:'ack', opId, rev} once that operation's journal line has
// reached the operating system, which is what lets the sender hold the frame until it is
// genuinely safe. Frames that change nothing durable — hello, cursor, ping — carry none.
const MUTATING = new Set(['edit', 'struct', 'meta', 'docmeta', 'sheet', 'comment']);

// opIds are opaque to the server, so they only have to be unique within this tab's
// lifetime and short enough not to bloat every frame (the server caps them at 64 chars).
// Time + counter + randomness: the counter separates two frames sent in the same
// millisecond, and the random tail separates two tabs started in the same one.
let opSeq = 0;

function newOpId() {
  opSeq = (opSeq + 1) % 0xffffff;
  return 'o' + Date.now().toString(36) + opSeq.toString(36) + Math.random().toString(36).slice(2, 6);
}

/**
 * Attach non-enumerable aliases of every message field onto the payload object
 * handed to a handler, so both calling conventions resolve:
 *
 *   onEdit(cells) -> Object.entries(payload) yields the cell entries
 *   onEdit(msg)   -> payload.cells / payload.rev / payload.by still resolve
 *
 * The aliases are non-enumerable, so JSON.stringify / for..in / spread of the
 * payload behave exactly as they would without them.
 */
function withAliases(payload, msg, selfKey) {
  if (!payload || typeof payload !== 'object') return msg;
  const define = (key, value) => {
    if (Object.prototype.hasOwnProperty.call(payload, key)) return;
    try {
      Object.defineProperty(payload, key, {
        value, enumerable: false, configurable: true, writable: true,
      });
    } catch (e) { /* frozen payload: aliases are a convenience, never required */ }
  };
  for (const key of Object.keys(msg)) {
    if (key === selfKey) continue;
    define(key, msg[key]);
  }
  define(selfKey, payload);
  return payload;
}

export class Net {
  /**
   * @param {{docId:string, name?:string, color?:string, handlers?:object}} options
   *   handlers: { onWelcome, onEdit, onStruct, onMeta, onSheets, onDocMeta,
   *               onPeers, onCursor, onStatus, onAck?, onError? }
   */
  constructor({ docId, name, color, handlers } = {}) {
    this.docId = docId;
    this.name = name || '익명';
    this.color = color || '#1a73e8';
    this.handlers = handlers || {};

    /** @type {WebSocket|null} */
    this.ws = null;
    /** @type {'connecting'|'online'|'offline'|'unauthorized'} */
    this.status = 'offline';
    this.closed = false;

    this._attempt = 0; // index into BACKOFF_LADDER
    this._reconnectTimer = null;
    this._pingTimer = null;

    this._editBuf = Object.create(null);
    this._editTimer = null;

    this._cursorPending = null;
    this._cursorTimer = null;
    this._cursorLast = 0;

    /** @type {object[]} frames buffered while the socket is down */
    this._queue = [];

    /** Consecutive sockets that closed WITHOUT ever opening (SPEC 28.3). */
    this._handshakeFails = 0;
    /** True while the gate probe is in flight, so only ever one runs. */
    this._probing = false;
    /**
     * The gate refused this client. The reconnect ladder stops here, because the thing
     * that is missing is a session and no amount of retrying produces one. It is
     * cleared by loading the page again after a successful login, which is the only
     * event that can actually change the answer.
     */
    this.authBlocked = false;
  }

  // --------------------------------------------------------------- lifecycle

  connect() {
    if (this.closed) return;
    // No session: another handshake would be refused exactly like the last two.
    if (this.authBlocked) return;
    if (this.ws && (this.ws.readyState === 0 || this.ws.readyState === 1)) return;
    this._clearTimer('_reconnectTimer');
    this._setStatus('connecting');

    let ws;
    try {
      ws = new WebSocket(this._url());
    } catch (e) {
      this._scheduleReconnect();
      return;
    }
    this.ws = ws;
    // Did THIS socket ever complete its handshake? A refused upgrade closes without
    // opening, and that is the only signal the WebSocket API gives us to act on.
    let opened = false;

    ws.onopen = () => {
      if (this.ws !== ws) return;
      opened = true;
      this._attempt = 0;
      this._handshakeFails = 0;
      this._setStatus('online');
      // The server seats us only after "hello"; it leads every (re)connection.
      this._raw({ t: 'hello', docId: this.docId, name: this.name, color: this.color });
      this._flushQueue();
      this._startPing();
    };

    ws.onmessage = (ev) => {
      if (this.ws !== ws) return;
      let msg;
      try {
        msg = JSON.parse(typeof ev.data === 'string' ? ev.data : '');
      } catch (e) {
        return; // ignore unparseable frames rather than tearing the socket down
      }
      if (!msg || typeof msg !== 'object') return;
      this._dispatch(msg);
    };

    ws.onerror = () => { /* onclose always follows; reconnect is handled there */ };

    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this._stopPing();
      this._setStatus('offline');
      if (opened) {
        // A socket that lived and then dropped is an ordinary disconnection.
        this._handshakeFails = 0;
        this._scheduleReconnect();
        return;
      }
      // It never opened: either the upgrade was refused (SPEC 28.3) or nothing was
      // listening. Those look identical here, so after a couple of them we ask.
      this._handshakeFails += 1;
      if (this._handshakeFails >= MAX_HANDSHAKE_FAILURES) {
        this._checkGate();   // schedules the reconnect itself unless the gate refused us
        return;
      }
      this._scheduleReconnect();
    };
  }

  close() {
    this.closed = true;
    this.flush(); // best effort: push buffered edits before leaving
    this._clearTimer('_reconnectTimer');
    this._clearTimer('_editTimer');
    this._clearTimer('_cursorTimer');
    this._stopPing();
    this._cursorPending = null;
    this._queue.length = 0;
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      ws.onopen = null;
      ws.onmessage = null;
      ws.onerror = null;
      ws.onclose = null;
      try { ws.close(); } catch (e) { /* already gone */ }
    }
    this._setStatus('offline');
  }

  // ----------------------------------------------------------------- sending

  /**
   * Send a frame now, or queue it until the socket is back.
   *
   * A document-mutating frame is stamped with an `opId` here unless it already carries
   * one — main.js's outbox mints its own, so that the id it persisted and the id on the
   * wire are the same string and the ack it gets back matches the frame it is holding.
   * The stamp happens BEFORE queueing, so a frame replayed from the queue after a
   * reconnect carries the same id it was first sent with.
   */
  send(msg) {
    if (!msg || typeof msg !== 'object') return;
    const needsDoc = DOC_SCOPED.has(msg.t) && msg.docId === undefined;
    const needsOp = MUTATING.has(msg.t) && !(typeof msg.opId === 'string' && msg.opId);
    if (needsDoc || needsOp) {
      msg = { ...msg };
      if (needsDoc) msg.docId = this.docId;
      if (needsOp) msg.opId = newOpId();
    }
    if (this._isOpen()) { this._raw(msg); return; }
    if (this.closed) return;
    if (msg.t === 'ping' || msg.t === 'cursor') return; // pointless once stale
    this._queue.push(msg);
    if (this._queue.length > MAX_QUEUE) this._queue.splice(0, this._queue.length - MAX_QUEUE);
  }

  /**
   * Buffer a cells patch and flush it as a single "edit" frame after 60 ms.
   * Patches merge per cell key with later writes winning; a null entry
   * (delete the cell) replaces whatever was buffered for that key.
   */
  sendEdit(cells) {
    if (!cells || typeof cells !== 'object') return;
    for (const key of Object.keys(cells)) {
      const next = cells[key];
      if (next === null || next === undefined) {
        this._editBuf[key] = null;
        continue;
      }
      if (typeof next !== 'object') continue;
      const prev = this._editBuf[key];
      this._editBuf[key] = (prev && typeof prev === 'object')
        ? { ...prev, ...next }
        : { ...next };
    }
    if (this._editTimer !== null) return;
    this._editTimer = setTimeout(() => {
      this._editTimer = null;
      this._flushEdits();
    }, EDIT_COALESCE_MS);
  }

  /** Send the selection, at most once per 100 ms (leading + trailing edge). */
  sendCursor(sel) {
    if (!sel) return;
    this._cursorPending = sel;
    const now = Date.now();
    const waited = now - this._cursorLast;
    if (waited >= CURSOR_THROTTLE_MS) {
      this._flushCursor();
      return;
    }
    if (this._cursorTimer !== null) return;
    this._cursorTimer = setTimeout(() => {
      this._cursorTimer = null;
      this._flushCursor();
    }, CURSOR_THROTTLE_MS - waited);
  }

  /**
   * Is the socket up right now?
   *
   * Public because the difference between "sent" and "queued" matters to a caller that
   * has its own durable copy of the frame: it must not hand a frame to the queue that
   * it is also going to replay itself, or a non-idempotent operation (adding a sheet,
   * posting a comment) would happen twice.
   */
  isOpen() {
    return this._isOpen();
  }

  /** Push any buffered edit/cursor frames immediately. */
  flush() {
    this._clearTimer('_editTimer');
    this._clearTimer('_cursorTimer');
    this._flushEdits();
    if (this._cursorPending) this._flushCursor();
  }

  // --------------------------------------------------------------- internals

  _url() {
    const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
    return scheme + '://' + location.host + '/ws';
  }

  _isOpen() {
    return !!this.ws && this.ws.readyState === 1;
  }

  _raw(msg) {
    if (!this._isOpen()) return false;
    try {
      this.ws.send(JSON.stringify(msg));
      return true;
    } catch (e) {
      return false;
    }
  }

  _flushEdits() {
    const keys = Object.keys(this._editBuf);
    if (keys.length === 0) return;
    const buf = this._editBuf;
    this._editBuf = Object.create(null);
    // Two caps, not one. The cell cap is answered with an error frame; the BYTE cap is
    // answered by the WebSocket layer CLOSING the socket before any handler runs, so an
    // oversized frame produces no reply at all and would be retried for ever.
    let chunk = {};
    let count = 0;
    let bytes = FRAME_OVERHEAD_BYTES;
    for (const key of keys) {
      let size;
      try { size = JSON.stringify(buf[key]).length + key.length + 4; }
      catch (e) { size = MAX_FRAME_BODY_BYTES; }
      if (count > 0 && (count >= MAX_CELLS_PER_FRAME || bytes + size > MAX_FRAME_BODY_BYTES)) {
        this.send({ t: 'edit', docId: this.docId, cells: chunk });
        chunk = {};
        count = 0;
        bytes = FRAME_OVERHEAD_BYTES;
      }
      chunk[key] = buf[key];
      count += 1;
      bytes += size;
    }
    if (count > 0) this.send({ t: 'edit', docId: this.docId, cells: chunk });
  }

  _flushCursor() {
    const sel = this._cursorPending;
    this._cursorPending = null;
    if (!sel) return;
    this._cursorLast = Date.now();
    this.send({
      t: 'cursor',
      docId: this.docId,
      active: sel.active !== undefined ? sel.active : null,
      range: sel.range !== undefined ? sel.range : null,
    });
  }

  _flushQueue() {
    if (this._queue.length === 0) return;
    const pending = this._queue;
    this._queue = [];
    for (const msg of pending) this._raw(msg);
  }

  _dispatch(msg) {
    switch (msg.t) {
      case 'welcome':
        // Payload is the document, aliased so m.doc / m.you / m.peers also resolve.
        this._emit('onWelcome', withAliases(msg.doc, msg, 'doc'));
        break;
      case 'edit':
        this._emit('onEdit', withAliases(msg.cells, msg, 'cells'));
        break;
      case 'struct':
        this._emit('onStruct', withAliases(msg.doc, msg, 'doc'));
        break;
      case 'meta':
        this._emit('onMeta', withAliases(msg.patch, msg, 'patch'));
        break;
      case 'peers':
        this._emit('onPeers', withAliases(msg.peers, msg, 'peers'));
        break;
      case 'sheets':
        // A sheet op (add/rename/delete/reorder/duplicate/color) resends the whole
        // document, because a sheet list a client and the server disagree on is far
        // worse than the cost of one extra payload on a rare operation.
        this._emit('onSheets', withAliases(msg.doc, msg, 'doc'));
        break;
      case 'docmeta':
        this._emit('onDocMeta', withAliases(msg.patch, msg, 'patch'));
        break;
      case 'cursor':
        this._emit('onCursor', msg);
        break;
      case 'ack':
        // SPEC 27.3 — the operation named by `opId` is on disk. The whole frame goes to
        // the handler (not just the id) because `rev` travels with it.
        this._emit('onAck', msg);
        break;
      case 'error':
        this._emit('onError', msg);
        break;
      case 'pong':
        break;
      default:
        break;
    }
  }

  _emit(name, payload) {
    const fn = this.handlers && this.handlers[name];
    if (typeof fn !== 'function') return;
    try {
      fn(payload, this);
    } catch (e) {
      // A throwing handler must never take the socket down with it.
      console.error('[net] handler failed: ' + name, e);
    }
  }

  _setStatus(status) {
    if (this.status === status) return;
    this.status = status;
    this._emit('onStatus', status);
  }

  _scheduleReconnect() {
    if (this.closed) return;
    if (this.authBlocked) return;
    if (this._reconnectTimer !== null) return;
    const delay = BACKOFF_LADDER[Math.min(this._attempt, BACKOFF_LADDER.length - 1)];
    this._attempt += 1;
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      this.connect();
    }, delay);
  }

  /**
   * Two handshakes in a row never opened. Ask the HTTP gate whether the reason is the
   * session, because the socket cannot tell us: a refused upgrade and a dead server
   * arrive as the same close event.
   *
   * 401 -> stop the ladder for good and report 'unauthorized'. Anything else -> this is
   * not an authorisation problem, so the ladder continues untouched and the backoff is
   * exactly what it would have been. Only the status is ever affected; no frame is
   * dropped and nothing the caller is holding is disturbed.
   */
  _checkGate() {
    if (this._probing) return;
    this._probing = true;
    const finish = (blocked) => {
      this._probing = false;
      if (this.closed) return;
      if (!blocked) { this._scheduleReconnect(); return; }
      this.authBlocked = true;
      this._clearTimer('_reconnectTimer');
      this._setStatus('unauthorized');
    };
    let pending;
    try {
      // Same-origin, cookies included, never from the cache: a cached 200 from before
      // the session expired would be exactly the wrong answer.
      pending = fetch(AUTH_PROBE_PATH, {
        method: 'GET',
        credentials: 'same-origin',
        cache: 'no-store',
        headers: { Accept: 'application/json' },
      });
    } catch (e) {
      finish(false); // no fetch in this host, or it threw outright: keep reconnecting
      return;
    }
    if (!pending || typeof pending.then !== 'function') { finish(false); return; }
    pending.then(
      (res) => finish(!!res && res.status === 401),
      () => finish(false),   // unreachable server: not a gate problem
    );
  }

  _startPing() {
    this._stopPing();
    this._pingTimer = setInterval(() => {
      if (!this._isOpen()) return;
      this._raw({ t: 'ping' });
    }, PING_MS);
  }

  _stopPing() {
    if (this._pingTimer !== null) {
      clearInterval(this._pingTimer);
      this._pingTimer = null;
    }
  }

  _clearTimer(prop) {
    if (this[prop] !== null && this[prop] !== undefined) {
      clearTimeout(this[prop]);
      this[prop] = null;
    }
  }
}

export default Net;
