// login.js — the password gate page (SPEC section 28.5).
//
// One shared password for the whole site; there are no accounts here, so this page
// has no user field, no "forgot password" and no sign-up. It POSTs to /api/login and
// then goes wherever the server says.
//
// Two rules shape everything below:
//
//   1. The page never invents a reason. The server answers every bad attempt
//      identically on purpose — a wrong password and an empty one produce the same
//      401 with the same wording — so this file renders the message it was handed and
//      adds nothing of its own about whether a password is set, how long it is, or how
//      many tries remain. The only text it composes is the wait computed from the
//      Retry-After header the server itself sent, plus messages about the browser's
//      own side of the exchange (an empty field, a dead connection).
//   2. The password leaves this file exactly once, in the request body. It is never
//      put in a URL, never stored, never logged, and never echoed into the DOM.
//
// This is a page entry module and exports nothing.

const DEFAULT_NEXT = '/';
const MAX_NEXT_LEN = 512;

const form = document.getElementById('sz-login-form');
const field = document.getElementById('sz-login-password');
const submit = document.getElementById('sz-login-submit');
const errorBox = document.getElementById('sz-login-error');

/**
 * Where to go after a successful login.
 *
 * Accepted only as a same-origin path: a single leading '/' that is not followed by
 * another '/' or a backslash. That rules out '//evil.example' and its backslash twin,
 * both of which a browser resolves as another host, and every absolute URL. The server
 * applies the same rule to what it receives and to what it returns; this is the client
 * half of it, so a hostile ?next= cannot steer the page even for the instant before
 * the POST.
 */
function safeNext(value) {
  if (typeof value !== 'string') return DEFAULT_NEXT;
  const text = value.trim();
  if (text.length === 0 || text.length > MAX_NEXT_LEN) return DEFAULT_NEXT;
  if (text[0] !== '/') return DEFAULT_NEXT;
  if (text.length > 1 && (text[1] === '/' || text[1] === '\\')) return DEFAULT_NEXT;
  // Control characters have no business in a path and are where URL smuggling starts;
  // nothing legitimate contains one.
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return DEFAULT_NEXT;
  }
  // Never bounce a freshly authenticated visitor back to this page.
  if (text === '/login' || text.startsWith('/login?') || text.startsWith('/login#')) {
    return DEFAULT_NEXT;
  }
  return text;
}

/** The ?next= the gate put in the URL when it sent the visitor here. */
function requestedNext() {
  try {
    return safeNext(new URLSearchParams(location.search).get('next'));
  } catch {
    return DEFAULT_NEXT;
  }
}

// ------------------------------------------------------------------ messages

function showError(message) {
  if (!errorBox) return;
  // textContent, never innerHTML: this string can carry server wording, and the login
  // page must not be a place where a response body becomes markup.
  errorBox.textContent = message;
}

function clearError() {
  showError('');
}

/**
 * Turn a Retry-After value into Korean the visitor can act on.
 *
 * Only the seconds the SERVER sent are used. When the header is absent or
 * unparseable this returns '' and the caller keeps the server's own sentence rather
 * than guessing a number.
 */
function waitPhrase(retryAfter) {
  const seconds = Number(retryAfter);
  if (!Number.isFinite(seconds) || seconds <= 0) return '';
  if (seconds < 60) return '약 ' + Math.ceil(seconds) + '초 후에 다시 시도할 수 있습니다.';
  const minutes = Math.ceil(seconds / 60);
  if (minutes < 60) return '약 ' + minutes + '분 후에 다시 시도할 수 있습니다.';
  return '약 ' + Math.ceil(minutes / 60) + '시간 후에 다시 시도할 수 있습니다.';
}

/** The message the server sent, or a neutral fallback when it sent none. */
function serverMessage(payload, fallback) {
  if (payload && typeof payload.message === 'string') {
    const text = payload.message.trim();
    if (text) return text;
  }
  return fallback;
}

async function readJson(res) {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

// -------------------------------------------------------------- form plumbing

let inFlight = false;

function setBusy(busy) {
  inFlight = busy;
  if (submit) {
    // Disabled for the whole round trip: a double submit would spend two of the ten
    // attempts the rate limiter allows in fifteen minutes on a single password.
    submit.disabled = busy;
    submit.textContent = busy ? '확인 중…' : '로그인';
  }
  if (field) field.disabled = busy;
}

/** Put the visitor back where they can fix the mistake. */
function refocus() {
  if (!field) return;
  field.focus();
  // Selected rather than cleared, so a typo is corrected by typing over it and a
  // password that was nearly right is not thrown away.
  field.select();
}

/**
 * One attempt. Returns 'navigated' when the page is on its way somewhere else, so the
 * caller knows not to touch the DOM afterwards; anything else means we stayed here and
 * an error is already showing.
 */
async function attemptLogin(password, next) {
  let res;
  try {
    res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // same-origin is already the default, but the cookie this response sets is the
      // entire point of the request, so it is stated rather than assumed.
      credentials: 'same-origin',
      cache: 'no-store',
      body: JSON.stringify({ password, next }),
    });
  } catch {
    // The request never arrived. That is the browser's news, not the server's, so it
    // says nothing about the password.
    showError('서버에 연결하지 못했습니다. 잠시 후 다시 시도해 주세요.');
    return 'failed';
  }

  if (res.status === 429) {
    const payload = await readJson(res);
    const base = serverMessage(payload, '로그인 시도가 너무 많습니다.');
    const wait = waitPhrase(res.headers.get('Retry-After'));
    showError(wait ? base + ' ' + wait : base);
    return 'failed';
  }

  const payload = await readJson(res);

  if (!res.ok || !payload || payload.ok !== true) {
    // 401 and every other refusal land here and read the same: whatever the server
    // said, with a neutral fallback when it said nothing.
    showError(serverMessage(payload, '로그인하지 못했습니다. 잠시 후 다시 시도해 주세요.'));
    return 'failed';
  }

  // The server decides the destination; safeNext is applied again because a redirect
  // target read out of a response body deserves the same suspicion as one read out of
  // a query string. `replace`, not `href`, so Back from the app does not land on the
  // login page and bounce the visitor forward again.
  location.replace(safeNext(payload.next));
  return 'navigated';
}

if (form) {
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (inFlight) return;

    const password = field ? field.value : '';
    if (password === '') {
      // Refused here rather than sent: an empty field is this page's own business, and
      // posting it would spend one of the ten attempts to learn nothing.
      showError('비밀번호를 입력해 주세요.');
      refocus();
      return;
    }

    clearError();
    setBusy(true);
    let outcome = 'failed';
    try {
      outcome = await attemptLogin(password, requestedNext());
    } finally {
      setBusy(false);
    }
    // On success the navigation is already under way; re-focusing a field on a page
    // that is leaving would only fight the browser.
    if (outcome !== 'navigated') refocus();
  });
}

if (field) {
  // Typing is the visitor's answer to the error, so the error clears as they type.
  field.addEventListener('input', () => {
    if (!inFlight && errorBox && errorBox.textContent) clearError();
  });
  // The autofocus attribute covers a normal load; this covers the cases where it has
  // already fired or was ignored, and would otherwise leave the field cold.
  if (document.activeElement !== field) field.focus();
}

window.addEventListener('pageshow', (event) => {
  if (!event.persisted) return;
  // Restored from the back/forward cache, possibly mid-request: the in-flight flag and
  // the disabled button are stale state from a page that is no longer running.
  setBusy(false);
  refocus();
});
