'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { createServer } = require('../server.js');

async function withServer(fn) {
  const server = createServer();
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
