'use strict';

// "Your games" (games.js) holds the secret keys of Bezique's and Bartenders'
// databases and can read two games' buckets. These tests keep that from
// leaking or being used for more than one signed-in player's own games. If
// one fails, fix the code: don't loosen the test. See CLAUDE.md.

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const http = require('http');
const { createServer } = require('../server.js');

const BZ_KEY = 'sb_secret_BEZIQUE_do_not_leak';
const BT_KEY = 'sb_secret_BARTENDERS_do_not_leak';
const TOKEN = 'ya29.GCS_TOKEN_do_not_leak';
const SECRETS = [BZ_KEY, BT_KEY, TOKEN];

const KID = '6c1f7a52-2a8e-4d1a-9a0c-3f2f5b0e9d11';
const keys = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const PEM = keys.publicKey.export({ type: 'spki', format: 'pem' });

const ENV = {
  BARTENDERS_URL: 'https://bartenders.cheetahmoongames.com',
  COOKIE_DOMAIN: 'cheetahmoongames.com',
  KEYS_SUPABASE_URL: 'https://keys.example',
  KEYS_SUPABASE_KEY: 'sb_publishable_ok',
  KINGS_KEEP_BUCKET: 'kk',
  SECRET_MERMAIDS_BUCKET: 'sm',
  BEZIQUE_SUPABASE_URL: 'https://bz.example',
  BEZIQUE_SUPABASE_KEY: BZ_KEY,
  BARTENDERS_SUPABASE_URL: 'https://bt.example',
  BARTENDERS_SUPABASE_KEY: BT_KEY,
};

function cookie(claims = {}) {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const body = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({ sub: 'Ann', id: 'user-1', exp: Math.floor(Date.now() / 1000) + 3600, kid: KID, ...claims })}`;
  return `userjwt=${body}.${crypto.sign('RSA-SHA256', Buffer.from(body), keys.privateKey).toString('base64url')}`;
}

const res = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

// Everything the server asks of the outside world, with the key it sent.
function backend({ failDatabases = false } = {}) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url);
    const headers = init.headers || {};
    calls.push({ host: u.host, url: String(url), headers });
    if (u.host === 'keys.example') return res([{ public_key: `\\x${Buffer.from(PEM).toString('hex')}` }]);
    if (u.host === 'storage.googleapis.com') {
      if (u.pathname === '/storage/v1/b/kk/o') {
        return res({ items: [{ name: 'tables/AAAA.json', metadata: { status: 'playing', players: '["user-1","o"]', names: '["Ann","Ola"]', turn: 'user-1', updated: '1' } }] });
      }
      return res({ items: [] });
    }
    if (u.host === 'bz.example' || u.host === 'bt.example') {
      if (failDatabases) return new Response(`oops ${headers.apikey}`, { status: 503 });
      return res([]);
    }
    return res({}, 404);
  };
  return { calls, fetchImpl };
}

async function withServer(b, fn) {
  const server = createServer(ENV, {
    fetchImpl: b.fetchImpl,
    gcsToken: async () => TOKEN,
    // Quick: a failing database gives up after a few tries.
    myGamesOptions: { quickWaitMs: 1500, retryWaitMs: 5, deadlineMs: 50 },
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  const get = (path, headers = {}) => new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path, headers }, (r) => {
      let body = '';
      r.on('data', (c) => { body += c; });
      r.on('end', () => resolve({ status: r.statusCode, headers: r.headers, body }));
    }).on('error', reject);
  });
  try {
    await fn(get);
  } finally {
    await new Promise((r) => server.close(r));
  }
}

const leaks = (text) => SECRETS.filter((s) => String(text).includes(s));
const backing = (b) => b.calls.filter((c) => c.host !== 'keys.example');

// Settle the background work and collect what was logged.
async function quietly(fn) {
  const logged = [];
  const original = console.error;
  console.error = (...args) => logged.push(args.join(' '));
  try {
    await fn();
  } finally {
    console.error = original;
  }
  return logged;
}

test('the answer has only the fields the page needs, and never a key', async () => {
  const b = backend();
  await withServer(b, async (get) => {
    const r = await get('/api/my-games', { cookie: cookie() });
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(leaks(r.body), []);
    assert.deepStrictEqual(leaks(JSON.stringify(r.headers)), []);
    const data = JSON.parse(r.body);
    assert.deepStrictEqual(Object.keys(data).sort(), ['games', 'sources']);
    for (const g of data.games) {
      assert.deepStrictEqual(Object.keys(g).sort(), ['game', 'id', 'title', 'updated', 'url', 'with', 'yourTurn']);
    }
    for (const s of Object.values(data.sources)) assert.deepStrictEqual(Object.keys(s).sort(), ['status', 'title']);
  });
});

test('no page or route hands out a key, even when the databases fail with the key in the message', async () => {
  const b = backend({ failDatabases: true });
  const logged = await quietly(() => withServer(b, async (get) => {
    for (const [path, headers] of [['/api/my-games', { cookie: cookie() }], ['/api/my-games', {}], ['/', {}], ['/healthz', {}], ['/login', {}]]) {
      const r = await get(path, headers);
      assert.deepStrictEqual(leaks(r.body), [], path);
      assert.deepStrictEqual(leaks(JSON.stringify(r.headers)), [], path);
    }
  }));
  assert.deepStrictEqual(leaks(logged.join('\n')), [], 'the log has no key');
});

test('each key goes only to its own database, and the bucket token only to Google', async () => {
  const b = backend();
  await withServer(b, (get) => get('/api/my-games', { cookie: cookie() }));
  for (const c of backing(b)) {
    const sent = JSON.stringify(c.headers);
    if (c.host === 'bz.example') assert.deepStrictEqual(leaks(sent), [BZ_KEY]);
    else if (c.host === 'bt.example') assert.deepStrictEqual(leaks(sent), [BT_KEY]);
    else if (c.host === 'storage.googleapis.com') assert.deepStrictEqual(leaks(sent), [TOKEN]);
    else assert.fail(`unexpected request to ${c.host}`);
  }
  for (const host of ['bz.example', 'bt.example', 'storage.googleapis.com']) {
    assert.ok(backing(b).some((c) => c.host === host), `${host} was asked`);
  }
});

test('nobody who is not signed in makes the server read any game', async () => {
  const b = backend();
  const other = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
  const forged = (() => {
    const [head, claims] = cookie().slice('userjwt='.length).split('.');
    const body = `${head}.${claims}`;
    return `userjwt=${body}.${crypto.sign('RSA-SHA256', Buffer.from(body), other).toString('base64url')}`;
  })();
  const expired = cookie({ exp: Math.floor(Date.now() / 1000) - 10 });
  await withServer(b, async (get) => {
    for (const headers of [{}, { cookie: 'userjwt=junk' }, { cookie: forged }, { cookie: expired }, { cookie: cookie({ id: '' }) }]) {
      assert.strictEqual((await get('/api/my-games', headers)).status, 401);
    }
  });
  assert.deepStrictEqual(backing(b), []);
});

test("a player's games are asked for by their own signed id, and nobody else's", async () => {
  const b = backend();
  await withServer(b, (get) => get('/api/my-games', { cookie: cookie({ id: 'user-7' }) }));
  const bz = b.calls.find((c) => c.host === 'bz.example');
  assert.match(bz.url, /player_ids=cs\.\{user-7\}/);
  const bt = b.calls.find((c) => c.host === 'bt.example' && c.url.includes('/rest/v1/games?'));
  assert.match(bt.url, /players=cs\.\{user-7\}/);
  // Nothing reads games without a player filter.
  for (const c of backing(b).filter((x) => x.url.includes('/rest/v1/games'))) assert.match(c.url, /(player_ids|players)=cs\./);
});

test('an account id that could change a query is refused, and no database is asked', async () => {
  for (const id of ['x},{y', 'a)&select=*', 'a,b', '../x', 'a b', 'x'.repeat(65)]) {
    const b = backend();
    await quietly(() => withServer(b, async (get) => {
      const r = await get('/api/my-games', { cookie: cookie({ id }) });
      assert.strictEqual(r.status, 200);
      const data = JSON.parse(r.body);
      assert.strictEqual(data.sources.bezique.status, 'error', id);
      assert.strictEqual(data.sources.bartenders.status, 'error', id);
    }));
    assert.ok(!b.calls.some((c) => c.host === 'bz.example' || c.host === 'bt.example'), `no query for ${JSON.stringify(id)}`);
  }
});
