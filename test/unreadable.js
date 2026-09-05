// test/unreadable.js — make one real file impossible to READ, without touching its bytes.
//
// WHY THIS EXISTS
//
// SPEC 27.6 turns on a distinction the filesystem draws and a careless `catch` erases:
//
//   ABSENT   ENOENT. Nothing is stored.
//   CORRUPT  the bytes arrived IN FULL and will not parse.
//   UNREAD   the bytes could not be read at all — EACCES, EPERM, EIO, EBUSY, EISDIR.
//
// The regression tests for that rule need a file that is genuinely UNREAD: present,
// listed by readdir, the right size, holding exactly the bytes it always held, and
// refusing to open. Nothing about the file's CONTENT may change, because half of what
// those tests assert is that the content is still there afterwards — that no rotation
// pushed the good copy down the backup ring and off the end of it.
//
// A stub around `readFileSync` would not do. storage/fileStore.js imports it as a named
// binding from a builtin, so there is nothing a test could reassign, and — much more to
// the point — a fake would prove only that the store handles a fake. The failure being
// pinned down is a real errno from a real syscall, and it is the syscall the SERVER makes
// in ANOTHER PROCESS that matters most: tools/crash.mjs drives real restarts, and no
// in-process patch reaches those. So the file itself is made unreadable, by the operating
// system, for every process on the machine.
//
// HOW
//
//   Windows   `icacls <file> /deny *S-1-1-0:(RD)` — deny the Everyone SID the single
//             right FILE_READ_DATA. Opening for read then fails with EPERM, while stat,
//             readdir, rename and unlink all keep working. That precision matters: the
//             damage being reproduced is `rotateBackups` RENAMING the file it could not
//             read, so renaming has to stay possible or the case would pass for the wrong
//             reason. The SID is written numerically because the account name is
//             localised and would not resolve on a Korean Windows.
//   elsewhere `chmod 000`, which fails the open with EACCES and leaves the same
//             directory-level operations alone.
//
// SAFETY, which is the whole rest of this file
//
// A denial left behind on a real document would be a fault this suite CAUSED — the one
// thing a durability test may never do. So every denial is registered the moment it is
// applied, and released three ways: by the caller's own `finally`, by `releaseAll()` at
// the end of a harness, and by a synchronous `process.on('exit')` hook that runs even
// when the run dies of an uncaught throw. Releasing is idempotent and never throws.
//
// And the injection is VERIFIED. `denyReads` reads the file back before returning and
// refuses to report success unless the read really failed with a non-ENOENT error. A test
// whose injection quietly did not take would exercise the ordinary path and PASS, which
// is worse than having no test at all: it would certify the bug as fixed.

import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, readFileSync, statSync } from 'node:fs';

const IS_WINDOWS = process.platform === 'win32';

// The well-known Everyone group, written as a SID so no account name has to be resolved.
// icacls takes a literal SID when it is prefixed with `*`.
const EVERYONE_SID = '*S-1-1-0';

/**
 * Paths this process has denied and not yet released, with what it takes to restore them.
 * Kept module-level so the exit hook can finish the job whatever happened to the caller.
 *
 * @type {Map<string, {mode: number|null}>}
 */
const denied = new Map();

function icacls(args) {
  // latin1 because icacls prints in the console codepage; nothing here reads the text,
  // and decoding it as UTF-8 would only produce a different kind of mojibake in an error.
  return execFileSync('icacls', args, {
    encoding: 'latin1',
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
}

/**
 * What `readFileSync` does with this path right now: the errno code it failed with, or
 * null when it succeeded.
 *
 * This is the probe every assertion in this module rests on, and it deliberately reports
 * the code rather than a boolean — a test needs to be able to say "it failed, and NOT
 * with ENOENT", because ENOENT is the one failure that means something else entirely.
 */
export function readErrorCode(path) {
  try {
    readFileSync(path);
    return null;
  } catch (err) {
    return (err && err.code) || 'UNKNOWN';
  }
}

/**
 * Make `path` unreadable, and prove it.
 *
 * Throws if the file is not there to begin with, if the platform command fails, or if the
 * file can still be read afterwards. Every one of those means the case about to run would
 * not be testing what it claims to test.
 */
export function denyReads(path) {
  if (!existsSync(path)) {
    throw new Error(`denyReads: ${path} does not exist, so making it unreadable would prove nothing`);
  }
  // Already denied: report the code it is failing with rather than nothing, so a caller
  // that logs the return value says the same thing on the second call as on the first.
  if (denied.has(path)) return readErrorCode(path);

  let mode = null;
  if (IS_WINDOWS) {
    icacls([path, '/deny', `${EVERYONE_SID}:(RD)`]);
  } else {
    mode = statSync(path).mode & 0o777;
    chmodSync(path, 0o000);
  }
  denied.set(path, { mode });

  const code = readErrorCode(path);
  if (code === null || code === 'ENOENT') {
    // Undo before complaining: a half-applied denial must not outlive the failure.
    allowReads(path);
    throw new Error(
      `denyReads: ${path} is still readable after the denial (read gave ${code === null ? 'success' : code}). `
      + 'The injection did not take, so the case would pass against broken code.',
    );
  }
  return code;
}

/** Undo `denyReads`. Idempotent, safe on a path that was never denied, never throws. */
export function allowReads(path) {
  const record = denied.get(path);
  denied.delete(path);
  try {
    if (IS_WINDOWS) {
      // `/remove:d` drops the deny entries for that SID. Run even when this process is not
      // the one that added it, so a leftover from an interrupted earlier run is cleared.
      if (existsSync(path)) icacls([path, '/remove:d', EVERYONE_SID]);
    } else if (existsSync(path)) {
      chmodSync(path, record && record.mode !== null ? record.mode : 0o644);
    }
  } catch {
    /* the file may be gone, or never denied; either way there is nothing left to restore */
  }
}

/** Release every path given, then anything this module still has on its books. */
export function releaseAll(paths = []) {
  for (const path of paths) allowReads(path);
  for (const path of [...denied.keys()]) allowReads(path);
}

// The last net. A harness that throws, or is killed with Ctrl-C, still runs this — and it
// is synchronous, which is the only kind of cleanup an exit hook can actually finish.
process.on('exit', () => {
  for (const path of [...denied.keys()]) allowReads(path);
});
