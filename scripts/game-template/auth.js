'use strict';

// Who is playing: the Cheetah Moon account the player signed in with at
// cheetahmoongames.com/login. The same file is in every game; the original
// is scripts/game-template/auth.js in mrkyle7/cheetahmoongames.
//
// Signing in sets the `userjwt` cookie for the whole of cheetahmoongames.com,
// so the browser sends it to every game. It's a JWT signed (RS256) by the
// accounts service; this checks the signature with the public key from
//   <ACCOUNTS_URL>/api/account/keys/<kid>
// and never trusts a cookie it can't check.
//
// It also tells the accounts service when it sees a signed-in player, so the
// site's owner hears when someone comes back (Bartenders' app/activity.py):
// at most every 5 minutes per player, without holding up the request, by
// sending the player's own cookie back to the accounts service that issued
// it (POST <ACCOUNTS_URL>/api/account/seen). That's the only place the cookie
// goes. The game is named by `place`: Cloud Run's K_SERVICE, the service name,
// so local runs (no K_SERVICE) report nothing.
//
// Games that let guests play under a typed name call auth.guestSeen(name)
// when a guest starts playing. With no cookie to vouch for them, the game's
// server does: it sends a Google identity token for its own Cloud Run service
// account (from Cloud Run's metadata server; no secrets) to
// POST <ACCOUNTS_URL>/api/account/guest-seen.
//
//   const auth = createAuth();
//   const player = await auth.player(req);   // { id, name } or null
//   auth.loginUrl('https://snap.cheetahmoongames.com/')   // send them to sign in
//   auth.guestSeen('Bob')                    // a guest started playing
//   await auth.children(req)                 // a parent's children: [{ id, name }]
//   await auth.isAdmin(req)                  // whether they're one of the site's admins
//
// Parents link to their children at cheetahmoongames.com/family (once each
// child says yes). A game that shows parents how their children are doing
// asks auth.children(req): it sends the player's own cookie back to the
// accounts service (GET <ACCOUNTS_URL>/api/family/children), at most once a
// minute per player. See "Families" in ADDING_A_GAME.md.
//
// No dependencies: Node's crypto does the checking.

const crypto = require('crypto');

const COOKIE_NAME = 'userjwt';
const DEFAULT_ACCOUNTS_URL = 'https://cheetahmoongames.com';
const MISSING_KEY_RETRY_MS = 60 * 1000;
const REPORT_EVERY_MS = 5 * 60 * 1000;
const CHILDREN_TTL_MS = 60 * 1000;
const ADMIN_TTL_MS = 5 * 60 * 1000;
// Who Bartenders accepts guest reports from: identity tokens made out to this.
const GAME_AUDIENCE = 'https://cheetahmoongames.com';
const METADATA_IDENTITY = 'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity';
const GAME_TOKEN_TTL_MS = 50 * 60 * 1000; // Google's last an hour

function base64url(s) {
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

function decodePart(s) {
  try {
    const v = JSON.parse(base64url(s).toString('utf8'));
    return v && typeof v === 'object' ? v : null;
  } catch {
    return null;
  }
}

function cookieValue(cookieHeader, name = COOKIE_NAME) {
  for (const part of (cookieHeader || '').split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}

function createAuth({
  accountsUrl = process.env.ACCOUNTS_URL || DEFAULT_ACCOUNTS_URL,
  fetchKey, // (kid) => Promise<pem string | null>; tests pass their own
  now = () => Date.now(),
  place = process.env.K_SERVICE || null, // this game, for reporting players seen
  reportSeen, // (token, place) => Promise; tests pass their own
  reportGuest, // (name) => Promise; tests pass their own
  fetchChildren, // (token) => Promise<[{ id, name }]>; tests pass their own
  fetchAdmin, // (token) => Promise<boolean>; tests pass their own
  metadataUrl = METADATA_IDENTITY, // tests point it at a stand-in
} = {}) {
  const base = accountsUrl.replace(/\/+$/, '');
  const keys = new Map(); // kid -> { key: Promise<KeyObject|null>, at }

  const defaultFetchKey = async (kid) => {
    const r = await fetch(`${base}/api/account/keys/${encodeURIComponent(kid)}`, {
      signal: AbortSignal.timeout(10_000),
    });
    if (r.status === 404) return null;
    if (!r.ok) throw new Error(`accounts service answered ${r.status}`);
    const body = await r.json();
    return typeof body.pem === 'string' ? body.pem : null;
  };
  const loadPem = fetchKey || defaultFetchKey;

  function keyFor(kid) {
    const cached = keys.get(kid);
    // Keys never change, so a found key is kept. An unknown one is asked about
    // again after a minute, and a failed lookup straight away.
    if (cached && !(cached.missing && now() - cached.at > MISSING_KEY_RETRY_MS)) return cached.key;
    const entry = { at: now(), missing: false };
    entry.key = Promise.resolve()
      .then(() => loadPem(kid))
      .then((pem) => {
        if (!pem) { entry.missing = true; return null; }
        return crypto.createPublicKey(pem);
      })
      .catch((err) => {
        keys.delete(kid);
        throw err;
      });
    keys.set(kid, entry);
    return entry.key;
  }

  // The account a login token belongs to, or null if it isn't a valid one.
  async function verify(token) {
    if (typeof token !== 'string' || token.length > 8192) return null;
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const header = decodePart(parts[0]);
    const claims = decodePart(parts[1]);
    if (!header || !claims || header.alg !== 'RS256') return null;
    const kid = header.kid || claims.kid;
    if (typeof kid !== 'string' || !/^[0-9a-fA-F-]{36}$/.test(kid)) return null;

    let key;
    try {
      key = await keyFor(kid);
    } catch (err) {
      console.error(`auth: couldn't fetch signing key ${kid}: ${err.message}`);
      return null;
    }
    if (!key) return null;

    const ok = crypto.verify('RSA-SHA256', Buffer.from(`${parts[0]}.${parts[1]}`), key, base64url(parts[2]));
    if (!ok) return null;
    if (typeof claims.exp !== 'number' || claims.exp * 1000 <= now()) return null;
    if (typeof claims.id !== 'string' || typeof claims.sub !== 'string' || !claims.id || !claims.sub) return null;
    return { id: claims.id, name: claims.sub };
  }

  const defaultReportSeen = async (token, where) => {
    const r = await fetch(`${base}/api/account/seen`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: `${COOKIE_NAME}=${token}` },
      body: JSON.stringify({ place: where }),
      signal: AbortSignal.timeout(10_000),
    });
    // 401: a signed-out or deleted account; nothing to report.
    if (!r.ok && r.status !== 401) throw new Error(`accounts service answered ${r.status}`);
  };
  const report = reportSeen || defaultReportSeen;
  const lastReported = new Map(); // player id -> when

  function noteSeen(token, who) {
    if (!place) return;
    const t = now();
    const last = lastReported.get(who.id);
    if (last !== undefined && t - last < REPORT_EVERY_MS) return;
    if (lastReported.size > 10_000) lastReported.clear();
    lastReported.set(who.id, t);
    Promise.resolve()
      .then(() => report(token, place))
      .catch((err) => console.error(`auth: couldn't report a player as seen: ${err.message}`));
  }

  let gameToken = null; // { value, at }
  async function identityToken() {
    if (gameToken && now() - gameToken.at < GAME_TOKEN_TTL_MS) return gameToken.value;
    const url = `${metadataUrl}?audience=${encodeURIComponent(GAME_AUDIENCE)}&format=full`;
    const r = await fetch(url, { headers: { 'Metadata-Flavor': 'Google' }, signal: AbortSignal.timeout(5_000) });
    if (!r.ok) throw new Error(`metadata server answered ${r.status}`);
    gameToken = { value: (await r.text()).trim(), at: now() };
    return gameToken.value;
  }

  const defaultReportGuest = async (name) => {
    const r = await fetch(`${base}/api/account/guest-seen`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${await identityToken()}` },
      body: JSON.stringify({ name }),
      signal: AbortSignal.timeout(10_000),
    });
    if (r.status === 401) gameToken = null; // try a fresh token next time
    if (!r.ok) throw new Error(`accounts service answered ${r.status}`);
  };
  const reportGuestSeen = reportGuest || defaultReportGuest;
  const guestsReported = new Map(); // lower-case name -> when

  // A guest (no account) started playing under `name`. Never throws or waits.
  function guestSeen(name) {
    if (!place) return;
    const shown = String(name || '').trim().slice(0, 30) || 'Guest';
    const key = shown.toLowerCase();
    const t = now();
    const last = guestsReported.get(key);
    if (last !== undefined && t - last < REPORT_EVERY_MS) return;
    if (guestsReported.size > 10_000) guestsReported.clear();
    guestsReported.set(key, t);
    Promise.resolve()
      .then(() => reportGuestSeen(shown))
      .catch((err) => console.error(`auth: couldn't report a guest as seen: ${err.message}`));
  }

  // The signed-in player making this request (an http request or a WebSocket
  // upgrade), or null.
  function player(req) {
    const token = cookieValue(req && req.headers && req.headers.cookie);
    if (!token) return Promise.resolve(null);
    return verify(token).then((who) => {
      if (who) noteSeen(token, who);
      return who;
    });
  }

  const defaultFetchChildren = async (token) => {
    const r = await fetch(`${base}/api/family/children`, {
      headers: { Cookie: `${COOKIE_NAME}=${token}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (r.status === 401) return [];
    if (!r.ok) throw new Error(`accounts service answered ${r.status}`);
    const body = await r.json();
    return Array.isArray(body.children) ? body.children.filter((c) => c && typeof c.id === 'string' && typeof c.name === 'string') : [];
  };
  const loadChildren = fetchChildren || defaultFetchChildren;
  const childrenOf = new Map(); // player id -> { list: Promise, at }

  // The children of the signed-in player making this request, linked at
  // cheetahmoongames.com/family: [{ id, name }], or [] (not signed in, or
  // none). Remembered for a minute.
  async function children(req) {
    const token = cookieValue(req && req.headers && req.headers.cookie);
    const who = token ? await verify(token) : null;
    if (!who) return [];
    const cached = childrenOf.get(who.id);
    if (cached && now() - cached.at < CHILDREN_TTL_MS) return cached.list;
    if (childrenOf.size > 10_000) childrenOf.clear();
    const entry = { at: now(), list: Promise.resolve().then(() => loadChildren(token)) };
    entry.list.catch(() => childrenOf.delete(who.id));
    childrenOf.set(who.id, entry);
    return entry.list;
  }

  const defaultFetchAdmin = async (token) => {
    const r = await fetch(`${base}/api/account/me`, {
      headers: { Cookie: `${COOKIE_NAME}=${token}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!r.ok) throw new Error(`accounts service answered ${r.status}`);
    return (await r.json()).admin === true;
  };
  const loadAdmin = fetchAdmin || defaultFetchAdmin;
  const adminOf = new Map(); // player id -> { is: Promise<boolean>, at }

  // Whether the signed-in player making this request is one of the site's
  // admins (Bartenders' is_admin), for a game's admin pages: asked of the
  // accounts service with their own cookie, remembered for 5 minutes. False
  // if not signed in, or if it can't be asked.
  async function isAdmin(req) {
    const token = cookieValue(req && req.headers && req.headers.cookie);
    const who = token ? await verify(token) : null;
    if (!who) return false;
    const cached = adminOf.get(who.id);
    if (cached && now() - cached.at < ADMIN_TTL_MS) return cached.is;
    if (adminOf.size > 10_000) adminOf.clear();
    const entry = { at: now(), is: Promise.resolve().then(() => loadAdmin(token)).catch(() => false) };
    adminOf.set(who.id, entry);
    return entry.is;
  }

  // Where to send someone to sign in; they come back to `returnTo` after.
  function loginUrl(returnTo) {
    return `${base}/login${returnTo ? `?next=${encodeURIComponent(returnTo)}` : ''}`;
  }

  return { player, verify, loginUrl, guestSeen, children, isAdmin, accountsUrl: base };
}

module.exports = { createAuth, cookieValue, COOKIE_NAME };
