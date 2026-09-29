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
    assert.deepStrictEqual(bartenders.calls[0].body, { username: 'Ann', password: 'pw12345678' });
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

test('creating an account signs the player in', async () => {
  const bartenders = fakeBartenders({
    'POST /register': { status: 201, body: { username: 'New Player', id: 'u2' }, cookies: [SHARED_COOKIE] },
  });
  await withServer(ENV, bartenders, async (req) => {
    const res = await req('POST', '/api/account/register', {
      body: { username: 'New Player', email: 'np@example.com', password: 'abcdefg1' },
    });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.json.name, 'New Player');
    assert.strictEqual(res.json.next, '/');
    assert.ok(res.headers['set-cookie'].includes(SHARED_COOKIE));
    assert.deepStrictEqual(bartenders.calls[0].body, { username: 'New Player', password: 'abcdefg1', email: 'np@example.com' });
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
    assert.deepStrictEqual(res.json, { signedIn: true, name: 'Ann', id: 'u1', next: '/' });
    assert.strictEqual(bartenders.calls[0].headers.Cookie, 'userjwt=tok');
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
