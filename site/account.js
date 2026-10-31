'use strict';

// Cheetah Moon accounts: one sign-in for every game on cheetahmoongames.com.
//
// Accounts live in Bartenders of Corfu (its users table and signing keys);
// this page is just where players sign in. The browser only ever talks to
// cheetahmoongames.com, and these routes pass the request on to Bartenders,
// server to server:
//
//   POST /api/account/login       { username, password, next }
//   POST /api/account/register    { username, email, password, next }: makes the
//                                 account and emails a link to verify the email;
//                                 it signs in once that's clicked
//   POST /api/account/verify      { token, next }: verify an email from that link
//   GET  /api/account/google      { clientId }: for the "Sign in with Google" button
//   POST /api/account/google      { credential, next }: sign in with Google's ID token
//   POST /api/account/logout
//   POST /api/account/forgot      { email, next }: email a password reset link
//   POST /api/account/reset       { token, password, next }: set a new password
//   GET  /api/account/me          who the login cookie belongs to (and their email)
//   POST /api/account/email       { email }: change the signed-in player's email
//                                 (once they click a link sent to the new one)
//   POST /api/account/password    { current, password }: change their password
//   GET  /api/account/keys/:kid   the public key that checks a login cookie
//   POST /api/account/seen        { place }: a game saw this signed-in player
//                                 (sent by games' auth.js, with the player's cookie)
//   POST /api/account/guest-seen  { name }: a game saw a guest (no account); the
//                                 game's server sends a Google identity token
//
// Bartenders answers login (and verifying an email) with the `userjwt` cookie for the
// whole of cheetahmoongames.com (its COOKIE_DOMAIN), which is passed back to
// the browser as is. Games read that cookie and check its signature with the
// key from /api/account/keys (see ADDING_A_GAME.md).

const COOKIE_NAME = 'userjwt';
const MAX_BODY = 16 * 1024;
const UPSTREAM_TIMEOUT_MS = 10_000;
const KEY_TTL_MS = 60 * 60 * 1000;
const MISSING_KEY_TTL_MS = 60 * 1000;

// Bartenders' own validation messages are written for players; anything else
// it says (database errors and the like) is replaced with a general message.
const PLAYER_MESSAGES = new Set([
  'Name cannot be empty',
  'Name must be at least 3 characters long',
  'Name cannot exceed 50 characters',
  'Name can only contain letters, numbers, spaces, hyphens, and underscores',
  'Email cannot be empty',
  'Invalid email format',
  'Password must be at least 8 characters long',
  'Password cannot exceed 128 characters',
  'Password must contain at least one letter',
  'Password must contain at least one number',
  'That email is already used by another account.',
]);
const RENAMED_MESSAGES = {
  'User already exists by name or email': 'That name or email already has an account. Try signing in instead.',
};
const RESET_LINK_INVALID = 'This reset link has expired or has already been used. Ask for a new one.';
const VERIFY_LINK_INVALID = "This link has expired or has already been used. Sign in with your name and password and we'll send you a new one.";
const NOT_VERIFIED = "Please verify your email first. We've sent you a link: click it to sign in.";
const EMAIL_TAKEN = 'That email is already used by another account.'; // also in PLAYER_MESSAGES
const SIGN_IN_FAILED = "That name and password don't match an account.";
const SIGN_IN_AGAIN = 'Your sign-in has run out. Sign in again to change your account.';
const WRONG_PASSWORD = "That isn't your current password.";
const UNAVAILABLE = "Sign-in isn't working right now. Please try again in a minute.";
const GOOGLE_FAILED = "Google sign-in didn't work. Please try again.";
const GOOGLE_OFF = "Google sign-in isn't available right now. Sign in with your name and password instead.";
// Why Bartenders turned a Google sign-in away, written for players.
const GOOGLE_MESSAGES = new Set([
  "Google hasn't confirmed that email address is yours, so it can't be used to sign in. Sign in with your name and password instead.",
  "The account for that email isn't active.",
  'The account for that email is already linked to a different Google account. Sign in with your name and password instead.',
]);

function friendlyError(message, fallback) {
  if (PLAYER_MESSAGES.has(message)) return message.endsWith('.') ? message : message + '.';
  return RENAMED_MESSAGES[message] || fallback;
}

function loginCookieValue(req) {
  for (const part of (req.headers.cookie || '').split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0 && part.slice(0, eq).trim() === COOKIE_NAME) return part.slice(eq + 1).trim();
  }
  return null;
}

// Where to send the player after signing in: somewhere on this site or one of
// its games, never another website.
function safeNext(next, cookieDomain) {
  if (typeof next !== 'string' || next === '') return '/';
  if (next.startsWith('/') && !next.startsWith('//') && !next.startsWith('/\\')) return next;
  let url;
  try { url = new URL(next); } catch { return '/'; }
  const host = url.hostname.toLowerCase();
  if (cookieDomain) {
    if (url.protocol === 'https:' && (host === cookieDomain || host.endsWith('.' + cookieDomain))) return url.href;
    return '/';
  }
  // Local development: games run on localhost ports.
  if ((url.protocol === 'http:' || url.protocol === 'https:') && (host === 'localhost' || host === '127.0.0.1')) {
    return url.href;
  }
  return '/';
}

function readJson(req) {
  return new Promise((resolve) => {
    let size = 0;
    const chunks = [];
    // Too big: keep reading (so the reply still reaches the browser) but ignore it.
    req.on('data', (c) => {
      size += c.length;
      if (size <= MAX_BODY) chunks.push(c);
    });
    req.on('end', () => {
      if (size > MAX_BODY) return resolve(null);
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
        resolve(body && typeof body === 'object' && !Array.isArray(body) ? body : null);
      } catch {
        resolve(null);
      }
    });
    req.on('error', () => resolve(null));
  });
}

function createAccounts({ bartendersUrl, cookieDomain, googleClientId = '', fetchImpl = globalThis.fetch }) {
  const keyCache = new Map();

  async function upstream(path, { method = 'GET', body, cookie, headers: extra = {} } = {}) {
    const headers = { Accept: 'application/json', ...extra };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (cookie) headers.Cookie = `${COOKIE_NAME}=${cookie}`;
    const r = await fetchImpl(bartendersUrl + path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: 'manual',
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
    let json = null;
    try { json = await r.json(); } catch { /* not JSON */ }
    const setCookies = typeof r.headers.getSetCookie === 'function' ? r.headers.getSetCookie() : [];
    return { status: r.status, json, setCookies };
  }

  // A login cookie from before sharing is host-only on this domain. Clear it
  // before the shared one is set, so the player holds a single cookie.
  function withLegacyCleared(setCookies) {
    if (!cookieDomain) return setCookies;
    return [`${COOKIE_NAME}=""; Max-Age=0; Path=/; SameSite=Lax`, ...setCookies];
  }

  async function signIn(req, send, kind) {
    const body = await readJson(req);
    if (!body) return send(400, { error: 'Something went wrong. Please try again.' });
    const username = typeof body.username === 'string' ? body.username.trim() : '';
    const password = typeof body.password === 'string' ? body.password : '';
    const next = safeNext(body.next, cookieDomain);

    const payload = { username, password };
    if (kind === 'register') payload.email = typeof body.email === 'string' ? body.email.trim() : '';
    // Where the verification link brings the player back to.
    if (next !== '/') payload.next = next;

    const r = await upstream(kind === 'register' ? '/register' : '/login', { method: 'POST', body: payload });
    // A new account isn't signed in: Bartenders has emailed a link to verify it.
    if (kind === 'register' && r.status === 201) return send(200, { ok: true, verify: true, email: payload.email });
    if (kind === 'login' && r.status === 200) {
      const name = r.json && r.json.username;
      return send(200, { ok: true, name, next }, { 'Set-Cookie': withLegacyCleared(r.setCookies) });
    }
    // The right password, but the email isn't verified: a new link is on its way.
    if (kind === 'login' && r.status === 403 && r.json && r.json.email_not_verified === true) {
      return send(403, { error: NOT_VERIFIED, verify: true });
    }
    if (kind === 'login' && (r.status === 401 || r.status === 400)) return send(401, { error: SIGN_IN_FAILED });
    if (kind === 'register' && (r.status === 400 || r.status === 422)) {
      const message = r.json && typeof r.json.error === 'string' ? r.json.error : '';
      return send(400, { error: friendlyError(message, "We couldn't create that account. Check the details and try again.") });
    }
    return send(502, { error: UNAVAILABLE });
  }

  // Google's "Sign in with Google" button gives the page an ID token (a JWT
  // Google signed). Bartenders checks it and signs in the account linked to
  // that Google account, or the one with the same email (linking the two), or
  // makes a new one.
  async function google(req, send) {
    if (!googleClientId) return send(503, { error: GOOGLE_OFF });
    const body = await readJson(req);
    const credential = body && typeof body.credential === 'string' ? body.credential : '';
    if (!credential || credential.length > 4096) return send(400, { error: GOOGLE_FAILED });
    const next = safeNext(body.next, cookieDomain);
    const r = await upstream('/v1/auth/google', { method: 'POST', body: { credential } });
    if (r.status === 200 || r.status === 201) {
      const name = r.json && r.json.username;
      const created = Boolean(r.json && r.json.created);
      return send(200, { ok: true, name, created, next }, { 'Set-Cookie': withLegacyCleared(r.setCookies) });
    }
    if (r.status === 503) return send(503, { error: GOOGLE_OFF });
    if (r.status === 400 || r.status === 401 || r.status === 422) return send(401, { error: GOOGLE_FAILED });
    if (r.status === 403) {
      const message = r.json && typeof r.json.error === 'string' ? r.json.error : '';
      return send(403, { error: GOOGLE_MESSAGES.has(message) ? message : GOOGLE_FAILED });
    }
    return send(502, { error: UNAVAILABLE });
  }

  // Always the same answer, whether or not the email has an account.
  async function forgot(req, send) {
    const body = await readJson(req);
    const email = body && typeof body.email === 'string' ? body.email.trim() : '';
    if (!email || email.length > 254 || !email.includes('@')) {
      return send(400, { error: 'Please enter the email address for your account.' });
    }
    const next = safeNext(body.next, cookieDomain);
    const payload = { email };
    if (next !== '/') payload.next = next;
    const r = await upstream('/v1/auth/password-reset', { method: 'POST', body: payload });
    if (r.status === 202 || r.status === 200) return send(200, { ok: true });
    return send(502, { error: UNAVAILABLE });
  }

  // Sets the new password and signs the player in with the cookie Bartenders sends.
  async function reset(req, send) {
    const body = await readJson(req);
    if (!body) return send(400, { error: 'Something went wrong. Please try again.' });
    const token = typeof body.token === 'string' ? body.token : '';
    const password = typeof body.password === 'string' ? body.password : '';
    if (!token) return send(400, { error: RESET_LINK_INVALID });
    const next = safeNext(body.next, cookieDomain);
    const r = await upstream('/v1/auth/password-reset/confirm', {
      method: 'POST',
      body: { token, new_password: password },
    });
    if (r.status === 200) {
      const name = r.json && r.json.username;
      return send(200, { ok: true, name, next }, { 'Set-Cookie': withLegacyCleared(r.setCookies) });
    }
    if (r.status === 400 || r.status === 422) {
      const message = r.json && typeof r.json.error === 'string' ? r.json.error : '';
      if (message === RESET_LINK_INVALID) return send(400, { error: RESET_LINK_INVALID, expired: true });
      return send(400, { error: friendlyError(message, "That password can't be used. Try another.") });
    }
    return send(502, { error: UNAVAILABLE });
  }

  // Verifies the email from the emailed link and signs the player in with the
  // cookie Bartenders sends.
  async function verify(req, send) {
    const body = await readJson(req);
    if (!body) return send(400, { error: 'Something went wrong. Please try again.' });
    const token = typeof body.token === 'string' ? body.token : '';
    if (!token) return send(400, { error: VERIFY_LINK_INVALID, expired: true });
    const next = safeNext(body.next, cookieDomain);
    const r = await upstream('/v1/auth/verify-email/confirm', { method: 'POST', body: { token } });
    if (r.status === 200) {
      const name = r.json && r.json.username;
      return send(200, { ok: true, name, next }, { 'Set-Cookie': withLegacyCleared(r.setCookies) });
    }
    if (r.status === 400 || r.status === 422) {
      const message = r.json && typeof r.json.error === 'string' ? r.json.error : '';
      if (message === EMAIL_TAKEN) return send(400, { error: EMAIL_TAKEN });
      return send(400, { error: VERIFY_LINK_INVALID, expired: true });
    }
    return send(502, { error: UNAVAILABLE });
  }

  async function signOut(req, send) {
    const cookie = loginCookieValue(req);
    let setCookies = [];
    if (cookie) {
      try {
        setCookies = (await upstream('/logout', { method: 'POST', cookie })).setCookies;
      } catch {
        // Clear the cookie here anyway; Bartenders just won't record the logout.
      }
    }
    const cleared = [`${COOKIE_NAME}=""; Max-Age=0; Path=/; SameSite=Lax`];
    if (cookieDomain) cleared.push(`${COOKIE_NAME}=""; Domain=${cookieDomain}; Max-Age=0; Path=/; SameSite=Lax`);
    return send(200, { ok: true }, { 'Set-Cookie': [...setCookies, ...cleared] });
  }

  // `?next=` is checked the same way as when signing in, for the login page's
  // "Continue" link when the player is already signed in.
  async function me(req, url, send) {
    const cookie = loginCookieValue(req);
    if (!cookie) return send(200, { signedIn: false });
    // Marked as the home page's, so Bartenders counts the visit as one to
    // cheetahmoongames.com when it tells the owner who's around.
    const r = await upstream('/userDetails', { cookie, headers: { 'X-Cheetah-Moon-Home': '1' } });
    if (r.status === 200 && r.json && r.json.username) {
      const next = safeNext(url.searchParams.get('next') || '/', cookieDomain);
      const body = { signedIn: true, name: r.json.username, id: r.json.id, next };
      if (typeof r.json.email === 'string') body.email = r.json.email;
      // How the account signs in: an account made with Google has no password.
      if (typeof r.json.has_password === 'boolean') body.hasPassword = r.json.has_password;
      if (typeof r.json.google_linked === 'boolean') body.google = r.json.google_linked;
      // The site's admins (Bartenders' is_admin), for games' admin pages.
      body.admin = r.json.is_admin === true;
      return send(200, body);
    }
    if (r.status === 401 || r.status === 404) return send(200, { signedIn: false });
    return send(502, { error: UNAVAILABLE });
  }

  // Changing the signed-in player's email or password: Bartenders checks the
  // login cookie, so a missing or expired one means signing in again.
  async function changeEmail(req, send) {
    const cookie = loginCookieValue(req);
    if (!cookie) return send(401, { error: SIGN_IN_AGAIN });
    const body = await readJson(req);
    const email = body && typeof body.email === 'string' ? body.email.trim() : '';
    if (!email) return send(400, { error: 'Please enter your new email address.' });
    const r = await upstream('/v1/users/me/email', { method: 'PATCH', body: { new_email: email }, cookie });
    // The email changes once the player clicks the link sent to the new one.
    if (r.status === 200) return send(200, { ok: true, email, pending: !(r.json && r.json.pending === false) });
    if (r.status === 401) return send(401, { error: SIGN_IN_AGAIN });
    if (r.status === 400 || r.status === 422) {
      const message = r.json && typeof r.json.error === 'string' ? r.json.error : '';
      return send(400, { error: friendlyError(message, "That email can't be used. Check it and try again.") });
    }
    return send(502, { error: UNAVAILABLE });
  }

  async function changePassword(req, send) {
    const cookie = loginCookieValue(req);
    if (!cookie) return send(401, { error: SIGN_IN_AGAIN });
    const body = await readJson(req);
    const current = body && typeof body.current === 'string' ? body.current : '';
    const password = body && typeof body.password === 'string' ? body.password : '';
    if (!current) return send(400, { error: 'Please enter your current password.' });
    if (!password) return send(400, { error: 'Please choose a new password.' });
    const r = await upstream('/v1/users/me/password', {
      method: 'PATCH',
      body: { old_password: current, new_password: password },
      cookie,
    });
    if (r.status === 200) return send(200, { ok: true });
    if (r.status === 401) return send(401, { error: SIGN_IN_AGAIN });
    if (r.status === 400 || r.status === 422) {
      const message = r.json && typeof r.json.error === 'string' ? r.json.error : '';
      if (message === 'Incorrect password') return send(400, { error: WRONG_PASSWORD, field: 'current' });
      return send(400, { error: friendlyError(message, "That password can't be used. Try another."), field: 'password' });
    }
    return send(502, { error: UNAVAILABLE });
  }

  // A game's auth.js reports a signed-in player it has seen, so Bartenders
  // can tell the owner when someone comes back. The player's own cookie
  // proves who they are; `place` is the game's Cloud Run service name.
  async function seen(req, send) {
    const cookie = loginCookieValue(req);
    if (!cookie) return send(401, { error: 'Not signed in' });
    const body = await readJson(req);
    const place = body && typeof body.place === 'string' ? body.place : '';
    if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(place)) return send(400, { error: 'Unknown place' });
    const r = await upstream('/v1/activity/seen', { method: 'POST', body: { place }, cookie });
    if (r.status === 202 || r.status === 200) return send(202, { ok: true });
    if (r.status === 401) return send(401, { error: 'Not signed in' });
    return send(502, { error: UNAVAILABLE });
  }

  // A game's server saw a guest. It vouches for them with a Google identity
  // token for its Cloud Run service account, which Bartenders checks (and
  // which says which game it is), so it's passed on as it is.
  async function guestSeen(req, send) {
    const auth = req.headers.authorization || '';
    if (!/^Bearer [A-Za-z0-9._-]{20,4096}$/.test(auth)) return send(401, { error: 'Not a game' });
    const body = await readJson(req);
    const name = body && typeof body.name === 'string' ? body.name.slice(0, 100) : '';
    const r = await upstream('/v1/activity/guest-seen', {
      method: 'POST', body: { name }, headers: { Authorization: auth },
    });
    if (r.status === 202 || r.status === 200) return send(202, { ok: true });
    if (r.status === 401) return send(401, { error: 'Not a game' });
    return send(502, { error: UNAVAILABLE });
  }

  async function key(kid, send) {
    if (!/^[0-9a-fA-F-]{36}$/.test(kid)) return send(404, { error: 'Unknown key' });
    const cached = keyCache.get(kid);
    if (cached && cached.expires > Date.now()) return send(cached.status, cached.body, cached.headers);

    const r = await upstream(`/v1/auth/keys/${kid}`);
    let entry;
    if (r.status === 200 && r.json && typeof r.json.pem === 'string') {
      const body = { kid: r.json.kid, alg: r.json.alg, pem: r.json.pem };
      entry = { status: 200, body, headers: { 'Cache-Control': 'public, max-age=3600' }, expires: Date.now() + KEY_TTL_MS };
    } else if (r.status === 404) {
      entry = { status: 404, body: { error: 'Unknown key' }, headers: { 'Cache-Control': 'public, max-age=60' }, expires: Date.now() + MISSING_KEY_TTL_MS };
    } else {
      return send(502, { error: UNAVAILABLE });
    }
    keyCache.set(kid, entry);
    return send(entry.status, entry.body, entry.headers);
  }

  // Handles /api/account/* (returns true), or leaves the request alone.
  function handle(req, res, url, sendRaw) {
    const p = url.pathname;
    if (!p.startsWith('/api/account/')) return false;
    const send = (status, body, headers = {}) => sendRaw(res, status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...headers,
    }, JSON.stringify(body));

    if (!bartendersUrl) {
      send(503, { error: UNAVAILABLE });
      return true;
    }

    let work;
    if (p === '/api/account/login' && req.method === 'POST') work = signIn(req, send, 'login');
    else if (p === '/api/account/register' && req.method === 'POST') work = signIn(req, send, 'register');
    else if (p === '/api/account/google' && req.method === 'GET') {
      send(200, { clientId: googleClientId || null });
      return true;
    } else if (p === '/api/account/google' && req.method === 'POST') work = google(req, send);
    else if (p === '/api/account/logout' && req.method === 'POST') work = signOut(req, send);
    else if (p === '/api/account/forgot' && req.method === 'POST') work = forgot(req, send);
    else if (p === '/api/account/reset' && req.method === 'POST') work = reset(req, send);
    else if (p === '/api/account/verify' && req.method === 'POST') work = verify(req, send);
    else if (p === '/api/account/me' && req.method === 'GET') work = me(req, url, send);
    else if (p === '/api/account/email' && req.method === 'POST') work = changeEmail(req, send);
    else if (p === '/api/account/password' && req.method === 'POST') work = changePassword(req, send);
    else if (p === '/api/account/seen' && req.method === 'POST') work = seen(req, send);
    else if (p === '/api/account/guest-seen' && req.method === 'POST') work = guestSeen(req, send);
    else if (p.startsWith('/api/account/keys/') && req.method === 'GET') work = key(p.slice('/api/account/keys/'.length), send);
    else {
      send(404, { error: 'Not found' });
      return true;
    }
    work.catch((err) => {
      console.error(`account ${p}: ${err && err.message}`);
      if (!res.headersSent) send(502, { error: UNAVAILABLE });
    });
    return true;
  }

  return { handle, upstream };
}

module.exports = { createAccounts, safeNext, friendlyError, readJson, loginCookieValue };
