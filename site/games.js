'use strict';

// "Your games": the games a signed-in player is in the middle of, across the
// turn-based games, and whether it's their turn in each. The home page shows
// them (GET /api/my-games, see server.js).
//
// Each game keeps its tables somewhere of its own, and this reads them there
// directly, read-only, rather than waking every game's server:
//
//   King's Keep      bucket, tables/<code>.json: each file's metadata says who's
//                    seated and whose turn it is, so one listing is enough
//   Secret Mermaids  bucket, games/<id>.json: no metadata, so each game is read
//                    (and kept by file generation, so it's read again only
//                    when it changes) and who it's waiting for worked out
//   Bezique          its Supabase project's games table (PostgREST)
//   Bartenders       its Supabase project's games table (PostgREST)
//
// Supabase projects sleep when nobody's about and can take a minute or more
// to wake. So a source is never waited on for long: a request waits a few
// seconds for what's quick, answers with the rest "pending", and the page
// asks again. Meanwhile the slow source keeps trying in the background (each
// attempt has its own timeout, and it retries until a long deadline), and its
// answer is there for the next ask.
//
// A source with its settings missing is simply left out.
//
// Three things to know before changing this file (see CLAUDE.md):
//
// - It is a shortcut. Reading each game's storage directly isn't the best
//   design (each game answering for itself would be, with no copy of its rules
//   here); it's done because asking the games would wake their servers.
// - It holds secret keys, in a public service. Never let one into a response,
//   a log or an error, never read more than the signed-in player's own games,
//   and keep every query's id through safeId. test/games-secrets.test.js
//   checks it.
// - mermaidsAwaiting() and the other "whose turn" readings copy rules from the
//   game repos. Change them here whenever the game's logic or saved data does.

const API = 'https://storage.googleapis.com';
const TOKEN_URL = 'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token';
// Terraform creates secrets with this value until the real ones are set.
const PLACEHOLDER = 'not-set';

const FRESH_MS = 15_000; // an answer this young is reused
const FAILED_MS = 5_000; // a failed source is tried again after this
const ATTEMPT_MS = 25_000; // one try at a source
const RETRY_WAIT_MS = 2_500; // between tries
const DEADLINE_MS = 150_000; // then a source gives up (the page asks again)
const QUICK_WAIT_MS = 3_000; // how long a request waits for sources before answering
const READ_CONCURRENCY = 8;
const MAX_ENTRIES = 1000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// An error not worth trying again: the source said no, not "not now".
function fatal(message) {
  const err = new Error(message);
  err.fatal = true;
  return err;
}

function checkStatus(res, what) {
  if (res.ok) return;
  const err = new Error(`${what}: ${res.status}`);
  err.fatal = res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429;
  throw err;
}

// What a game's own awaiting() answers, from its saved file (secret-mermaids
// src/Game.js): the ids it's waiting on for a move.
function mermaidsAwaiting(g) {
  if (g.step === 'trick') return g.trick && g.trick.order ? [g.trick.order[g.trick.plays.length]] : [];
  if (g.step === 'meld') return g.meld ? [g.meld.player] : [];
  if (g.step === 'vote') return g.tide ? g.tide.voters.filter((id) => !(g.tide.votes || {})[id]) : [];
  if (g.step === 'council') return (g.players || []).filter((p) => !((g.council || {}).gifts || {})[p.id]).map((p) => p.id);
  return [];
}

function createMyGames({
  env = {}, domain = 'cheetahmoongames.com', fetchImpl = globalThis.fetch, getToken, now = Date.now,
  quickWaitMs = QUICK_WAIT_MS, attemptMs = ATTEMPT_MS, retryWaitMs = RETRY_WAIT_MS, deadlineMs = DEADLINE_MS,
} = {}) {
  const clean = (v) => (v || '').trim();
  const supabase = (urlVar, keyVar) => {
    const url = clean(env[urlVar]).replace(/\/+$/, '');
    const key = clean(env[keyVar]);
    return url && key && url !== PLACEHOLDER && key !== PLACEHOLDER ? { url, key } : null;
  };
  const bucketOf = (name) => clean(env[name]);
  const origin = (sub) => `https://${sub}.${domain}`;

  // --- Cloud Storage, signed in as the service's own account ---

  let token = null;
  async function accessToken() {
    if (getToken) return getToken();
    if (token && token.expires > now() + 60_000) return token.value;
    const res = await fetchImpl(TOKEN_URL, { headers: { 'Metadata-Flavor': 'Google' }, signal: AbortSignal.timeout(5_000) });
    if (!res.ok) throw new Error(`metadata token: ${res.status}`);
    const t = await res.json();
    token = { value: t.access_token, expires: now() + t.expires_in * 1000 };
    return token.value;
  }

  async function gcs(url) {
    return fetchImpl(url, {
      headers: { Authorization: `Bearer ${await accessToken()}` },
      signal: AbortSignal.timeout(attemptMs),
    });
  }

  // Every object under a prefix, as the fields asked for say.
  async function listObjects(bucket, prefix, fields) {
    const out = [];
    let page = '';
    do {
      const url = `${API}/storage/v1/b/${encodeURIComponent(bucket)}/o?prefix=${encodeURIComponent(prefix)}`
        + `&fields=items(${fields}),nextPageToken${page ? `&pageToken=${encodeURIComponent(page)}` : ''}`;
      const res = await gcs(url);
      checkStatus(res, `list ${bucket}`);
      const data = await res.json();
      out.push(...(data.items || []));
      page = data.nextPageToken;
    } while (page);
    return out;
  }

  // --- Supabase (PostgREST) with the project's secret key ---

  async function rest(db, path) {
    const res = await fetchImpl(`${db.url}/rest/v1/${path}`, {
      headers: { apikey: db.key, Accept: 'application/json' },
      signal: AbortSignal.timeout(attemptMs),
    });
    checkStatus(res, `database ${path.split('?')[0]}`);
    const rows = await res.json();
    if (!Array.isArray(rows)) throw new Error('database answered with something else');
    return rows;
  }

  // Ids go into queries: only what an account id looks like.
  const safeId = (id) => {
    if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(id)) throw fatal('Unusual account id');
    return id;
  };

  // --- The games ---

  const sources = [];

  const kingsKeepBucket = bucketOf('KINGS_KEEP_BUCKET');
  if (kingsKeepBucket) {
    sources.push({
      name: 'kings-keep',
      title: "King's Keep",
      async fetch(player) {
        const files = await listObjects(kingsKeepBucket, 'tables/', 'name,metadata');
        const games = [];
        for (const f of files) {
          const m = f.metadata || {};
          if (m.status !== 'playing') continue;
          let ids;
          let names;
          try {
            ids = JSON.parse(m.players || '[]');
            names = JSON.parse(m.names || '[]');
          } catch {
            continue;
          }
          if (!ids.includes(player.id)) continue;
          const code = f.name.slice('tables/'.length, -'.json'.length);
          games.push({
            id: code,
            url: `${origin('kings-keep')}/r/${encodeURIComponent(code)}`,
            with: names.filter((n) => n !== player.name),
            yourTurn: m.turn === player.id,
            updated: Number(m.updated) || 0,
          });
        }
        return games;
      },
    });
  }

  const mermaidsBucket = bucketOf('SECRET_MERMAIDS_BUCKET');
  if (mermaidsBucket) {
    // path → { generation, game } for every saved game, so a game is read
    // again only when its file has changed.
    const seen = new Map();
    const summarise = (g) => ({
      active: Boolean(g.started && !g.over),
      players: (g.players || []).filter((p) => !p.isBot).map((p) => ({ id: p.id, name: p.name })),
      awaiting: g.started && !g.over ? mermaidsAwaiting(g) : [],
      updated: Number(g.updatedAt) || 0,
    });
    async function readGame(path) {
      const res = await gcs(`${API}/storage/v1/b/${encodeURIComponent(mermaidsBucket)}/o/${encodeURIComponent(path)}?alt=media`);
      if (res.status === 404) return null;
      checkStatus(res, `read ${path}`);
      return summarise(await res.json());
    }
    sources.push({
      name: 'secret-mermaids',
      title: 'Secret Mermaids',
      async fetch(player) {
        const files = await listObjects(mermaidsBucket, 'games/', 'name,generation');
        const live = new Set(files.map((f) => f.name));
        for (const path of seen.keys()) if (!live.has(path)) seen.delete(path);
        const stale = files.filter((f) => !seen.has(f.name) || seen.get(f.name).generation !== f.generation);
        let next = 0;
        await Promise.all(Array.from({ length: Math.min(READ_CONCURRENCY, stale.length) }, async () => {
          while (next < stale.length) {
            const f = stale[next++];
            const game = await readGame(f.name);
            if (game) seen.set(f.name, { generation: f.generation, game });
            else seen.delete(f.name);
          }
        }));
        const games = [];
        for (const [path, { game }] of seen) {
          if (!game.active || !game.players.some((p) => p.id === player.id)) continue;
          const id = path.slice('games/'.length, -'.json'.length);
          games.push({
            id,
            url: `${origin('secret-mermaids')}/game/${encodeURIComponent(id)}`,
            with: game.players.filter((p) => p.id !== player.id).map((p) => p.name),
            yourTurn: game.awaiting.includes(player.id),
            updated: game.updated,
          });
        }
        return games;
      },
    });
  }

  const bezique = supabase('BEZIQUE_SUPABASE_URL', 'BEZIQUE_SUPABASE_KEY');
  if (bezique) {
    sources.push({
      name: 'bezique',
      title: 'Bezique',
      async fetch(player) {
        const id = safeId(player.id);
        const rows = await rest(bezique, `games?player_ids=cs.{${id}}&select=id,updated_at,started:state->started,over:state->gameOver,players:state->players`
          + '&order=updated_at.desc&limit=100');
        return rows.filter((r) => r.started === true && r.over !== true).map((r) => {
          const players = Array.isArray(r.players) ? r.players : [];
          const me = players.find((p) => p.id === id);
          return {
            id: r.id,
            url: `${origin('bezique')}/game/${encodeURIComponent(r.id)}`,
            with: players.filter((p) => p.id !== id).map((p) => p.name),
            yourTurn: Boolean(me && (me.cardsSelectableForTrick || me.cardsSelectableForMeld)),
            updated: Date.parse(r.updated_at) || 0,
          };
        });
      },
    });
  }

  const bartenders = supabase('BARTENDERS_SUPABASE_URL', 'BARTENDERS_SUPABASE_KEY');
  if (bartenders) {
    sources.push({
      name: 'bartenders',
      title: 'Bartenders of Corfu',
      async fetch(player) {
        const id = safeId(player.id);
        const rows = await rest(bartenders, `games?status=eq.STARTED&players=cs.{${id}}&select=id,players,created_at,turn:latest_state->>player_turn,winner:latest_state->>winner`
          + '&order=created_at.desc&limit=50');
        const lower = id.toLowerCase();
        const others = new Set();
        for (const r of rows) for (const p of r.players || []) if (String(p).toLowerCase() !== lower) others.add(safeId(String(p)));
        // Opponents' names are nice to have: the games show without them.
        const names = new Map();
        if (others.size) {
          try {
            const users = await rest(bartenders, `users?id=in.(${[...others].join(',')})&select=id,username`);
            for (const u of users) names.set(String(u.id).toLowerCase(), u.username);
          } catch (err) {
            console.error(`my games: couldn't read Bartenders' players' names: ${err.message}`);
          }
        }
        return rows.filter((r) => !r.winner).map((r) => ({
          id: r.id,
          url: `${origin('bartenders')}/bar?id=${encodeURIComponent(r.id)}`,
          with: (r.players || []).map((p) => String(p).toLowerCase()).filter((p) => p !== lower).map((p) => names.get(p)).filter(Boolean),
          yourTurn: typeof r.turn === 'string' && r.turn.toLowerCase() === lower,
          updated: Date.parse(r.created_at) || 0,
        }));
      },
    });
  }

  // --- Asking, without waiting for the slow ones ---

  // `${source}:${player id}` → { status: 'pending' | 'ok' | 'error', games, at, promise }
  const results = new Map();

  async function attempts(source, player) {
    const deadline = now() + deadlineMs;
    for (;;) {
      try {
        return await source.fetch(player);
      } catch (err) {
        if (err.fatal || now() + retryWaitMs >= deadline) throw err;
        await sleep(retryWaitMs);
      }
    }
  }

  function ensure(source, player) {
    const key = `${source.name}:${player.id}`;
    const entry = results.get(key);
    if (entry && entry.promise) return entry;
    if (entry && now() - entry.at < (entry.status === 'error' ? FAILED_MS : FRESH_MS)) return entry;
    // Start asking again. What the last answer was stays until the new one
    // comes, so the page has something to show meanwhile.
    const next = { status: 'pending', games: entry ? entry.games : [], at: entry ? entry.at : 0, promise: null };
    next.promise = attempts(source, player).then((games) => {
      next.status = 'ok';
      next.games = games;
    }, (err) => {
      next.status = 'error';
      console.error(`my games: ${source.name}: ${err.message}`);
    }).then(() => {
      next.at = now();
      next.promise = null;
    });
    if (results.size >= MAX_ENTRIES) {
      for (const [k, e] of results) if (!e.promise && now() - e.at > 10 * 60_000) results.delete(k);
    }
    results.set(key, next);
    return next;
  }

  /**
   * The player's games in progress: { games: [{ game, title, id, url, with,
   * yourTurn, updated }], sources: { <game>: { title, status: 'ok' | 'pending' | 'error' } } }.
   * "pending" means that game is still being asked: ask again shortly.
   */
  async function list(player) {
    const entries = sources.map((source) => [source, ensure(source, player)]);
    const running = entries.map(([, e]) => e.promise).filter(Boolean);
    if (running.length) {
      // The timer doesn't keep the process alive; the attempts themselves do.
      let timer;
      const quick = new Promise((r) => { timer = setTimeout(r, quickWaitMs); timer.unref(); });
      await Promise.race([Promise.all(running), quick]);
      clearTimeout(timer);
    }
    const games = [];
    const status = {};
    for (const [source, entry] of entries) {
      status[source.name] = { title: source.title, status: entry.status };
      for (const g of entry.games) games.push({ game: source.name, title: source.title, ...g });
    }
    games.sort((a, b) => Number(b.yourTurn) - Number(a.yourTurn) || b.updated - a.updated);
    return { games, sources: status };
  }

  return { list, sources: sources.map((s) => s.name) };
}

module.exports = { createMyGames, mermaidsAwaiting };
