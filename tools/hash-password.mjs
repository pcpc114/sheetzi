#!/usr/bin/env node
/**
 * hash-password — print a SZ_PASSWORD_HASH value (SPEC section 28.1).
 *
 * The gate accepts a plaintext SZ_PASSWORD for convenience, but a real deployment
 * should never put the password itself into a host's environment panel, a shell
 * history or a .env file that gets copied around. This prints the salted scrypt hash
 * to store instead: the server can verify a password against it, and nobody can read
 * the password back out of it.
 *
 *   npm run hash-password                       asks for it; nothing is echoed
 *   npm run hash-password -- <password>
 *   echo -n <password> | npm run hash-password
 *
 * Output format, which is exactly what server.js parses:
 *
 *   scrypt$<N>$<r>$<p>$<saltBase64>$<hashBase64>
 *
 * Node builtins only — node:crypto has scrypt and randomBytes. This file deliberately
 * does not import server.js, so making a hash never loads express, opens a port or
 * touches data/.
 *
 * The password is never printed, never written to a file and never put in a log line.
 * The only thing that reaches stdout is the hash.
 */
import { randomBytes, scrypt } from 'node:crypto';

// These must stay inside what server.js accepts: N a power of two in
// [1024, 1048576], r in 1..32, p in 1..16, and a key of at least 16 bytes.
const N = 16384;
const R = 8;
const P = 1;
const KEYLEN = 32;
const SALT_BYTES = 16;
const MAX_PASSWORD_LEN = 256;

// Node refuses scrypt when 128 * N * r exceeds maxmem, and the default budget (32 MB)
// is below what this cost needs, so the budget is computed rather than left to chance.
const MAXMEM = 128 * N * R + (2 << 20);

// Keys the terminal sends that are not part of the password.
const CTRL_C = '\u0003';
const CTRL_D = '\u0004';
const BACKSPACE = '\u0008';
const DELETE = '\u007f';

/** Everything explanatory goes to stderr, so stdout carries the hash alone. */
function note(line) {
  process.stderr.write(line + '\n');
}

function fail(line, code = 2) {
  note(line);
  process.exit(code);
}

function derive(password, salt) {
  return new Promise((resolve, reject) => {
    scrypt(
      Buffer.from(password, 'utf8'),
      salt,
      KEYLEN,
      { N, r: R, p: P, maxmem: MAXMEM },
      (err, key) => (err ? reject(err) : resolve(key)),
    );
  });
}

/**
 * Read a password from a terminal without echoing it.
 *
 * Raw mode is the only way to keep the characters off the screen, and it also means
 * this function owns every key: Enter, Backspace and Ctrl+C are handled by hand.
 * Nothing at all is drawn for a keystroke — not even asterisks, whose count is itself
 * a hint about the password.
 */
function promptSilently(prompt) {
  return new Promise((resolve, reject) => {
    const input = process.stdin;
    process.stderr.write(prompt);

    let buffer = '';
    let done = false;

    const finish = (value, error) => {
      if (done) return;
      done = true;
      input.removeListener('data', onData);
      try {
        input.setRawMode(false);
      } catch {
        /* the terminal is already gone; nothing left to restore */
      }
      input.pause();
      process.stderr.write('\n');
      if (error) reject(error);
      else resolve(value);
    };

    const onData = (chunk) => {
      const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      // Iterating the string, not its bytes, keeps a multi-byte character whole, so a
      // Hangul password survives the round trip exactly as typed.
      for (const ch of text) {
        if (ch === '\r' || ch === '\n') {
          finish(buffer);
          return;
        }
        if (ch === CTRL_C) {
          // Leave the terminal usable, then stop the way an interrupted command does.
          finish('', new Error('입력이 취소되었습니다.'));
          return;
        }
        if (ch === CTRL_D) {
          finish(buffer);
          return;
        }
        if (ch === BACKSPACE || ch === DELETE) {
          buffer = buffer.slice(0, -1);
          continue;
        }
        // Every other control character (an escape sequence from an arrow key, say) is
        // dropped rather than allowed to land inside the password.
        if (ch.codePointAt(0) >= 0x20) buffer += ch;
      }
    };

    try {
      input.setRawMode(true);
    } catch {
      finish('', new Error('이 터미널에서는 비밀번호를 가려서 입력할 수 없습니다. 표준 입력으로 전달해 주세요.'));
      return;
    }
    input.resume();
    input.setEncoding('utf8');
    input.on('data', onData);
  });
}

/** Piped input: take everything, drop one trailing newline, keep the rest verbatim. */
async function readPiped() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/, '');
}

async function readPassword() {
  // `npm run hash-password -- <password>` passes the separator through; drop it.
  const fromArgv = process.argv.slice(2).filter((a) => a !== '--');
  if (fromArgv.length > 0) {
    // A password on the command line is visible to every process listing on the
    // machine and lands in the shell's history file. It is accepted because scripts
    // need it, but the operator is told so.
    note('참고: 명령줄에 적은 비밀번호는 셸 기록과 프로세스 목록에 남습니다. 끝난 뒤 기록을 지우세요.');
    return fromArgv.join(' ');
  }
  if (process.stdin.isTTY) {
    const first = await promptSilently('비밀번호: ');
    if (first === '') return '';
    const again = await promptSilently('비밀번호 확인: ');
    if (first !== again) fail('두 번 입력한 비밀번호가 서로 다릅니다. 다시 실행해 주세요.');
    return first;
  }
  return readPiped();
}

async function main() {
  let password;
  try {
    password = await readPassword();
  } catch (err) {
    fail(err && err.message ? err.message : '비밀번호를 읽지 못했습니다.', 130);
    return;
  }

  if (password === '') fail('비밀번호가 비어 있습니다.');
  if (password.length > MAX_PASSWORD_LEN) {
    fail('비밀번호가 너무 깁니다. ' + MAX_PASSWORD_LEN + '자 이하로 정해 주세요.');
  }

  const salt = randomBytes(SALT_BYTES);
  const key = await derive(password, salt);
  // The plaintext has done its job; drop the only reference this process holds.
  password = '';

  const encoded =
    'scrypt$' + N + '$' + R + '$' + P + '$' +
    salt.toString('base64') + '$' + key.toString('base64');

  note('아래 한 줄을 서버 환경 변수 SZ_PASSWORD_HASH 에 넣으세요 (.env 파일이면 SZ_PASSWORD_HASH=<아래 값> 형태로). 이때 SZ_PASSWORD 는 비워 두세요.');
  process.stdout.write(encoded + '\n');
}

main().catch((err) => {
  fail('해시를 만들지 못했습니다: ' + (err && err.message ? err.message : err), 1);
});
