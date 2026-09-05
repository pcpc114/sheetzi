/**
 * schedule.js — frame scheduling that survives a throttled tab.
 *
 * Coalescing repaints onto requestAnimationFrame is the right instinct, but rAF is not
 * a guaranteed callback: Chrome stops firing it entirely for hidden or fully occluded
 * tabs. Code shaped like
 *
 *     if (pending) return;
 *     pending = true;
 *     requestAnimationFrame(() => { pending = false; paint(); });
 *
 * therefore latches: while the tab is throttled the flag stays true, every later
 * request is swallowed, and nothing repaints. A collaborative app feels this most —
 * a second window quietly stops showing who else is editing.
 *
 * `onNextFrame` races rAF against a timer and runs whichever arrives first, so a
 * visible tab still paints on the frame boundary (no jank, no extra layout) while a
 * throttled one degrades to a timer instead of stopping.
 */

/**
 * Run `fn` on the next animation frame, or after `maxDelayMs` if no frame arrives.
 *
 * @param {() => void} fn          callback; runs exactly once
 * @param {number} [maxDelayMs]    fallback delay when rAF is throttled
 * @returns {() => void}           cancel function; safe to call after the callback ran
 */
export function onNextFrame(fn, maxDelayMs = 200) {
  let done = false;
  let timer = 0;

  const run = () => {
    if (done) return;
    done = true;
    if (timer) { clearTimeout(timer); timer = 0; }
    fn();
  };

  timer = setTimeout(run, maxDelayMs);
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(run);
  else if (typeof queueMicrotask === 'function') queueMicrotask(run);

  return () => {
    done = true;
    if (timer) { clearTimeout(timer); timer = 0; }
  };
}
