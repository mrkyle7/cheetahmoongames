'use strict';

const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const { createServer } = require('../server.js');

const ENV = {
  BARTENDERS_URL: 'https://bartenders.cheetahmoongames.com/',
  COOKIE_DOMAIN: 'cheetahmoongames.com',
};

async function withServer(env, fn) {
  const server = createServer(env);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  // Raw http so redirects are not followed and every Set-Cookie is visible.
  const request = (method, path, headers = {}) => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path, headers }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end();
  });
  try {
    await fn(request);
  } finally {
    await new Promise((r) => server.close(r));
  }
}

test('serves the home page with links to every game', async () => {
  await withServer(ENV, async (get) => {
    const res = await get('GET', '/');
    assert.strictEqual(res.status, 200);
    assert.match(res.headers['content-type'], /text\/html/);
    assert.match(res.body, /Cheetah Moon Games/);
    assert.match(res.body, /https:\/\/bartenders\.cheetahmoongames\.com\//);
    assert.match(res.body, /https:\/\/boxer\.cheetahmoongames\.com\//);
    assert.match(res.headers['strict-transport-security'], /includeSubDomains/);
    assert.strictEqual(res.headers['set-cookie'], undefined);
  });
});

test('every image the home page references is served', async () => {
  await withServer(ENV, async (get) => {
    const page = await get('GET', '/');
    const refs = [...page.body.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].map((m) => m[1]);
    assert.ok(refs.length >= 2);
    for (const ref of refs) {
      const res = await get('GET', ref);
      assert.strictEqual(res.status, 200, ref);
      assert.match(res.headers['cache-control'], /max-age/);
    }
  });
});

test('old Bartenders links redirect to the subdomain, keeping path and query', async () => {
  await withServer(ENV, async (get) => {
    const res = await get('GET', '/game?id=abc-123');
    assert.strictEqual(res.status, 307);
    assert.strictEqual(res.headers.location, 'https://bartenders.cheetahmoongames.com/game?id=abc-123');
    // Old Bartenders asset URLs go there too; only /assets/ belongs to this site.
    const asset = await get('GET', '/static/bartenders.png');
    assert.strictEqual(asset.headers.location, 'https://bartenders.cheetahmoongames.com/static/bartenders.png');
  });
});

test('posts redirect with 307 so the method is kept', async () => {
  await withServer(ENV, async (get) => {
    const res = await get('POST', '/login');
    assert.strictEqual(res.status, 307);
    assert.strictEqual(res.headers.location, 'https://bartenders.cheetahmoongames.com/login');
  });
});

test('serves a service worker that unregisters itself', async () => {
  await withServer(ENV, async (get) => {
    const res = await get('GET', '/sw.js');
    assert.strictEqual(res.status, 200);
    assert.match(res.headers['content-type'], /javascript/);
    assert.match(res.body, /unregister\(\)/);
  });
});

test('moves an old host-only login cookie onto the shared domain', async () => {
  await withServer(ENV, async (get) => {
    for (const path of ['/', '/game?id=1']) {
      const res = await get('GET', path, { cookie: 'theme=dark; userjwt=tok123' });
      const [del, set] = res.headers['set-cookie'];
      assert.match(del, /^userjwt=""; Max-Age=0/);
      assert.doesNotMatch(del, /Domain/);
      assert.match(set, /^userjwt=tok123; Domain=cheetahmoongames\.com; HttpOnly; Max-Age=1209600/);
      assert.match(set, /SameSite=Strict/);
    }
  });
});

test('with both copies present only the stale host-only cookie is removed', async () => {
  await withServer(ENV, async (get) => {
    const res = await get('GET', '/', { cookie: 'userjwt=old; userjwt=new' });
    assert.deepStrictEqual(res.headers['set-cookie'], ['userjwt=""; Max-Age=0; Path=/; SameSite=Lax']);
  });
});

test('no cookie changes without a login or without COOKIE_DOMAIN', async () => {
  await withServer(ENV, async (get) => {
    const res = await get('GET', '/', { cookie: 'theme=dark' });
    assert.strictEqual(res.headers['set-cookie'], undefined);
  });
  await withServer({ BARTENDERS_URL: ENV.BARTENDERS_URL }, async (get) => {
    const res = await get('GET', '/', { cookie: 'userjwt=tok' });
    assert.strictEqual(res.headers['set-cookie'], undefined);
  });
});

test('asset paths cannot escape the assets folder', async () => {
  await withServer(ENV, async (get) => {
    for (const p of ['/assets/..%2fserver.js', '/assets/..%2f..%2fpackage.json', '/assets/', '/assets/%E0%A4%A']) {
      const res = await get('GET', p);
      assert.strictEqual(res.status, 404, p);
    }
  });
});

test('without BARTENDERS_URL unknown paths are 404s', async () => {
  await withServer({}, async (get) => {
    assert.strictEqual((await get('GET', '/game')).status, 404);
    assert.strictEqual((await get('GET', '/')).status, 200);
  });
});

test('health check', async () => {
  await withServer(ENV, async (get) => {
    const res = await get('GET', '/healthz');
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body, 'ok');
  });
});
