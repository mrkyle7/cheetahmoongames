'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { createServer } = require('../server.js');

async function withServer(fn, options) {
  const server = createServer(options);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await fn(base);
  } finally {
    await new Promise((r) => server.close(r));
  }
}

test('serves the game at /', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/`);
    assert.strictEqual(res.status, 200);
    assert.match(await res.text(), /<title>[^<]+<\/title>/);
  });
});

test('health check', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/healthz`);
    assert.strictEqual(res.status, 200);
  });
});

test('paths cannot escape public/', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/..%2fserver.js`);
    assert.strictEqual(res.status, 404);
  });
});

test('/api/me says who is signed in', async () => {
  const auth = {
    player: async (req) => (req.headers.cookie === 'userjwt=ok' ? { id: 'u1', name: 'Ann' } : null),
    loginUrl: (next) => `https://cheetahmoongames.com/login?next=${encodeURIComponent(next)}`,
  };
  await withServer(async (base) => {
    const signedIn = await (await fetch(`${base}/api/me`, { headers: { cookie: 'userjwt=ok' } })).json();
    assert.deepStrictEqual(signedIn, { signedIn: true, id: 'u1', name: 'Ann' });
    const signedOut = await (await fetch(`${base}/api/me`)).json();
    assert.strictEqual(signedOut.signedIn, false);
    assert.match(signedOut.loginUrl, /^https:\/\/cheetahmoongames\.com\/login\?next=/);
  }, { auth });
});
