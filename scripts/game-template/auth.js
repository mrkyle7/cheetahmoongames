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
//   const auth = createAuth();
//   const player = await auth.player(req);   // { id, name } or null
//   auth.loginUrl('https://snap.cheetahmoongames.com/')   // send them to sign in
//
// No dependencies: Node's crypto does the checking.

const crypto = require('crypto');

const COOKIE_NAME = 'userjwt';
const DEFAULT_ACCOUNTS_URL = 'https://cheetahmoongames.com';
const MISSING_KEY_RETRY_MS = 60 * 1000;

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

  // The signed-in player making this request (an http request or a WebSocket
  // upgrade), or null.
  function player(req) {
    const token = cookieValue(req && req.headers && req.headers.cookie);
    return token ? verify(token) : Promise.resolve(null);
  }

  // Where to send someone to sign in; they come back to `returnTo` after.
  function loginUrl(returnTo) {
    return `${base}/login${returnTo ? `?next=${encodeURIComponent(returnTo)}` : ''}`;
  }

  return { player, verify, loginUrl, accountsUrl: base };
}

module.exports = { createAuth, cookieValue, COOKIE_NAME };
