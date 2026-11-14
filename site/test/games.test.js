'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { createMyGames, mermaidsAwaiting } = require('../games.js');

const ME = { id: 'me-1', name: 'Kyle' };
const ENV = {
  KINGS_KEEP_BUCKET: 'kk', SECRET_MERMAIDS_BUCKET: 'sm',
  BEZIQUE_SUPABASE_URL: 'https://bz.example', BEZIQUE_SUPABASE_KEY: 'bz-key',
  BARTENDERS_SUPABASE_URL: 'https://bt.example/', BARTENDERS_SUPABASE_KEY: 'bt-key',
};

const json = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });

// A fake Cloud Storage and two fake Supabase projects.
function world(over = {}) {
  const calls = [];
  const w = {
    calls,
    kk: [
      { name: 'tables/AAAA.json', metadata: { status: 'playing', players: JSON.stringify(['me-1', 'x']), names: JSON.stringify(['Kyle', 'Ann']), turn: 'me-1', updated: '5' } },
      { name: 'tables/BBBB.json', metadata: { status: 'playing', players: JSON.stringify(['me-1', 'x']), names: JSON.stringify(['Kyle', 'Bob']), turn: 'x', updated: '9' } },
      { name: 'tables/CCCC.json', metadata: { status: 'over', players: JSON.stringify(['me-1']), names: '[]', turn: '', updated: '1' } },
      { name: 'tables/DDDD.json', metadata: { status: 'playing', players: JSON.stringify(['y']), names: '["Y"]', turn: 'y', updated: '1' } },
    ],
    sm: {
      'games/m1.json': { generation: '1', game: { started: true, over: false, step: 'trick', trick: { order: ['z', 'me-1'], plays: [{}] }, players: [{ id: 'z', name: 'Zed' }, { id: 'me-1', name: 'Kyle' }, { id: 'bot', name: 'Bot', isBot: true }], updatedAt: 7 } },
      'games/m2.json': { generation: '1', game: { started: true, over: true, step: 'over', players: [{ id: 'me-1', name: 'Kyle' }] } },
      'games/m3.json': { generation: '1', game: { started: false, players: [{ id: 'me-1', name: 'Kyle' }] } },
    },
    bezique: [
      { id: 'b1', updated_at: '2026-11-01T10:00:00Z', started: true, over: false, players: [{ id: 'me-1', name: 'Kyle', cardsSelectableForTrick: true }, { id: 'q', name: 'Quinn' }] },
      { id: 'b2', updated_at: '2026-11-02T10:00:00Z', started: true, over: true, players: [] },
      { id: 'b3', updated_at: '2026-11-03T10:00:00Z', started: false, over: false, players: [] },
    ],
    bartenders: [
      { id: 'g1', players: ['ME-1', 'u2'], created_at: '2026-11-01T00:00:00Z', turn: 'u2', winner: null },
      { id: 'g2', players: ['me-1', 'u3'], created_at: '2026-11-02T00:00:00Z', turn: 'me-1', winner: null },
    ],
    dbDown: 0, // how many database requests fail before it's awake
    ...over,
  };
  w.fetchImpl = async (url, init = {}) => {
    url = String(url);
    calls.push(url);
    if (url.startsWith('https://storage.googleapis.com/storage/v1/b/kk/o?')) return json({ items: w.kk });
    if (url.startsWith('https://storage.googleapis.com/storage/v1/b/sm/o?')) {
      return json({ items: Object.entries(w.sm).map(([name, f]) => ({ name, generation: f.generation })) });
    }
    const m = /\/b\/sm\/o\/([^?]+)\?alt=media/.exec(url);
    if (m) {
      const f = w.sm[decodeURIComponent(m[1])];
      return f ? json(f.game) : json({}, 404);
    }
    if (url.includes('.example/')) {
      if (w.dbDown > 0) { w.dbDown--; return json({}, 503); }
      assert.ok(init.headers.apikey, 'sends the key');
      if (url.startsWith('https://bz.example/rest/v1/games?')) {
        assert.match(url, /player_ids=cs\.\{[a-z0-9-]+\}/);
        return json(w.bezique);
      }
      if (url.startsWith('https://bt.example/rest/v1/games?')) return json(w.bartenders);
      if (url.startsWith('https://bt.example/rest/v1/users?')) return json([{ id: 'u2', username: 'Una' }, { id: 'u3', username: 'Uri' }]);
    }
    throw new Error(`unexpected request ${url}`);
  };
  return w;
}

const make = (w, opts = {}) => createMyGames({
  env: ENV, fetchImpl: w.fetchImpl, getToken: async () => 'tok', quickWaitMs: 500, retryWaitMs: 5, deadlineMs: 2000, ...opts,
});

test('finds the games in progress in all four games and whose turn it is', async () => {
  const mine = await make(world()).list(ME);
  assert.deepStrictEqual(mine.sources, {
    'kings-keep': { title: "King's Keep", status: 'ok' },
    'secret-mermaids': { title: 'Secret Mermaids', status: 'ok' },
    bezique: { title: 'Bezique', status: 'ok' },
    bartenders: { title: 'Bartenders of Corfu', status: 'ok' },
  });
  const by = Object.fromEntries(mine.games.map((g) => [`${g.game}/${g.id}`, g]));
  assert.deepStrictEqual(Object.keys(by).sort(), ['bartenders/g1', 'bartenders/g2', 'bezique/b1', 'kings-keep/AAAA', 'kings-keep/BBBB', 'secret-mermaids/m1']);
  assert.strictEqual(by['kings-keep/AAAA'].yourTurn, true);
  assert.strictEqual(by['kings-keep/BBBB'].yourTurn, false);
  assert.deepStrictEqual(by['kings-keep/AAAA'].with, ['Ann']);
  assert.strictEqual(by['kings-keep/AAAA'].url, 'https://kings-keep.cheetahmoongames.com/r/AAAA');
  assert.strictEqual(by['secret-mermaids/m1'].yourTurn, true);
  assert.deepStrictEqual(by['secret-mermaids/m1'].with, ['Zed']);
  assert.strictEqual(by['secret-mermaids/m1'].url, 'https://secret-mermaids.cheetahmoongames.com/game/m1');
  assert.strictEqual(by['bezique/b1'].yourTurn, true);
  assert.deepStrictEqual(by['bezique/b1'].with, ['Quinn']);
  assert.strictEqual(by['bezique/b1'].url, 'https://bezique.cheetahmoongames.com/game/b1');
  assert.strictEqual(by['bartenders/g1'].yourTurn, false);
  assert.deepStrictEqual(by['bartenders/g1'].with, ['Una']);
  assert.strictEqual(by['bartenders/g2'].yourTurn, true);
  assert.strictEqual(by['bartenders/g2'].url, 'https://bartenders.cheetahmoongames.com/bar?id=g2');
  // Their turn last: the games waiting on you come first.
  const turns = mine.games.map((g) => g.yourTurn);
  assert.deepStrictEqual(turns, [...turns].sort((a, b) => Number(b) - Number(a)));
});

test('a game this player is not in is not listed', async () => {
  const w = world({ bezique: [], bartenders: [] });
  const mine = await make(w).list({ id: 'nobody', name: 'Nobody' });
  assert.deepStrictEqual(mine.games, []);
});

test('a source with no settings is left out', async () => {
  const mine = await createMyGames({ env: { KINGS_KEEP_BUCKET: 'kk', BEZIQUE_SUPABASE_URL: 'not-set', BEZIQUE_SUPABASE_KEY: 'not-set' }, fetchImpl: world().fetchImpl, getToken: async () => 't' }).list(ME);
  assert.deepStrictEqual(Object.keys(mine.sources), ['kings-keep']);
});

test('a database that is slow to wake is pending, keeps being tried, and then answers', async () => {
  const w = world({ dbDown: 6 });
  const games = make(w, { quickWaitMs: 20, retryWaitMs: 30 });
  const first = await games.list(ME);
  assert.strictEqual(first.sources.bezique.status, 'pending');
  assert.strictEqual(first.sources['kings-keep'].status, 'ok');
  assert.ok(first.games.some((g) => g.game === 'kings-keep'), 'the quick ones are already there');
  assert.ok(!first.games.some((g) => g.game === 'bezique'));
  // Asking again joins the attempts in progress instead of starting more.
  let last = first;
  for (let i = 0; i < 100 && Object.values(last.sources).some((s) => s.status === 'pending'); i++) last = await games.list(ME);
  assert.deepStrictEqual(Object.values(last.sources).map((s) => s.status), ['ok', 'ok', 'ok', 'ok']);
  assert.ok(last.games.some((g) => g.game === 'bezique'));
  assert.ok(last.games.some((g) => g.game === 'bartenders'));
});

test('a source that gives up reports an error, and the others still answer', async () => {
  const w = world({ dbDown: 1e9 });
  const mine = await make(w, { deadlineMs: 60, quickWaitMs: 2000 }).list(ME);
  assert.strictEqual(mine.sources.bezique.status, 'error');
  assert.strictEqual(mine.sources.bartenders.status, 'error');
  assert.strictEqual(mine.sources['kings-keep'].status, 'ok');
  assert.ok(mine.games.length >= 3);
});

test('a refusal is not retried', async () => {
  const w = world();
  const fetchImpl = async (url, init) => (String(url).startsWith('https://bz.example') ? json({}, 401) : w.fetchImpl(url, init));
  const games = createMyGames({ env: { BEZIQUE_SUPABASE_URL: 'https://bz.example', BEZIQUE_SUPABASE_KEY: 'k' }, fetchImpl, retryWaitMs: 5, deadlineMs: 5000 });
  const mine = await games.list(ME);
  assert.strictEqual(mine.sources.bezique.status, 'error');
});

test('Secret Mermaids games are read again only when their file changes', async () => {
  const w = world();
  const games = make(w);
  await games.list(ME);
  const reads = () => w.calls.filter((u) => u.includes('alt=media')).length;
  assert.strictEqual(reads(), 3);
  // Wait out the freshness window by asking a second player.
  await games.list({ id: 'z', name: 'Zed' });
  assert.strictEqual(reads(), 3);
  w.sm['games/m1.json'] = { generation: '2', game: { ...w.sm['games/m1.json'].game, trick: { order: ['z', 'me-1'], plays: [] } } };
  const zed = await games.list({ id: 'z', name: 'Zed' });
  assert.strictEqual(reads(), 3, 'fresh answers are reused for the same player');
  assert.ok(zed.games.some((g) => g.game === 'secret-mermaids'));
  const other = await games.list({ id: 'someone', name: 'S' });
  assert.strictEqual(reads(), 4);
  assert.ok(!other.games.some((g) => g.game === 'secret-mermaids'));
});

test("Secret Mermaids' awaiting() is the game's own", () => {
  assert.deepStrictEqual(mermaidsAwaiting({ step: 'trick', trick: { order: ['a', 'b', 'c'], plays: [1] } }), ['b']);
  assert.deepStrictEqual(mermaidsAwaiting({ step: 'meld', meld: { player: 'c' } }), ['c']);
  assert.deepStrictEqual(mermaidsAwaiting({ step: 'vote', tide: { voters: ['a', 'b'], votes: { a: 'x' } } }), ['b']);
  assert.deepStrictEqual(mermaidsAwaiting({ step: 'council', players: [{ id: 'a' }, { id: 'b' }], council: { gifts: { a: {} } } }), ['b']);
  assert.deepStrictEqual(mermaidsAwaiting({ step: 'trickDone' }), []);
});
