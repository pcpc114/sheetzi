/**
 * @file Formula error values.
 *
 * A `FormulaError` is a *value*, not an exception: it flows through the evaluator the same
 * way a number or a string does. That is why it is a plain class and NOT a subclass of
 * `Error` -- it is never thrown, only stored and propagated.
 *
 * Genuine parse failures are reported by throwing `ParseError` (see `tokenizer.js`); the
 * engine catches that and stores `err(ERR.PARSE, msg)` as the cell value.
 *
 * This module must run unchanged in Node and in the browser: no builtins, no globals.
 */

/**
 * The complete set of error codes the engine can produce.
 * The string value is exactly what is displayed in a cell.
 *
 * @type {Readonly<{
 *   DIV0: '#DIV/0!', VALUE: '#VALUE!', REF: '#REF!', NAME: '#NAME?',
 *   NUM: '#NUM!', NA: '#N/A', CYCLE: '#CYCLE!', PARSE: '#ERROR!'
 * }>}
 */
export const ERR = Object.freeze({
  DIV0:  '#DIV/0!',
  VALUE: '#VALUE!',
  REF:   '#REF!',
  NAME:  '#NAME?',
  NUM:   '#NUM!',
  NA:    '#N/A',
  CYCLE: '#CYCLE!',
  PARSE: '#ERROR!',
});

/**
 * An error *value* living in the spreadsheet value domain.
 *
 * Instances are immutable by convention: build a new one instead of mutating `code`.
 * `JSON.stringify` produces `{"code":"...","message":"..."}`, which is enough for the wire
 * protocol should a computed value ever need to be serialized.
 */
export class FormulaError {
  /**
   * @param {string} code One of the {@link ERR} values, e.g. `'#DIV/0!'`.
   *   A non-string falls back to `ERR.VALUE` so a bad call can never produce `undefined`
   *   in a cell.
   * @param {string} [message] Human-readable detail for tooltips/debugging. May be `''`.
   */
  constructor(code, message = '') {
    /** @type {string} The displayed error code. */
    this.code = typeof code === 'string' && code.length > 0 ? code : ERR.VALUE;
    /** @type {string} Optional detail; never `undefined`. */
    this.message = typeof message === 'string' ? message : (message == null ? '' : String(message));
  }

  /**
   * String coercion yields the bare code, so `'' + err(ERR.NA)` is `'#N/A'` and template
   * literals render correctly without special-casing.
   * @returns {string} The error code.
   */
  toString() {
    return this.code;
  }
}

/**
 * Convenience constructor.
 *
 * @param {string} code One of the {@link ERR} values.
 * @param {string} [message] Optional detail.
 * @returns {FormulaError} A new error value.
 */
export function err(code, message) {
  return new FormulaError(code, message);
}

/**
 * Type guard for the error branch of the value domain.
 *
 * @param {unknown} v Any value.
 * @returns {boolean} `true` when `v` is a {@link FormulaError}.
 */
export function isError(v) {
  return v instanceof FormulaError;
}
