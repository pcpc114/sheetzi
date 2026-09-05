// history.js — undo/redo stack for local edits.
//
// An entry is { undo(){}, redo(){}, label }. The host records one entry per
// user-visible action and is responsible for making undo/redo idempotent.

const MAX_ENTRIES = 200;

export class History {
  constructor(limit = MAX_ENTRIES) {
    const n = Number(limit);
    this.limit = Number.isFinite(n) && n > 0 ? Math.floor(n) : MAX_ENTRIES;
    /** @type {Array<{undo:Function, redo:Function, label?:string}>} */
    this._undo = [];
    /** @type {Array<{undo:Function, redo:Function, label?:string}>} */
    this._redo = [];
    // Guards against entries recorded by the very actions undo()/redo() replay.
    this._applying = false;
  }

  /** Number of entries currently available to undo. */
  get length() {
    return this._undo.length;
  }

  /**
   * Record an action. Clears the redo stack (a new branch invalidates it).
   * Pushes made while an undo/redo is being applied are ignored.
   */
  push(entry) {
    if (this._applying) return;
    if (!entry || typeof entry.undo !== 'function' || typeof entry.redo !== 'function') {
      throw new TypeError('History.push requires { undo(), redo(), label }');
    }
    this._undo.push(entry);
    if (this._undo.length > this.limit) {
      this._undo.splice(0, this._undo.length - this.limit);
    }
    this._redo.length = 0;
  }

  /** @returns {boolean} false when there was nothing to undo. */
  undo() {
    if (this._undo.length === 0) return false;
    const entry = this._undo.pop();
    this._applying = true;
    try {
      entry.undo();
    } catch (e) {
      console.error('[history] undo failed: ' + (entry.label || ''), e);
      return false;
    } finally {
      this._applying = false;
    }
    this._redo.push(entry);
    if (this._redo.length > this.limit) {
      this._redo.splice(0, this._redo.length - this.limit);
    }
    return true;
  }

  /** @returns {boolean} false when there was nothing to redo. */
  redo() {
    if (this._redo.length === 0) return false;
    const entry = this._redo.pop();
    this._applying = true;
    try {
      entry.redo();
    } catch (e) {
      console.error('[history] redo failed: ' + (entry.label || ''), e);
      return false;
    } finally {
      this._applying = false;
    }
    this._undo.push(entry);
    if (this._undo.length > this.limit) {
      this._undo.splice(0, this._undo.length - this.limit);
    }
    return true;
  }

  canUndo() {
    return this._undo.length > 0;
  }

  canRedo() {
    return this._redo.length > 0;
  }

  /** Label of the next undo/redo action, or '' when the stack is empty. */
  undoLabel() {
    const entry = this._undo[this._undo.length - 1];
    return entry && entry.label ? String(entry.label) : '';
  }

  redoLabel() {
    const entry = this._redo[this._redo.length - 1];
    return entry && entry.label ? String(entry.label) : '';
  }

  clear() {
    this._undo.length = 0;
    this._redo.length = 0;
    this._applying = false;
  }
}

export default History;
