'use strict';

const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const { createServer } = require('../server.js');
const { safeNext } = require('../account.js');

const ENV = {
  BARTENDERS_URL: 'https://bartenders.cheetahmoongames.com',
  COOKIE_DOMAIN: 'cheetahmoongames.com',
};
const SHARED_COOKIE = 'userjwt=tok; Domain=cheetahmoongames.com; HttpOnly; Max-Age=1209600; Path=/; SameSite=strict';

// A stand-in for Bartenders: routes map "METHOD /path" to a response.
function fakeBartenders(routes) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const u = new URL(url);
    const key = `${init.method} ${u.pathname}`;
    calls.push({ key, headers: init.headers, body: init.body ? JSON.parse(init.body) : undefined });
    const route = routes[key];
    if (!route) return new Response(JSON.stringify({ error: 'nope' }), { status: 404 });
    if (route instanceof Error) throw route;
    const headers = new Headers({ 'Content-Type': 'application/json' });
    for (const c of route.cookies || []) headers.append('Set-Cookie', c);
    return new Response(JSON.stringify(route.body || {}), { status: route.status || 200, headers });
  };
  return { fetchImpl, calls };
}

async function withServer(env, bartenders, fn) {
  const server = createServer(env, { fetchImpl: bartenders.fetchImpl });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  const request = (method, path, { headers = {}, body } = {}) => new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body));
    const req = http.request({
      host: '127.0.0.1', port, method, path,
      headers: { ...(data ? { 'Content-Type': 'application/json' } : {}), ...headers },
    }, (res) => {
      let text = '';
      res.on('data', (c) => { text += c; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(text); } catch { /* not JSON */ }
        resolve({ status: res.statusCode, headers: res.headers, body: text, json });
      });
    });
    req.on('error', reject);
    req.end(data);
  });
  try {
    await fn(request);
  } finally {
    await new Promise((r) => server.close(r));
  }
}

// --- The sign-in page ---------------------------------------------------------

test('serves the sign-in page with both forms', async () => {
  await withServer(ENV, fakeBartenders({}), async (req) => {
    const res = await req('GET', '/login?next=https%3A%2F%2Fbezique.cheetahmoongames.com%2F');
    assert.strictEqual(res.status, 200);
    assert.match(res.body, /id="loginForm"/);
    assert.match(res.body, /id="registerForm"/);
    const css = await req('GET', '/assets/site.css');
    assert.strictEqual(css.status, 200);
  });
});

// --- Signing in ---------------------------------------------------------------

test('signing in passes the shared cookie back and returns where to go next', async () => {
  const bartenders = fakeBartenders({
    'POST /login': { body: { username: 'Ann', id: 'u1' }, cookies: [SHARED_COOKIE] },
  });
  await withServer(ENV, bartenders, async (req) => {
    const res = await req('POST', '/api/account/login', {
      body: { username: ' Ann ', password: 'pw12345678', next: 'https://bezique.cheetahmoongames.com/game/abc' },
    });
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(res.json, { ok: true, name: 'Ann', next: 'https://bezique.cheetahmoongames.com/game/abc' });
    const [clearLegacy, shared] = res.headers['set-cookie'];
    assert.match(clearLegacy, /^userjwt=""; Max-Age=0/);
    assert.doesNotMatch(clearLegacy, /Domain/);
    assert.strictEqual(shared, SHARED_COOKIE);
    assert.deepStrictEqual(bartenders.calls[0].body, {
      username: 'Ann', password: 'pw12345678', next: 'https://bezique.cheetahmoongames.com/game/abc',
    }, 'next goes along for the link if the email needs verifying');
  });
});

test("signing in before verifying the email says so, and doesn't sign in", async () => {
  const bartenders = fakeBartenders({
    'POST /login': {
      status: 403,
      body: { error: 'Please verify your email first.', email_not_verified: true },
    },
  });
  await withServer(ENV, bartenders, async (req) => {
    const res = await req('POST', '/api/account/login', { body: { username: 'Ann', password: 'pw12345678' } });
    assert.strictEqual(res.status, 403);
    assert.strictEqual(res.json.verify, true);
    assert.match(res.json.error, /verify your email/);
    assert.strictEqual(res.headers['set-cookie'], undefined);
    assert.deepStrictEqual(bartenders.calls[0].body, { username: 'Ann', password: 'pw12345678' }, 'no next when it is home');
  });
});

test('a wrong password gets a plain message and no cookie', async () => {
  const bartenders = fakeBartenders({ 'POST /login': { status: 401, body: { error: 'Invalid credentials' } } });
  await withServer(ENV, bartenders, async (req) => {
    const res = await req('POST', '/api/account/login', { body: { username: 'Ann', password: 'nope' } });
    assert.strictEqual(res.status, 401);
    assert.strictEqual(res.json.error, "That name and password don't match an account.");
    assert.strictEqual(res.headers['set-cookie'], undefined);
  });
});

test('Bartenders being down is reported without its error', async () => {
  const bartenders = fakeBartenders({ 'POST /login': new Error('connect ECONNREFUSED 10.0.0.1') });
  await withServer(ENV, bartenders, async (req) => {
    const res = await req('POST', '/api/account/login', { body: { username: 'Ann', password: 'pw' } });
    assert.strictEqual(res.status, 502);
    assert.doesNotMatch(res.body, /ECONNREFUSED/);
    assert.match(res.json.error, /try again/);
  });
});

test('bad request bodies are refused before reaching Bartenders', async () => {
  const bartenders = fakeBartenders({});
  await withServer(ENV, bartenders, async (req) => {
    for (const body of ['not json', '[1,2]', 'x'.repeat(20000)]) {
      const res = await req('POST', '/api/account/login', { body });
      assert.strictEqual(res.status, 400);
    }
    assert.strictEqual(bartenders.calls.length, 0);
  });
});

// --- Creating an account ------------------------------------------------------

test("creating an account asks the player to verify their email, and doesn't sign in", async () => {
  const bartenders = fakeBartenders({
    'POST /register': { status: 201, body: { username: 'New Player', id: 'u2', email_verification_sent: true } },
  });
  await withServer(ENV, bartenders, async (req) => {
    const res = await req('POST', '/api/account/register', {
      body: { username: 'New Player', email: ' np@example.com ', password: 'abcdefg1', next: 'https://bezique.cheetahmoongames.com/' },
    });
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(res.json, { ok: true, verify: true, email: 'np@example.com' });
    assert.strictEqual(res.headers['set-cookie'], undefined);
    assert.deepStrictEqual(bartenders.calls[0].body, {
      username: 'New Player', password: 'abcdefg1', email: 'np@example.com', next: 'https://bezique.cheetahmoongames.com/',
    });
  });
});

test('validation messages meant for players are shown; others are not', async () => {
  const cases = [
    ['Password must contain at least one number', 'Password must contain at least one number.'],
    ['User already exists by name or email', 'That name or email already has an account. Try signing in instead.'],
    ['duplicate key value violates unique constraint "users_pkey"', "We couldn't create that account. Check the details and try again."],
  ];
  for (const [upstream, shown] of cases) {
    const bartenders = fakeBartenders({ 'POST /register': { status: 400, body: { error: upstream } } });
    await withServer(ENV, bartenders, async (req) => {
      const res = await req('POST', '/api/account/register', { body: { username: 'x', email: 'e', password: 'p' } });
      assert.strictEqual(res.status, 400);
      assert.strictEqual(res.json.error, shown);
    });
  }
});

// --- Who's signed in, and signing out -----------------------------------------

test('me reports the signed-in player, passing only the login cookie on', async () => {
  const bartenders = fakeBartenders({
    'GET /userDetails': { body: { username: 'Ann', id: 'u1', email: 'ann@example.com', is_admin: false } },
  });
  await withServer(ENV, bartenders, async (req) => {
    const res = await req('GET', '/api/account/me?next=https%3A%2F%2Fevil.example%2F', {
      headers: { cookie: 'theme=dark; userjwt=tok' },
    });
    assert.deepStrictEqual(res.json, { signedIn: true, name: 'Ann', id: 'u1', next: '/', email: 'ann@example.com', admin: false, childAccount: false });
    assert.strictEqual(bartenders.calls[0].headers.Cookie, 'userjwt=tok');
  });
});

test("me says whether the player is one of the site's admins", async () => {
  const bartenders = fakeBartenders({ 'GET /userDetails': { body: { username: 'Kyle', id: 'u9', is_admin: true } } });
  await withServer(ENV, bartenders, async (req) => {
    const res = await req('GET', '/api/account/me', { headers: { cookie: 'userjwt=tok' } });
    assert.strictEqual(res.json.admin, true);
  });
});

test('me without a cookie, or with a rejected one, is signed out', async () => {
  const bartenders = fakeBartenders({ 'GET /userDetails': { status: 401, body: { error: 'Authentication required' } } });
  await withServer(ENV, bartenders, async (req) => {
    assert.deepStrictEqual((await req('GET', '/api/account/me')).json, { signedIn: false });
    assert.strictEqual(bartenders.calls.length, 0);
    assert.deepStrictEqual((await req('GET', '/api/account/me', { headers: { cookie: 'userjwt=old' } })).json, { signedIn: false });
  });
});

test('signing out tells Bartenders and clears both copies of the cookie', async () => {
  const bartenders = fakeBartenders({ 'POST /logout': { body: { message: 'Logged out' } } });
  await withServer(ENV, bartenders, async (req) => {
    const res = await req('POST', '/api/account/logout', { headers: { cookie: 'userjwt=tok' } });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(bartenders.calls[0].headers.Cookie, 'userjwt=tok');
    const cookies = res.headers['set-cookie'];
    assert.ok(cookies.some((c) => /^userjwt=""; Max-Age=0/.test(c)));
    assert.ok(cookies.some((c) => /^userjwt=""; Domain=cheetahmoongames\.com; Max-Age=0/.test(c)));
  });
});

// --- Keys for games -----------------------------------------------------------

test('games can fetch signing keys, which are cached', async () => {
  const kid = '0b9f4a6e-3f38-4a51-9a53-2f1a52c2d0a1';
  const bartenders = fakeBartenders({
    [`GET /v1/auth/keys/${kid}`]: { body: { kid, alg: 'RS256', pem: '-----BEGIN PUBLIC KEY-----\nabc\n-----END PUBLIC KEY-----\n' } },
  });
  await withServer(ENV, bartenders, async (req) => {
    for (let i = 0; i < 3; i++) {
      const res = await req('GET', `/api/account/keys/${kid}`);
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.json.alg, 'RS256');
      assert.match(res.headers['cache-control'], /max-age=3600/);
    }
    assert.strictEqual(bartenders.calls.length, 1);
    const unknown = await req('GET', '/api/account/keys/00000000-0000-0000-0000-000000000000');
    assert.strictEqual(unknown.status, 404);
    const bad = await req('GET', '/api/account/keys/..%2F..%2FuserDetails');
    assert.strictEqual(bad.status, 404);
    assert.strictEqual(bartenders.calls.length, 2);
  });
});

test('unknown account routes are not sent to Bartenders', async () => {
  const bartenders = fakeBartenders({});
  await withServer(ENV, bartenders, async (req) => {
    assert.strictEqual((await req('GET', '/api/account/login')).status, 404);
    assert.strictEqual((await req('POST', '/api/account/admin')).status, 404);
    assert.strictEqual(bartenders.calls.length, 0);
  });
});

// --- Where players go after signing in ----------------------------------------

test('next only allows this site and its games', () => {
  const d = 'cheetahmoongames.com';
  assert.strictEqual(safeNext('/profile', d), '/profile');
  assert.strictEqual(safeNext('https://bezique.cheetahmoongames.com/x?y=1', d), 'https://bezique.cheetahmoongames.com/x?y=1');
  assert.strictEqual(safeNext('https://cheetahmoongames.com/', d), 'https://cheetahmoongames.com/');
  for (const bad of [
    '//evil.example/', '/\\evil.example', 'https://evil.example/', 'https://cheetahmoongames.com.evil.example/',
    'https://evilcheetahmoongames.com/', 'http://bezique.cheetahmoongames.com/', 'javascript:alert(1)', undefined, 42,
  ]) {
    assert.strictEqual(safeNext(bad, d), '/', String(bad));
  }
  // Without a shared domain (running locally) games on localhost are allowed.
  assert.strictEqual(safeNext('http://localhost:3000/', ''), 'http://localhost:3000/');
  assert.strictEqual(safeNext('https://evil.example/', ''), '/');
});

// --- Forgotten passwords --------------------------------------------------------

test('serves the reset page without leaking its link as a referrer', async () => {
  await withServer(ENV, fakeBartenders({}), async (req) => {
    const res = await req('GET', '/reset-password?token=abc');
    assert.strictEqual(res.status, 200);
    assert.match(res.body, /id="resetForm"/);
    assert.strictEqual(res.headers['referrer-policy'], 'no-referrer');
  });
});

test('asking for a reset link passes the email and a safe next on', async () => {
  const bartenders = fakeBartenders({ 'POST /v1/auth/password-reset': { status: 202, body: { ok: true } } });
  await withServer(ENV, bartenders, async (req) => {
    const res = await req('POST', '/api/account/forgot', {
      body: { email: ' ann@example.com ', next: 'https://bezique.cheetahmoongames.com/' },
    });
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(res.json, { ok: true });
    assert.deepStrictEqual(bartenders.calls[0].body, { email: 'ann@example.com', next: 'https://bezique.cheetahmoongames.com/' });

    await req('POST', '/api/account/forgot', { body: { email: 'ann@example.com', next: 'https://evil.example/' } });
    assert.deepStrictEqual(bartenders.calls[1].body, { email: 'ann@example.com' }, 'off-site next is dropped');
  });
});

test('asking without an email is refused here', async () => {
  const bartenders = fakeBartenders({});
  await withServer(ENV, bartenders, async (req) => {
    for (const body of [{}, { email: '' }, { email: 'no-at-sign' }, { email: 42 }]) {
      const res = await req('POST', '/api/account/forgot', { body });
      assert.strictEqual(res.status, 400);
    }
    assert.strictEqual(bartenders.calls.length, 0);
  });
});

test('a new password from a reset link signs the player in', async () => {
  const bartenders = fakeBartenders({
    'POST /v1/auth/password-reset/confirm': { body: { username: 'Ann', id: 'u1' }, cookies: [SHARED_COOKIE] },
  });
  await withServer(ENV, bartenders, async (req) => {
    const res = await req('POST', '/api/account/reset', {
      body: { token: 'tok123', password: 'NewPassword2', next: 'https://bezique.cheetahmoongames.com/' },
    });
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(res.json, { ok: true, name: 'Ann', next: 'https://bezique.cheetahmoongames.com/' });
    assert.ok(res.headers['set-cookie'].includes(SHARED_COOKIE));
    assert.deepStrictEqual(bartenders.calls[0].body, { token: 'tok123', new_password: 'NewPassword2' });
  });
});

test('expired links and refused passwords are explained', async () => {
  const expired = 'This reset link has expired or has already been used. Ask for a new one.';
  for (const [upstream, shown, isExpired] of [
    [expired, expired, true],
    ['Password must contain at least one number', 'Password must contain at least one number.', undefined],
    ['something internal', "That password can't be used. Try another.", undefined],
  ]) {
    const bartenders = fakeBartenders({ 'POST /v1/auth/password-reset/confirm': { status: 400, body: { error: upstream } } });
    await withServer(ENV, bartenders, async (req) => {
      const res = await req('POST', '/api/account/reset', { body: { token: 't', password: 'p' } });
      assert.strictEqual(res.status, 400);
      assert.strictEqual(res.json.error, shown);
      assert.strictEqual(res.json.expired, isExpired);
      assert.strictEqual(res.headers['set-cookie'], undefined);
    });
  }
  const bartenders = fakeBartenders({});
  await withServer(ENV, bartenders, async (req) => {
    const res = await req('POST', '/api/account/reset', { body: { password: 'p' } });
    assert.strictEqual(res.status, 400);
    assert.strictEqual(bartenders.calls.length, 0, 'no token, nothing sent');
  });
});

// --- Verifying an email -------------------------------------------------------

test('serves the verify page without leaking its link as a referrer', async () => {
  await withServer(ENV, fakeBartenders({}), async (req) => {
    const res = await req('GET', '/verify-email?token=abc');
    assert.strictEqual(res.status, 200);
    assert.match(res.body, /id="verifyForm"/);
    assert.strictEqual(res.headers['referrer-policy'], 'no-referrer');
  });
});

test('a verify link signs the player in and returns where to go next', async () => {
  const bartenders = fakeBartenders({
    'POST /v1/auth/verify-email/confirm': { body: { username: 'Ann', id: 'u1' }, cookies: [SHARED_COOKIE] },
  });
  await withServer(ENV, bartenders, async (req) => {
    const res = await req('POST', '/api/account/verify', {
      body: { token: 'tok123', next: 'https://bezique.cheetahmoongames.com/' },
    });
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(res.json, { ok: true, name: 'Ann', next: 'https://bezique.cheetahmoongames.com/' });
    assert.ok(res.headers['set-cookie'].includes(SHARED_COOKIE));
    assert.deepStrictEqual(bartenders.calls[0].body, { token: 'tok123' });

    const offSite = await req('POST', '/api/account/verify', { body: { token: 'tok123', next: 'https://evil.example/' } });
    assert.strictEqual(offSite.json.next, '/');
  });
});

test('a used or expired verify link is explained, and a taken email too', async () => {
  const expired = "This link has expired or has already been used. Sign in with your name and password and we'll send you a new one.";
  const taken = 'That email is already used by another account.';
  for (const [upstream, shown, isExpired] of [
    [expired, expired, true],
    [taken, taken, undefined],
    ['something internal', expired, true],
  ]) {
    const bartenders = fakeBartenders({ 'POST /v1/auth/verify-email/confirm': { status: 400, body: { error: upstream } } });
    await withServer(ENV, bartenders, async (req) => {
      const res = await req('POST', '/api/account/verify', { body: { token: 't' } });
      assert.strictEqual(res.status, 400);
      assert.strictEqual(res.json.error, shown);
      assert.strictEqual(res.json.expired, isExpired);
      assert.strictEqual(res.headers['set-cookie'], undefined);
    });
  }
  const bartenders = fakeBartenders({});
  await withServer(ENV, bartenders, async (req) => {
    const res = await req('POST', '/api/account/verify', { body: {} });
    assert.strictEqual(res.status, 400);
    assert.strictEqual(bartenders.calls.length, 0, 'no token, nothing sent');
  });
});

// --- The account page: email and password ------------------------------------

test('serves the account page', async () => {
  await withServer(ENV, fakeBartenders({}), async (req) => {
    const res = await req('GET', '/profile');
    assert.strictEqual(res.status, 200);
    assert.match(res.body, /id="emailForm"/);
    assert.match(res.body, /id="passwordForm"/);
    assert.match(res.headers['cache-control'], /no-store/);
  });
});

test('who is signed in includes their email for the account page', async () => {
  const bartenders = fakeBartenders({
    'GET /userDetails': { body: { username: 'Ann', id: 'u1', email: 'ann@example.com' } },
  });
  await withServer(ENV, bartenders, async (req) => {
    const res = await req('GET', '/api/account/me', { headers: { Cookie: 'userjwt=tok' } });
    assert.strictEqual(res.json.email, 'ann@example.com');
    assert.strictEqual(res.json.name, 'Ann');
  });
});

test('changing email passes the login cookie on to Bartenders', async () => {
  const bartenders = fakeBartenders({ 'PATCH /v1/users/me/email': { body: { message: 'ok', pending: true } } });
  await withServer(ENV, bartenders, async (req) => {
    const res = await req('POST', '/api/account/email', {
      headers: { Cookie: 'userjwt=tok' }, body: { email: ' new@example.com ' },
    });
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(res.json, { ok: true, email: 'new@example.com', pending: true }, 'changes once the link is clicked');
    assert.deepStrictEqual(bartenders.calls[0].body, { new_email: 'new@example.com' });
    assert.strictEqual(bartenders.calls[0].headers.Cookie, 'userjwt=tok');
  });
});

test('a bad new email gets a player-friendly message', async () => {
  const bartenders = fakeBartenders({
    'PATCH /v1/users/me/email': { status: 400, body: { error: 'Invalid email format' } },
  });
  await withServer(ENV, bartenders, async (req) => {
    const res = await req('POST', '/api/account/email', {
      headers: { Cookie: 'userjwt=tok' }, body: { email: 'nope@' },
    });
    assert.strictEqual(res.status, 400);
    assert.strictEqual(res.json.error, 'Invalid email format.');
  });
});

test('changing your account needs you signed in', async () => {
  const bartenders = fakeBartenders({});
  await withServer(ENV, bartenders, async (req) => {
    for (const [path, body] of [['/api/account/email', { email: 'a@b.co' }], ['/api/account/password', { current: 'a', password: 'b' }]]) {
      const res = await req('POST', path, { body });
      assert.strictEqual(res.status, 401);
      assert.match(res.json.error, /Sign in again/);
    }
    assert.strictEqual(bartenders.calls.length, 0);
  });
});

test('an expired login is told to sign in again', async () => {
  const bartenders = fakeBartenders({ 'PATCH /v1/users/me/password': { status: 401, body: { error: 'Token expired' } } });
  await withServer(ENV, bartenders, async (req) => {
    const res = await req('POST', '/api/account/password', {
      headers: { Cookie: 'userjwt=old' }, body: { current: 'pw12345678', password: 'newpass12' },
    });
    assert.strictEqual(res.status, 401);
    assert.doesNotMatch(res.body, /Token expired/);
  });
});

test('changing password sends the old and new password', async () => {
  const bartenders = fakeBartenders({ 'PATCH /v1/users/me/password': { body: { message: 'ok' } } });
  await withServer(ENV, bartenders, async (req) => {
    const res = await req('POST', '/api/account/password', {
      headers: { Cookie: 'userjwt=tok' }, body: { current: 'oldpass12', password: 'newpass12' },
    });
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(bartenders.calls[0].body, { old_password: 'oldpass12', new_password: 'newpass12' });
  });
});

test('a wrong current password points at that field', async () => {
  const bartenders = fakeBartenders({
    'PATCH /v1/users/me/password': { status: 400, body: { error: 'Incorrect password' } },
  });
  await withServer(ENV, bartenders, async (req) => {
    const res = await req('POST', '/api/account/password', {
      headers: { Cookie: 'userjwt=tok' }, body: { current: 'wrong', password: 'newpass12' },
    });
    assert.strictEqual(res.status, 400);
    assert.strictEqual(res.json.field, 'current');
    assert.match(res.json.error, /current password/);
  });
});

test('a weak new password gets the rule it broke', async () => {
  const bartenders = fakeBartenders({
    'PATCH /v1/users/me/password': { status: 400, body: { error: 'Password must contain at least one number' } },
  });
  await withServer(ENV, bartenders, async (req) => {
    const res = await req('POST', '/api/account/password', {
      headers: { Cookie: 'userjwt=tok' }, body: { current: 'oldpass12', password: 'abcdefghij' },
    });
    assert.strictEqual(res.status, 400);
    assert.strictEqual(res.json.field, 'password');
    assert.strictEqual(res.json.error, 'Password must contain at least one number.');
  });
});

// --- Signing in with Google -----------------------------------------------------

const GOOGLE_ENV = { ...ENV, GOOGLE_CLIENT_ID: 'abc.apps.googleusercontent.com' };

test('the sign-in page can read the Google client ID', async () => {
  await withServer(GOOGLE_ENV, fakeBartenders({}), async (req) => {
    const res = await req('GET', '/api/account/google');
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(res.json, { clientId: 'abc.apps.googleusercontent.com' });
  });
  await withServer(ENV, fakeBartenders({}), async (req) => {
    const res = await req('GET', '/api/account/google');
    assert.deepStrictEqual(res.json, { clientId: null });
  });
});

test('signing in with Google passes the token on and the shared cookie back', async () => {
  const bartenders = fakeBartenders({
    'POST /v1/auth/google': { status: 201, body: { username: 'Ada', id: 'u1', created: true }, cookies: [SHARED_COOKIE] },
  });
  await withServer(GOOGLE_ENV, bartenders, async (req) => {
    const res = await req('POST', '/api/account/google', {
      body: { credential: 'google.id.token', next: 'https://boxer.cheetahmoongames.com/table' },
    });
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(res.json, {
      ok: true, name: 'Ada', created: true, next: 'https://boxer.cheetahmoongames.com/table',
    });
    assert.deepStrictEqual(bartenders.calls[0].body, { credential: 'google.id.token' });
    assert.ok(res.headers['set-cookie'].includes(SHARED_COOKIE));
  });
});

test('a Google sign-in for another website goes home instead', async () => {
  const bartenders = fakeBartenders({
    'POST /v1/auth/google': { body: { username: 'Ada', id: 'u1', created: false }, cookies: [SHARED_COOKIE] },
  });
  await withServer(GOOGLE_ENV, bartenders, async (req) => {
    const res = await req('POST', '/api/account/google', { body: { credential: 't', next: 'https://evil.example/' } });
    assert.strictEqual(res.json.next, '/');
  });
});

test("Bartenders' reasons for refusing a Google sign-in reach the player; anything else doesn't", async () => {
  const linked = 'The account for that email is already linked to a different Google account. Sign in with your name and password instead.';
  for (const [upstream, status, error] of [
    [{ status: 403, body: { error: linked } }, 403, linked],
    [{ status: 403, body: { error: 'relation "users" does not exist' } }, 403, "Google sign-in didn't work. Please try again."],
    [{ status: 401, body: { error: 'whatever' } }, 401, "Google sign-in didn't work. Please try again."],
    [{ status: 503, body: { error: 'Google sign-in is not set up' } }, 503, "Google sign-in isn't available right now. Sign in with your name and password instead."],
    [{ status: 500, body: {} }, 502, "Sign-in isn't working right now. Please try again in a minute."],
  ]) {
    await withServer(GOOGLE_ENV, fakeBartenders({ 'POST /v1/auth/google': upstream }), async (req) => {
      const res = await req('POST', '/api/account/google', { body: { credential: 't' } });
      assert.strictEqual(res.status, status);
      assert.strictEqual(res.json.error, error);
      assert.strictEqual(res.headers['set-cookie'], undefined);
    });
  }
});

test('Google sign-in is off without a client ID, and needs a token', async () => {
  const bartenders = fakeBartenders({});
  await withServer(ENV, bartenders, async (req) => {
    const res = await req('POST', '/api/account/google', { body: { credential: 't' } });
    assert.strictEqual(res.status, 503);
  });
  await withServer(GOOGLE_ENV, bartenders, async (req) => {
    const res = await req('POST', '/api/account/google', { body: {} });
    assert.strictEqual(res.status, 400);
  });
  assert.strictEqual(bartenders.calls.length, 0);
});

test('who is signed in says whether the account has a password and a linked Google account', async () => {
  const bartenders = fakeBartenders({
    'GET /userDetails': { body: { username: 'Ada', id: 'u1', email: 'ada@example.com', has_password: false, google_linked: true } },
  });
  await withServer(ENV, bartenders, async (req) => {
    const res = await req('GET', '/api/account/me', { headers: { Cookie: 'userjwt=tok' } });
    assert.deepStrictEqual(res.json, {
      signedIn: true, name: 'Ada', id: 'u1', next: '/', email: 'ada@example.com', hasPassword: false, google: true, admin: false, childAccount: false,
    });
  });
});

// --- Games reporting players they've seen ----------------------------------------

test("a game's report of a player is passed on with the player's cookie", async () => {
  const bartenders = fakeBartenders({ 'POST /v1/activity/seen': { status: 202, body: { ok: true } } });
  await withServer(ENV, bartenders, async (req) => {
    const res = await req('POST', '/api/account/seen', {
      headers: { Cookie: 'userjwt=tok' }, body: { place: 'bezique' },
    });
    assert.strictEqual(res.status, 202);
    assert.deepStrictEqual(bartenders.calls[0].body, { place: 'bezique' });
    assert.strictEqual(bartenders.calls[0].headers.Cookie, 'userjwt=tok');
  });
});

test('a report needs a cookie and a place that looks like a game', async () => {
  const bartenders = fakeBartenders({});
  await withServer(ENV, bartenders, async (req) => {
    assert.strictEqual((await req('POST', '/api/account/seen', { body: { place: 'bezique' } })).status, 401);
    const bad = await req('POST', '/api/account/seen', { headers: { Cookie: 'userjwt=tok' }, body: { place: '../x' } });
    assert.strictEqual(bad.status, 400);
  });
  assert.strictEqual(bartenders.calls.length, 0);
});

test('a report with a cookie Bartenders refuses is a 401', async () => {
  const bartenders = fakeBartenders({ 'POST /v1/activity/seen': { status: 401, body: { error: 'Authentication required' } } });
  await withServer(ENV, bartenders, async (req) => {
    const res = await req('POST', '/api/account/seen', { headers: { Cookie: 'userjwt=bad' }, body: { place: 'bezique' } });
    assert.strictEqual(res.status, 401);
  });
});

test("asking who's signed in marks the request as the home page's", async () => {
  const bartenders = fakeBartenders({ 'GET /userDetails': { body: { username: 'Ann', id: 'u1' } } });
  await withServer(ENV, bartenders, async (req) => {
    await req('GET', '/api/account/me', { headers: { Cookie: 'userjwt=tok' } });
    assert.strictEqual(bartenders.calls[0].headers['X-Cheetah-Moon-Home'], '1');
  });
});

test("a game's report of a guest is passed on with the game's identity token", async () => {
  const bartenders = fakeBartenders({ 'POST /v1/activity/guest-seen': { status: 202, body: { ok: true } } });
  const token = 'eyJhbGciOiJSUzI1NiJ9.eyJlbWFpbCI6IngifQ.c2lnbmF0dXJl';
  await withServer(ENV, bartenders, async (req) => {
    const res = await req('POST', '/api/account/guest-seen', {
      headers: { Authorization: `Bearer ${token}` }, body: { name: 'Bob' },
    });
    assert.strictEqual(res.status, 202);
    assert.deepStrictEqual(bartenders.calls[0].body, { name: 'Bob' });
    assert.strictEqual(bartenders.calls[0].headers.Authorization, `Bearer ${token}`);
    assert.strictEqual(bartenders.calls[0].headers.Cookie, undefined);
  });
});

test('a guest report needs a token, and one Bartenders refuses is a 401', async () => {
  const bartenders = fakeBartenders({ 'POST /v1/activity/guest-seen': { status: 401, body: { error: 'Not a game' } } });
  await withServer(ENV, bartenders, async (req) => {
    assert.strictEqual((await req('POST', '/api/account/guest-seen', { body: { name: 'Bob' } })).status, 401);
    assert.strictEqual(bartenders.calls.length, 0);
    const res = await req('POST', '/api/account/guest-seen', {
      headers: { Authorization: 'Bearer eyJhbGciOiJSUzI1NiJ9.e30.c2lnbmF0dXJl' }, body: { name: 'Bob' },
    });
    assert.strictEqual(res.status, 401);
  });
});

test('a parent switches to their child account and back, and the cookie comes through', async () => {
  const childCookie = 'userjwt=kid; Domain=cheetahmoongames.com; HttpOnly; Path=/; SameSite=strict';
  const bartenders = fakeBartenders({
    'POST /v1/family/switch': { body: { username: 'Kit', id: 'k1' }, cookies: [childCookie] },
    'POST /v1/family/switch-back': { body: { username: 'Mum', id: 'm1' }, cookies: [SHARED_COOKIE] },
    'GET /userDetails': { body: { username: 'Kit', id: 'k1', managed: true, parent: { id: 'm1', name: 'Mum', has_password: true, google: true } } },
  });
  await withServer(ENV, bartenders, async (req) => {
    let res = await req('POST', '/api/account/switch', { headers: { Cookie: 'userjwt=mum' }, body: { id: 'k1', next: '/' } });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.json.name, 'Kit');
    assert.ok(res.headers['set-cookie'].includes(childCookie));
    assert.deepStrictEqual(bartenders.calls[0].body, { id: 'k1' });
    assert.strictEqual(bartenders.calls[0].headers.Cookie, 'userjwt=mum');
    res = await req('GET', '/api/account/me', { headers: { Cookie: 'userjwt=kid' } });
    assert.strictEqual(res.json.childAccount, true);
    assert.deepStrictEqual(res.json.parent, { name: 'Mum', hasPassword: true, google: true });
    res = await req('POST', '/api/account/switch-back', { headers: { Cookie: 'userjwt=kid' }, body: { password: 'Password1' } });
    assert.strictEqual(res.status, 200);
    assert.ok(res.headers['set-cookie'].includes(SHARED_COOKIE));
    assert.deepStrictEqual(bartenders.calls.at(-1).body, { password: 'Password1' });
  });
});

test("switching back with the wrong password says so, and needs a cookie", async () => {
  const bartenders = fakeBartenders({
    'POST /v1/family/switch-back': { status: 400, body: { error: "That isn't your password." } },
  });
  await withServer(ENV, bartenders, async (req) => {
    let res = await req('POST', '/api/account/switch-back', { headers: { Cookie: 'userjwt=kid' }, body: { password: 'nope' } });
    assert.deepStrictEqual([res.status, res.json.error], [400, "That isn't your password."]);
    assert.strictEqual(res.headers['set-cookie'], undefined);
    res = await req('POST', '/api/account/switch-back', { body: { password: 'nope' } });
    assert.strictEqual(res.status, 401);
  });
});

test("games' pages can ask who's playing and switch to a child account, from their own subdomains only", async () => {
  const bartenders = fakeBartenders({
    'GET /userDetails': { body: { username: 'Mum', id: 'm1' } },
    'POST /v1/family/switch': { body: { username: 'Kit', id: 'k1' }, cookies: [SHARED_COOKIE] },
  });
  await withServer(ENV, bartenders, async (req) => {
    const game = { Origin: 'https://spell-battle.cheetahmoongames.com', Cookie: 'userjwt=mum' };
    let res = await req('OPTIONS', '/api/account/switch', { headers: { ...game, 'Access-Control-Request-Method': 'POST' } });
    assert.strictEqual(res.status, 204);
    assert.strictEqual(res.headers['access-control-allow-origin'], 'https://spell-battle.cheetahmoongames.com');
    assert.strictEqual(res.headers['access-control-allow-credentials'], 'true');
    res = await req('POST', '/api/account/switch', { headers: game, body: { id: 'k1' } });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.headers['access-control-allow-origin'], 'https://spell-battle.cheetahmoongames.com');
    res = await req('GET', '/api/account/me', { headers: game });
    assert.strictEqual(res.headers['access-control-allow-origin'], 'https://spell-battle.cheetahmoongames.com');
    // Not another website, nor a route games don't need.
    res = await req('GET', '/api/account/me', { headers: { Origin: 'https://evil.example', Cookie: 'userjwt=mum' } });
    assert.strictEqual(res.headers['access-control-allow-origin'], undefined);
    res = await req('GET', '/api/account/me', { headers: { Origin: 'http://spell-battle.cheetahmoongames.com', Cookie: 'userjwt=mum' } });
    assert.strictEqual(res.headers['access-control-allow-origin'], undefined);
    res = await req('POST', '/api/account/password', { headers: game, body: {} });
    assert.strictEqual(res.headers['access-control-allow-origin'], undefined);
  });
});

// --- Who's signed in, checked here (?quick=1) ---------------------------------
// The home page asks /api/account/me?quick=1: the cookie is checked with the
// key from Bartenders' database, so a sleeping Bartenders can't hold it up.

const crypto = require('crypto');

const QKID = '6c1f7a52-2a8e-4d1a-9a0c-3f2f5b0e9d11';
const qkeys = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const QPEM = qkeys.publicKey.export({ type: 'spki', format: 'pem' });
const QENV = { ...ENV, KEYS_SUPABASE_URL: 'https://abc.supabase.co', KEYS_SUPABASE_KEY: 'sb_publishable_test' };

function qtoken(claims = {}, key = qkeys.privateKey) {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const body = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({ sub: 'Ann Smith', id: 'user-1', exp: now + 3600, kid: QKID, ...claims })}`;
  return `${body}.${crypto.sign('RSA-SHA256', Buffer.from(body), key).toString('base64url')}`;
}
const dbRow = (pem) => ({ body: [{ public_key: `\\x${Buffer.from(pem).toString('hex')}` }] });

test('quick: the cookie is checked with the key from the database, without waiting for Bartenders', async () => {
  const bartenders = fakeBartenders({ 'GET /rest/v1/public_keys': dbRow(QPEM), 'GET /userDetails': { body: { username: 'Ann Smith' } } });
  await withServer(QENV, bartenders, async (req) => {
    const res = await req('GET', '/api/account/me?quick=1', { headers: { Cookie: `userjwt=${qtoken()}` } });
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(res.json, { signedIn: true, name: 'Ann Smith', id: 'user-1', next: '/', childAccount: false, quick: true });
    const db = bartenders.calls.find((c) => c.key === 'GET /rest/v1/public_keys');
    assert.strictEqual(db.headers.apikey, 'sb_publishable_test');
    assert.ok(!bartenders.calls.some((c) => c.key.startsWith('GET /v1/auth/keys/')), 'Bartenders is not asked for the key');
    await new Promise((r) => setTimeout(r, 20));
    const visit = bartenders.calls.find((c) => c.key === 'GET /userDetails');
    assert.ok(visit, 'Bartenders still hears about the visit');
    assert.strictEqual(visit.headers['X-Cheetah-Moon-Home'], '1');
  });
});

test("quick: a parent playing as their child account says so", async () => {
  const bartenders = fakeBartenders({ 'GET /rest/v1/public_keys': dbRow(QPEM) });
  await withServer(QENV, bartenders, async (req) => {
    const res = await req('GET', '/api/account/me?quick=1', { headers: { Cookie: `userjwt=${qtoken({ parent: 'parent-1' })}` } });
    assert.strictEqual(res.json.childAccount, true);
  });
});

test('quick: forged, expired and missing cookies are signed out', async () => {
  const other = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
  const bartenders = fakeBartenders({ 'GET /rest/v1/public_keys': dbRow(QPEM) });
  await withServer(QENV, bartenders, async (req) => {
    for (const cookie of [`userjwt=${qtoken({}, other)}`, `userjwt=${qtoken({ exp: 1 })}`, 'userjwt=not.a.token', '']) {
      const res = await req('GET', '/api/account/me?quick=1', { headers: cookie ? { Cookie: cookie } : {} });
      assert.deepStrictEqual(res.json, { signedIn: false }, cookie);
    }
  });
});

test("quick: if the database hasn't the key, Bartenders is asked for it", async () => {
  const bartenders = fakeBartenders({
    'GET /rest/v1/public_keys': { body: [] },
    [`GET /v1/auth/keys/${QKID}`]: { body: { kid: QKID, alg: 'RS256', pem: QPEM } },
  });
  await withServer(QENV, bartenders, async (req) => {
    const res = await req('GET', '/api/account/me?quick=1', { headers: { Cookie: `userjwt=${qtoken()}` } });
    assert.strictEqual(res.json.signedIn, true);
  });
});

test("quick: if the key can't be had at all, Bartenders answers as without quick", async () => {
  const bartenders = fakeBartenders({
    'GET /rest/v1/public_keys': { status: 503, body: {} },
    [`GET /v1/auth/keys/${QKID}`]: { status: 502, body: {} },
    'GET /userDetails': { body: { username: 'Ann Smith', id: 'user-1', email: 'ann@example.com' } },
  });
  await withServer(QENV, bartenders, async (req) => {
    const res = await req('GET', '/api/account/me?quick=1', { headers: { Cookie: `userjwt=${qtoken()}` } });
    assert.strictEqual(res.json.signedIn, true);
    assert.strictEqual(res.json.email, 'ann@example.com', 'the full answer, from Bartenders');
    assert.strictEqual(res.json.quick, undefined);
  });
});

test('the keys games fetch come from the database first, and are kept', async () => {
  const bartenders = fakeBartenders({ 'GET /rest/v1/public_keys': dbRow(QPEM) });
  await withServer(QENV, bartenders, async (req) => {
    const res = await req('GET', `/api/account/keys/${QKID}`);
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(res.json, { kid: QKID, alg: 'RS256', pem: QPEM });
    await req('GET', `/api/account/keys/${QKID}`);
    assert.strictEqual(bartenders.calls.length, 1, 'one database lookup, no Bartenders');
  });
});

test('without the database settings, me?quick=1 still checks the cookie, with the key from Bartenders', async () => {
  const bartenders = fakeBartenders({ [`GET /v1/auth/keys/${QKID}`]: { body: { kid: QKID, alg: 'RS256', pem: QPEM } } });
  await withServer(ENV, bartenders, async (req) => {
    const res = await req('GET', '/api/account/me?quick=1', { headers: { Cookie: `userjwt=${qtoken()}` } });
    assert.strictEqual(res.json.signedIn, true);
    assert.ok(!bartenders.calls.some((c) => c.key === 'GET /rest/v1/public_keys'));
  });
});
