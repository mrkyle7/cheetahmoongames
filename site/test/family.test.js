'use strict';

const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const { createServer } = require('../server.js');

const ENV = { BARTENDERS_URL: 'https://bartenders.cheetahmoongames.com', COOKIE_DOMAIN: 'cheetahmoongames.com' };
const VIEW = { me: { id: 'u1', name: 'Mum' }, children: [], asked: ['zed@example.com'], requests: [], parents: [] };

// Bartenders, keeping families: answers its /v1/family routes, and notes
// what it was asked.
function fakeBartenders() {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const u = new URL(url);
    const cookie = (init.headers.Cookie || '').replace('userjwt=', '');
    calls.push({ key: `${init.method} ${u.pathname}`, cookie, body: init.body ? JSON.parse(init.body) : undefined });
    if (cookie !== 'mum') return new Response(JSON.stringify({ error: 'Authentication required' }), { status: 401 });
    if (u.pathname === '/v1/family/ask' && !String(JSON.parse(init.body).email).includes('@')) {
      return new Response(JSON.stringify({ error: "That doesn't look like an email address." }), { status: 400 });
    }
    if (u.pathname === '/v1/family/children') return new Response(JSON.stringify({ children: [{ id: 'u2', name: 'Zed' }] }), { status: 200 });
    if (u.pathname === '/v1/family/boom') return new Response('{}', { status: 500 });
    return new Response(JSON.stringify(VIEW), { status: 200 });
  };
  return { fetchImpl, calls };
}

async function withSite(bartenders, fn, env = ENV) {
  const server = createServer(env, { fetchImpl: bartenders.fetchImpl });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  const ask = (method, path, { cookie, body } = {}) => new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1', port, method, path,
      headers: { ...(cookie ? { Cookie: `userjwt=${cookie}` } : {}), ...(data ? { 'Content-Type': 'application/json' } : {}) },
    }, (res) => {
      let text = '';
      res.on('data', (c) => { text += c; });
      res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(text || 'null') }));
    });
    req.on('error', reject);
    req.end(data);
  });
  try {
    await fn(ask);
  } finally {
    await new Promise((r) => server.close(r));
  }
}

test("family requests go to Bartenders, with the player's cookie", async () => {
  const b = fakeBartenders();
  await withSite(b, async (ask) => {
    assert.deepStrictEqual((await ask('GET', '/api/family', { cookie: 'mum' })).json, VIEW);
    assert.deepStrictEqual((await ask('GET', '/api/family/children', { cookie: 'mum' })).json, { children: [{ id: 'u2', name: 'Zed' }] });
    await ask('POST', '/api/family/ask', { cookie: 'mum', body: { email: 'zed@example.com' } });
    await ask('POST', '/api/family/answer', { cookie: 'mum', body: { parent: 'u9', allow: true } });
    await ask('POST', '/api/family/unask', { cookie: 'mum', body: { email: 'zed@example.com' } });
    await ask('POST', '/api/family/remove', { cookie: 'mum', body: { id: 'u2' } });
  });
  assert.deepStrictEqual(b.calls.map((c) => [c.key, c.cookie]), [
    ['GET /v1/family', 'mum'],
    ['GET /v1/family/children', 'mum'],
    ['POST /v1/family/ask', 'mum'],
    ['POST /v1/family/answer', 'mum'],
    ['POST /v1/family/unask', 'mum'],
    ['POST /v1/family/remove', 'mum'],
  ]);
  assert.deepStrictEqual(b.calls[3].body, { parent: 'u9', allow: true });
});

test("signing in first, Bartenders' reasons, and nothing else passed on", async () => {
  const b = fakeBartenders();
  await withSite(b, async (ask) => {
    assert.strictEqual((await ask('GET', '/api/family')).status, 401);
    assert.strictEqual(b.calls.length, 0, 'no cookie, nothing asked');
    assert.strictEqual((await ask('GET', '/api/family', { cookie: 'stranger' })).status, 401);
    const bad = await ask('POST', '/api/family/ask', { cookie: 'mum', body: { email: 'nope' } });
    assert.deepStrictEqual([bad.status, bad.json], [400, { error: "That doesn't look like an email address." }]);
    assert.strictEqual((await ask('GET', '/api/family/ask', { cookie: 'mum' })).status, 404);
    assert.strictEqual((await ask('POST', '/api/family/boom', { cookie: 'mum', body: {} })).status, 404);
  });
});

test('without Bartenders, families are unavailable', async () => {
  await withSite(fakeBartenders(), async (ask) => {
    assert.strictEqual((await ask('GET', '/api/family', { cookie: 'mum' })).status, 503);
  }, {});
});
