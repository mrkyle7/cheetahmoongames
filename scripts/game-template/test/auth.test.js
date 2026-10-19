'use strict';

// Tokens here are made the way the accounts service makes them (RS256, with the
// key id in the claims), signed with a throwaway key.

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const { createAuth } = require('../auth.js');

const KID = '6c1f7a52-2a8e-4d1a-9a0c-3f2f5b0e9d11';
const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const PEM = publicKey.export({ type: 'spki', format: 'pem' });

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');

function token(claims = {}, { header = { alg: 'RS256', typ: 'JWT' }, key = privateKey } = {}) {
  const now = Math.floor(Date.now() / 1000);
  const body = `${b64(header)}.${b64({ sub: 'Ann Smith', id: 'user-1', iat: now, exp: now + 3600, kid: KID, ...claims })}`;
  return `${body}.${crypto.sign('RSA-SHA256', Buffer.from(body), key).toString('base64url')}`;
}

function auth(opts = {}) {
  const lookups = [];
  const a = createAuth({
    accountsUrl: 'https://cheetahmoongames.com/',
    fetchKey: async (kid) => { lookups.push(kid); return kid === KID ? PEM : null; },
    ...opts,
  });
  a.lookups = lookups;
  return a;
}

const req = (cookie) => ({ headers: { cookie } });

test('a signed-in player is recognised from the shared cookie', async () => {
  const a = auth();
  assert.deepStrictEqual(await a.player(req(`theme=dark; userjwt=${token()}`)), { id: 'user-1', name: 'Ann Smith' });
});

test('the signing key is fetched once', async () => {
  const a = auth();
  await Promise.all([a.player(req(`userjwt=${token()}`)), a.player(req(`userjwt=${token()}`))]);
  await a.player(req(`userjwt=${token()}`));
  assert.deepStrictEqual(a.lookups, [KID]);
});

test('no cookie means nobody is signed in', async () => {
  assert.strictEqual(await auth().player(req(undefined)), null);
  assert.strictEqual(await auth().player({ headers: {} }), null);
});

test('forged, tampered, expired and malformed tokens are refused', async () => {
  const a = auth();
  const other = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
  const good = token();
  const [h, , s] = good.split('.');
  const bad = [
    token({}, { key: other }), // signed by someone else
    `${h}.${b64({ sub: 'Admin', id: 'user-1', exp: 9999999999, kid: KID })}.${s}`, // claims changed
    token({ exp: Math.floor(Date.now() / 1000) - 1 }), // expired
    token({ exp: undefined }), // never expires
    token({ kid: '00000000-0000-0000-0000-000000000000' }), // unknown key
    token({ kid: '../../etc' }),
    token({ id: '' }),
    token({}, { header: { alg: 'none' } }),
    token({}, { header: { alg: 'HS256' } }),
    'not.a.token', 'nope', '', 'a.b.c.d',
  ];
  for (const t of bad) assert.strictEqual(await a.verify(t), null, t);
});

test('if the accounts service is down nobody is signed in, and it is asked again next time', async () => {
  let up = false;
  const a = createAuth({
    fetchKey: async () => { if (!up) throw new Error('ECONNREFUSED'); return PEM; },
  });
  const errors = [];
  const orig = console.error;
  console.error = (m) => errors.push(m);
  try {
    assert.strictEqual(await a.verify(token()), null);
  } finally {
    console.error = orig;
  }
  assert.strictEqual(errors.length, 1);
  up = true;
  assert.deepStrictEqual(await a.verify(token()), { id: 'user-1', name: 'Ann Smith' });
});

test('sign-in links come back to the game', () => {
  assert.strictEqual(
    auth().loginUrl('https://snap.cheetahmoongames.com/room/1'),
    'https://cheetahmoongames.com/login?next=https%3A%2F%2Fsnap.cheetahmoongames.com%2Froom%2F1',
  );
});

// --- Telling the accounts service a player was seen -----------------------------

function reporting(opts = {}) {
  const reports = [];
  let clock = 1_000_000;
  const a = auth({
    place: 'snap',
    now: () => clock,
    reportSeen: async (tok, place) => { reports.push({ tok, place }); },
    ...opts,
  });
  a.reports = reports;
  a.advance = (ms) => { clock += ms; };
  return a;
}

const settle = () => new Promise((r) => setImmediate(r));

test('a signed-in player is reported as seen, with their own cookie and the game', async () => {
  const a = reporting();
  const t = token();
  await a.player(req(`userjwt=${t}`));
  await settle();
  assert.deepStrictEqual(a.reports, [{ tok: t, place: 'snap' }]);
});

test('a player is reported at most every 5 minutes', async () => {
  const a = reporting();
  for (let i = 0; i < 20; i++) {
    await a.player(req(`userjwt=${token()}`));
    a.advance(10_000);
  }
  await settle();
  assert.strictEqual(a.reports.length, 1);
  a.advance(5 * 60 * 1000);
  await a.player(req(`userjwt=${token()}`));
  await settle();
  assert.strictEqual(a.reports.length, 2);
});

test('each player is reported on their own', async () => {
  const a = reporting();
  await a.player(req(`userjwt=${token({ id: 'user-1' })}`));
  await a.player(req(`userjwt=${token({ id: 'user-2', sub: 'Bob' })}`));
  await settle();
  assert.strictEqual(a.reports.length, 2);
});

test('nobody is reported for a missing or bad cookie, or without a game name', async () => {
  const a = reporting();
  await a.player(req(''));
  await a.player(req(`userjwt=${token({ exp: 1 })}`));
  const local = reporting({ place: null });
  await local.player(req(`userjwt=${token()}`));
  await settle();
  assert.deepStrictEqual([a.reports, local.reports], [[], []]);
});

test("a failed report doesn't hold up or break signing in", async () => {
  const errors = [];
  const original = console.error;
  console.error = (m) => errors.push(m);
  try {
    const a = reporting({ reportSeen: async () => { throw new Error('down'); } });
    assert.deepStrictEqual(await a.player(req(`userjwt=${token()}`)), { id: 'user-1', name: 'Ann Smith' });
    await settle();
    assert.match(errors[0], /couldn't report a player as seen: down/);
  } finally {
    console.error = original;
  }
});

// --- Guests ------------------------------------------------------------------------

function guests(opts = {}) {
  const reports = [];
  let clock = 1_000_000;
  const a = auth({ place: 'snap', now: () => clock, reportGuest: async (name) => { reports.push(name); }, ...opts });
  a.reports = reports;
  a.advance = (ms) => { clock += ms; };
  return a;
}

test('a guest is reported by name, at most every 5 minutes', async () => {
  const a = guests();
  a.guestSeen(' Bob ');
  a.guestSeen('bob');
  a.guestSeen('Ann');
  await settle();
  assert.deepStrictEqual(a.reports, ['Bob', 'Ann']);
  a.advance(5 * 60 * 1000);
  a.guestSeen('Bob');
  await settle();
  assert.deepStrictEqual(a.reports, ['Bob', 'Ann', 'Bob']);
});

test('a guest with no name is reported as Guest, and nothing is reported locally', async () => {
  const a = guests();
  a.guestSeen('');
  const local = guests({ place: null });
  local.guestSeen('Bob');
  await settle();
  assert.deepStrictEqual([a.reports, local.reports], [['Guest'], []]);
});

test("a failed guest report doesn't throw", async () => {
  const errors = [];
  const original = console.error;
  console.error = (m) => errors.push(m);
  try {
    const a = guests({ reportGuest: async () => { throw new Error('down'); } });
    assert.doesNotThrow(() => a.guestSeen('Bob'));
    await settle();
    assert.match(errors[0], /couldn't report a guest as seen: down/);
  } finally {
    console.error = original;
  }
});

test("a guest report asks Cloud Run's metadata server for this service's identity token", async () => {
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), headers: init && init.headers });
    if (String(url).startsWith('http://metadata.google.internal/')) return new Response('id.token.value\n');
    return new Response('{"ok":true}', { status: 202 });
  };
  try {
    const a = createAuth({ accountsUrl: 'https://cheetahmoongames.com', place: 'snap' });
    a.guestSeen('Bob');
    await new Promise((r) => setTimeout(r, 20));
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.strictEqual(
    calls[0].url,
    'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity'
      + '?audience=https%3A%2F%2Fcheetahmoongames.com&format=full',
  );
  assert.strictEqual(calls[0].headers['Metadata-Flavor'], 'Google');
  assert.strictEqual(calls[1].url, 'https://cheetahmoongames.com/api/account/guest-seen');
  assert.strictEqual(calls[1].headers.Authorization, 'Bearer id.token.value');
});
