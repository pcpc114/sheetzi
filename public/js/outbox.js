// outbox.js — unsent frames, persisted so a closed tab keeps them (SPEC 27.4).
//
// The promise this file exists to keep: once a person types something, it survives.
// A frame handed to `add()` is written to localStorage BEFORE the caller ever touches
// the socket, and it stays there until the server says the bytes reached the operating
// system (`{t:'ack', opId}` — SPEC 27.3), at which point `ack()` drops it and rewrites
// the store. Close the tab in between, lose the network, kill the browser: the frames
// are still on disk and the next load of this document re-sends them.
//
// Contract notes for the host (main.js):
//   - `add(frame)` returns the opId AND stores a shallow copy carrying `opId`, so the
//     frames from `pending()` are ready to hand straight to `net.send()`. Do not mutate
//     a frame after adding it: the persisted copy was serialised at that moment.
//   - `ack(opId)` is the only way a frame leaves the outbox normally. Use it for a
//     server `{t:'error', opId}` refusal too — that frame will never be accepted, so
//     retrying it for ever would pin the save indicator at 저장 중… (SPEC 27.5).
//     A failed journal append is a DIFFERENT error: the server says it is not safe, so
//     the frame must stay.
//   - `available === false` means localStorage could not be used. The outbox still
//     works in memory, but the tab is no longer crash-proof and the UI must say so
//     rather than pretend. It is never allowed to over-promise.
//   - `onDrop` fires when the cap forces the OLDEST frames out. Silently discarding
//     work is exactly what this feature exists to prevent, so the caller is told.
//
// Known limitation, stated because an unstated hole is worse than none: the key is
// per-document (`sz.outbox.<docId>`, as the spec fixes it), not per-tab. Two tabs open
// on the same document share it and the later writer's list wins, so a crash in one of
// them can lose frames the other had already superseded in the store. Both tabs are
// live and sending, so this costs a re-send at worst in the normal case; the guarantee
// that holds unconditionally is the single-tab one.

/** Hard cap on retained frames. Past this the oldest are dropped and the caller told. */
export const MAX_OUTBOX = 2000;

/** localStorage key namespace. The full key is `sz.outbox.<docId>`. */
export const OUTBOX_KEY_PREFIX = 'sz.outbox.';

/** Envelope version of the persisted payload. Bump only on an incompatible change. */
export const OUTBOX_FORMAT = 1;

// Matches the server's MAX_OP_ID_LEN: an opId longer than this is not echoed back in an
// ack, so a frame carrying one could never be retired.
const MAX_OP_ID_LEN = 64;

// ---------------------------------------------------------------------------
// opIds
//
// Short, unique within the page, and no crypto: a per-page random tag plus a counter
// shared by every Outbox instance in the page. The tag exists only so that ids minted
// by THIS page cannot collide with ids reloaded from a previous one, which would make
// an ack retire the wrong frame. 36^4 tags is plenty for that job — uniqueness inside
// the page is guaranteed by the counter, not by the randomness.
// ---------------------------------------------------------------------------

const SESSION_TAG = Math.floor(Math.random() * 1679616).toString(36).padStart(4, '0');
let sessionSeq = 0;

function mintOpId() {
  return SESSION_TAG + (sessionSeq++).toString(36);
}

/** The localStorage key an Outbox for `docId` uses. */
export function outboxKey(docId) {
  return OUTBOX_KEY_PREFIX + normalizeDocId(docId);
}

function normalizeDocId(docId) {
  const id = typeof docId === 'string' ? docId.trim() : docId == null ? '' : String(docId).trim();
  return id || 'unknown';
}

/**
 * Resolve the ambient localStorage, tolerating every way it can be missing.
 * Merely READING `globalThis.localStorage` throws when site data is blocked, so even
 * the lookup is wrapped.
 */
function defaultStorage() {
  try {
    const s = globalThis.localStorage;
    if (!s) return null;
    if (typeof s.getItem !== 'function') return null;
    if (typeof s.setItem !== 'function') return null;
    if (typeof s.removeItem !== 'function') return null;
    return s;
  } catch (e) {
    return null;
  }
}

function isFrameLike(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

export class Outbox {
  /**
   * @param {string} docId          one Outbox per document
   * @param {object} [options]
   *   onDrop(frames, info)  called when the cap evicts the oldest frames.
   *                         info: { reason:'overflow'|'load', count, max, docId, entries }
   *                         Also assignable afterwards as `outbox.onDrop = fn`.
   *   max                   override MAX_OUTBOX (tests)
   *   storage               override localStorage (tests)
   */
  constructor(docId, options = {}) {
    const opts = options || {};
    this.docId = normalizeDocId(docId);
    this.key = outboxKey(this.docId);

    const max = Number(opts.max);
    this.max = Number.isFinite(max) && max > 0 ? Math.floor(max) : MAX_OUTBOX;

    this.onDrop = typeof opts.onDrop === 'function' ? opts.onDrop
      : typeof opts.onOverflow === 'function' ? opts.onOverflow
        : null;

    /** @type {Array<{id:string, at:number, frame:object, json:string|null}>} */
    this._records = [];
    /** @type {Map<string, object>} id -> record */
    this._byId = new Map();

    this._storage = opts.storage !== undefined ? (opts.storage || null) : defaultStorage();
    // Storage exists but refuses to be written (quota, private mode). Kept separate from
    // "no storage at all" because a quota can free up: a later successful write heals it.
    this._writeFailed = false;
    this._warnedWrite = false;

    this._load();
    this._probe();
  }

  /**
   * False when localStorage could not be used — absent, blocked or unwritable.
   * The outbox keeps working in memory; it is simply no longer crash-proof, and the UI
   * is expected to say exactly that instead of claiming the work is stored.
   */
  get available() {
    return this._storage !== null && !this._writeFailed;
  }

  /** Number of frames waiting for an ack. */
  get length() {
    return this._records.length;
  }

  size() {
    return this._records.length;
  }

  /**
   * Queue a frame and persist immediately.
   * @param {object} frame  a wire frame; a shallow copy carrying `opId` is stored
   * @returns {string} the opId the server will echo in its ack
   */
  add(frame) {
    if (!isFrameLike(frame)) {
      throw new TypeError('Outbox.add requires a frame object');
    }

    // Reuse a caller-supplied opId only when it is usable and free, so a frame that was
    // already minted elsewhere (a replay) keeps its identity instead of gaining a second.
    let id = frame.opId;
    if (typeof id !== 'string' || !id || id.length > MAX_OP_ID_LEN || this._byId.has(id)) {
      id = mintOpId();
      while (this._byId.has(id)) id = mintOpId();
    }

    const stored = { ...frame, opId: id };
    const record = { id, at: Date.now(), frame: stored, json: null };
    record.json = serializeRecord(record);

    this._records.push(record);
    this._byId.set(id, record);

    this._enforceCap('overflow');
    this._persist();
    return id;
  }

  /**
   * Drop an acknowledged (or definitively refused) frame and persist.
   * @returns {boolean} false when nothing was holding that opId
   */
  ack(opId) {
    if (typeof opId !== 'string' || !opId) return false;
    const record = this._byId.get(opId);
    if (!record) return false;

    this._byId.delete(opId);
    const i = this._records.indexOf(record);
    if (i >= 0) this._records.splice(i, 1);

    this._persist();
    return true;
  }

  /** True while `opId` is still unacknowledged. */
  has(opId) {
    return typeof opId === 'string' && this._byId.has(opId);
  }

  /**
   * Every unacknowledged frame, in the order it was added — which is the order it must
   * be re-sent in after `welcome`. Each frame already carries its `opId`.
   * @returns {object[]}
   */
  pending() {
    const out = new Array(this._records.length);
    for (let i = 0; i < this._records.length; i++) out[i] = this._records[i].frame;
    return out;
  }

  /**
   * The same queue with its bookkeeping, for a UI that wants to show how old the
   * oldest unsaved edit is.
   * @returns {Array<{opId:string, at:number, frame:object}>}
   */
  entries() {
    return this._records.map((r) => ({ opId: r.id, at: r.at, frame: r.frame }));
  }

  /** Forget everything and remove the stored copy. Explicit caller intent: no onDrop. */
  clear() {
    this._records.length = 0;
    this._byId.clear();
    this._persist();
  }

  // ------------------------------------------------------------- internals

  /**
   * Trim to `max` by dropping the OLDEST frames, and tell somebody.
   * The newest are kept because they are the ones the user just typed and can still
   * see on screen; losing those would be the most visible possible failure.
   */
  _enforceCap(reason) {
    if (this._records.length <= this.max) return;
    const dropped = this._records.splice(0, this._records.length - this.max);
    for (const record of dropped) this._byId.delete(record.id);

    const entries = dropped.map((r) => ({ opId: r.id, at: r.at, frame: r.frame }));
    const info = {
      reason,
      count: dropped.length,
      max: this.max,
      docId: this.docId,
      entries,
    };
    if (typeof this.onDrop === 'function') {
      try {
        this.onDrop(entries.map((e) => e.frame), info);
        return;
      } catch (e) {
        console.error('[outbox] onDrop failed', e);
      }
    }
    // No listener, or the listener threw: never let the drop go unmentioned.
    console.warn(`[outbox] dropped ${dropped.length} oldest frame(s) over the ${this.max} cap`);
  }

  /**
   * Write the whole queue.
   *
   * Cost: each record's JSON was produced ONCE, when it was added (or loaded), so a
   * mutation costs one string join and one setItem rather than re-serialising 2000
   * frames. That matters because this runs on every keystroke that reaches the wire.
   */
  _persist() {
    const storage = this._storage;
    if (!storage) return false;

    try {
      if (this._records.length === 0) storage.removeItem(this.key);
      else storage.setItem(this.key, this._payload());
      if (this._writeFailed) {
        this._writeFailed = false;
        this._warnedWrite = false;
      }
      return true;
    } catch (e) {
      // Quota, a locked profile, private mode. The frames stay in memory — nothing is
      // lost right now — but this tab is no longer crash-proof and `available` says so.
      this._writeFailed = true;
      if (!this._warnedWrite) {
        this._warnedWrite = true;
        console.warn('[outbox] localStorage write failed; keeping frames in memory only', e);
      }
      return false;
    }
  }

  _payload() {
    const parts = [];
    for (const record of this._records) {
      if (record.json) parts.push(record.json);
    }
    return `{"v":${OUTBOX_FORMAT},"f":[${parts.join(',')}]}`;
  }

  /** Read whatever a previous tab left behind. Never throws: a corrupt value is not fatal. */
  _load() {
    const storage = this._storage;
    if (!storage) return;

    let raw = null;
    try {
      raw = storage.getItem(this.key);
    } catch (e) {
      // Reading failed, so the storage handle is unusable for anything.
      this._storage = null;
      console.warn('[outbox] localStorage read failed; running in memory only', e);
      return;
    }
    if (typeof raw !== 'string' || raw === '') return;

    let parsed = null;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      console.warn(`[outbox] discarding unreadable stored queue at ${this.key}`, e);
      return;
    }

    const list = Array.isArray(parsed) ? parsed
      : parsed && Array.isArray(parsed.f) ? parsed.f
        : null;
    if (!list) {
      console.warn(`[outbox] discarding stored queue at ${this.key}: unexpected shape`);
      return;
    }

    let skipped = 0;
    let rewritten = 0;
    for (const entry of list) {
      if (!entry || typeof entry !== 'object' || !isFrameLike(entry.f)) {
        skipped++;
        continue;
      }
      const frame = entry.f;

      let id = entry.id;
      if (typeof id !== 'string' || !id || id.length > MAX_OP_ID_LEN || this._byId.has(id)) {
        // A missing or duplicated id would make one ack retire two frames. Re-minting
        // keeps both frames sendable, which is the option that loses no work.
        id = mintOpId();
        while (this._byId.has(id)) id = mintOpId();
        rewritten++;
      }
      if (frame.opId !== id) {
        frame.opId = id;
        rewritten++;
      }

      const at = Number(entry.at);
      const record = {
        id,
        at: Number.isFinite(at) ? at : Date.now(),
        frame,
        json: null,
      };
      record.json = serializeRecord(record);
      this._records.push(record);
      this._byId.set(id, record);
    }

    if (skipped) {
      console.warn(`[outbox] skipped ${skipped} unreadable record(s) at ${this.key}`);
    }

    const over = this._records.length > this.max;
    if (over) this._enforceCap('load');
    // Rewrite only when what we hold no longer matches what is stored.
    if (skipped || rewritten || over) this._persist();
  }

  /**
   * Find out whether storage is WRITABLE before the first edit, so the UI can be honest
   * from the start instead of discovering it the moment someone types. Runs after
   * `_load`, because a full quota must not stop us recovering a previous tab's work.
   */
  _probe() {
    const storage = this._storage;
    if (!storage || this._writeFailed) return;
    const probeKey = `${OUTBOX_KEY_PREFIX}__probe`;
    try {
      storage.setItem(probeKey, '1');
      storage.removeItem(probeKey);
    } catch (e) {
      this._writeFailed = true;
      this._warnedWrite = true;
      console.warn('[outbox] localStorage is not writable; running in memory only', e);
    }
  }
}

/**
 * One JSON.stringify per record, kept for the life of the record.
 * A frame that cannot be serialised (a cycle, a BigInt) could never travel the wire
 * either, so it is kept in memory and simply left out of the stored copy rather than
 * being rejected — dropping it here would be the one thing this module must not do.
 */
function serializeRecord(record) {
  try {
    return JSON.stringify({ id: record.id, at: record.at, f: record.frame });
  } catch (e) {
    console.warn('[outbox] frame could not be serialised; it will not survive this tab', e);
    return null;
  }
}

export default Outbox;
