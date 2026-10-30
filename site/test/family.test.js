'use strict';

const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const { createServer } = require('../server.js');
const { createLinks } = require('../family.js');

const ENV = { BARTENDERS_URL: 'https://bartenders.cheetahmoongames.com', COOKIE_DOMAIN: 'cheetahmoongames.com' };
const PEOPLE = {
  mum: { id: 1, username: 'Mum', email: 'mum@example.com' },
  zed: { id: 2, username: 'Zed', email: 'Zed@Example.com' },
  lou: { id: 3, username: 'Lou', email: 'lou@example.com' },
};

// Bartenders, answering /userDetails for each person's cookie.
async function fetchImpl(url, init) {
  const cookie = (init.headers.Cookie || '').replace('userjwt=', '');
  if (new URL(url).pathname !== '/userDetails' || !PEOPLE[cookie]) return new Response('{}', { status: 401 });
  return new Response(JSON.stringify(PEOPLE[cookie]), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

async function withSite(fn) {
  const server = createServer(ENV, { fetchImpl, links: createLinks() });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  const as = (who) => (method, path, body) => new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1', port, method, path,
      headers: { ...(who ? { Cookie: `userjwt=${who}` } : {}), ...(data ? { 'Content-Type': 'application/json' } : {}) },
    }, (res) => {
      let text = '';
      res.on('data', (c) => { text += c; });
      res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(text || 'null') }));
    });
    req.on('error', reject);
    req.end(data);
  });
  try {
    await fn(as);
  } finally {
    await new Promise((r) => server.close(r));
  }
}

test('a parent asks for a child by email, and sees them once the child says yes', () => withSite(async (as) => {
  const mum = as('mum');
  const zed = as('zed');
  assert.strictEqual((await as(null)('GET', '/api/family')).status, 401);
  assert.strictEqual((await mum('POST', '/api/family/ask', { email: 'nope' })).status, 400);
  assert.strictEqual((await mum('POST', '/api/family/ask', { email: 'mum@example.com' })).status, 400, 'not yourself');
  let r = await mum('POST', '/api/family/ask', { email: 'zed@example.com' });
  assert.deepStrictEqual(r.json.asked, ['zed@example.com']);
  assert.deepStrictEqual(r.json.children, []);
  // Nothing's shared yet.
  assert.deepStrictEqual((await mum('GET', '/api/family/children')).json, { children: [] });
  // Zed sees who's asking (whatever case his email's in), and says yes.
  r = await zed('GET', '/api/family');
  assert.deepStrictEqual(r.json.requests, [{ id: '1', name: 'Mum' }]);
  r = await zed('POST', '/api/family/answer', { parent: '1', allow: true });
  assert.deepStrictEqual(r.json.parents, [{ id: '1', name: 'Mum' }]);
  assert.deepStrictEqual(r.json.requests, []);
  r = await mum('GET', '/api/family');
  assert.deepStrictEqual(r.json.children, [{ id: '2', name: 'Zed' }]);
  assert.deepStrictEqual(r.json.asked, []);
  assert.deepStrictEqual((await mum('GET', '/api/family/children')).json, { children: [{ id: '2', name: 'Zed' }] });
  // Either of them can undo it.
  await zed('POST', '/api/family/remove', { id: '1' });
  assert.deepStrictEqual((await mum('GET', '/api/family/children')).json, { children: [] });
}));

test('a child can say no, and nobody can answer for someone else', () => withSite(async (as) => {
  const mum = as('mum');
  await mum('POST', '/api/family/ask', { email: 'lou@example.com' });
  assert.strictEqual((await as('zed')('POST', '/api/family/answer', { parent: '1', allow: true })).status, 400);
  const r = await as('lou')('POST', '/api/family/answer', { parent: '1', allow: false });
  assert.deepStrictEqual(r.json.parents, []);
  const view = (await mum('GET', '/api/family')).json;
  assert.deepStrictEqual([view.children, view.asked], [[], []]);
}));

test('a parent can stop asking', () => withSite(async (as) => {
  await as('mum')('POST', '/api/family/ask', { email: 'lou@example.com' });
  await as('mum')('POST', '/api/family/unask', { email: 'lou@example.com' });
  assert.deepStrictEqual((await as('lou')('GET', '/api/family')).json.requests, []);
}));
