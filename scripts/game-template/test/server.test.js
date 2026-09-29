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

test('links back to Cheetah Moon Games and shows who is signed in', async () => {
  await withServer(async (base) => {
    const html = await (await fetch(`${base}/`)).text();
    assert.match(html, /href="https:\/\/cheetahmoongames\.com\/"/);
    assert.match(html, /fetch\('\/api\/me'\)/);
  });
});

test('installable: icons, manifest and service worker are served', async () => {
  await withServer(async (base) => {
    const html = await (await fetch(`${base}/`)).text();
    for (const ref of ['/icon.svg', '/icons/apple-touch-icon.png', '/manifest.webmanifest']) {
      assert.ok(html.includes(`href="${ref}"`), `page links ${ref}`);
    }
    const manifestRes = await fetch(`${base}/manifest.webmanifest`);
    assert.strictEqual(manifestRes.headers.get('content-type'), 'application/manifest+json');
    const manifest = await manifestRes.json();
    assert.strictEqual(manifest.start_url, '/');
    assert.strictEqual(manifest.display, 'standalone');
    const sizes = manifest.icons.map((i) => i.sizes);
    assert.ok(sizes.includes('192x192') && sizes.includes('512x512'), 'Chrome needs 192 and 512 px icons');
    assert.ok(manifest.icons.some((i) => i.purpose === 'maskable'));
    for (const icon of [...manifest.icons, { src: '/icons/apple-touch-icon.png' }]) {
      const res = await fetch(base + icon.src);
      assert.strictEqual(res.status, 200, icon.src);
      if (icon.src.endsWith('.png')) {
        const bytes = new Uint8Array(await res.arrayBuffer());
        assert.deepStrictEqual([...bytes.slice(1, 4)], [0x50, 0x4e, 0x47], `${icon.src} is a PNG`);
      }
    }
    const sw = await fetch(`${base}/sw.js`);
    assert.match(sw.headers.get('content-type'), /javascript/);
    assert.match(await sw.text(), /offline\.html/);
    assert.strictEqual((await fetch(`${base}/offline.html`)).status, 200);
  });
});
