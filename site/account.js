'use strict';

// Cheetah Moon accounts: one sign-in for every game on cheetahmoongames.com.
//
// Accounts live in Bartenders of Corfu (its users table and signing keys);
// this page is just where players sign in. The browser only ever talks to
// cheetahmoongames.com, and these routes pass the request on to Bartenders,
// server to server:
//
//   POST /api/account/login       { username, password, next }
//   POST /api/account/register    { username, email, password, next }
//   POST /api/account/logout
//   POST /api/account/forgot      { email, next }: email a password reset link
//   POST /api/account/reset       { token, password, next }: set a new password
//   GET  /api/account/me          who the login cookie belongs to
//   GET  /api/account/keys/:kid   the public key that checks a login cookie
//
// Bartenders answers login and register with the `userjwt` cookie for the
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
]);
const RENAMED_MESSAGES = {
  'User already exists by name or email': 'That name or email already has an account. Try signing in instead.',
};
const RESET_LINK_INVALID = 'This reset link has expired or has already been used. Ask for a new one.';
const SIGN_IN_FAILED = "That name and password don't match an account.";
const UNAVAILABLE = "Sign-in isn't working right now. Please try again in a minute.";

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

function createAccounts({ bartendersUrl, cookieDomain, fetchImpl = globalThis.fetch }) {
  const keyCache = new Map();

  async function upstream(path, { method = 'GET', body, cookie } = {}) {
    const headers = { Accept: 'application/json' };
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

    const r = await upstream(kind === 'register' ? '/register' : '/login', { method: 'POST', body: payload });
    if (r.status === 200 || r.status === 201) {
      const name = r.json && r.json.username;
      return send(200, { ok: true, name, next }, { 'Set-Cookie': withLegacyCleared(r.setCookies) });
    }
    if (kind === 'login' && (r.status === 401 || r.status === 400)) return send(401, { error: SIGN_IN_FAILED });
    if (kind === 'register' && (r.status === 400 || r.status === 422)) {
      const message = r.json && typeof r.json.error === 'string' ? r.json.error : '';
      return send(400, { error: friendlyError(message, "We couldn't create that account. Check the details and try again.") });
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
    const r = await upstream('/userDetails', { cookie });
    if (r.status === 200 && r.json && r.json.username) {
      const next = safeNext(url.searchParams.get('next') || '/', cookieDomain);
      return send(200, { signedIn: true, name: r.json.username, id: r.json.id, next });
    }
    if (r.status === 401 || r.status === 404) return send(200, { signedIn: false });
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
    else if (p === '/api/account/logout' && req.method === 'POST') work = signOut(req, send);
    else if (p === '/api/account/forgot' && req.method === 'POST') work = forgot(req, send);
    else if (p === '/api/account/reset' && req.method === 'POST') work = reset(req, send);
    else if (p === '/api/account/me' && req.method === 'GET') work = me(req, url, send);
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

  return { handle };
}

module.exports = { createAccounts, safeNext, friendlyError };
