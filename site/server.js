'use strict';

// cheetahmoongames.com — the games home page.
//
//   /            the home page (public/index.html)
//   /login       sign in or create a Cheetah Moon account (public/login.html)
//   /reset-password  choose a new password from an emailed link
//   /verify-email    verify your email from an emailed link, and sign in
//   /profile     your account: change your email or password (public/profile.html)
//   /family      parents and their children: see how they're doing in the games
//                (public/family.html)
//   /api/family/*  the links between them, kept by Bartenders (see family.js)
//   /api/account/*  accounts, shared by every game (see account.js)
//   /api/my-games  the games the signed-in player is in, and whose turn it is
//                (see games.js)
//   /assets/*    its images
//   /sw.js       a service worker that unregisters itself (see below)
//   /healthz     health check
//   anything else redirects to the same path on BARTENDERS_URL, because
//   Bartenders of Corfu used to live on this domain and old bookmarks, share
//   links and push notifications still point here.
//
// No dependencies: Node's http module is enough for a handful of routes.

const http = require('http');
const fs = require('fs');
const path = require('path');
const { createAccounts, readJson, loginCookieValue } = require('./account');
const { createFamily } = require('./family');
const { createMyGames } = require('./games');

const PUBLIC_DIR = path.join(__dirname, 'public');
const ASSETS_DIR = path.join(PUBLIC_DIR, 'assets');
const COOKIE_NAME = 'userjwt';
const COOKIE_MAX_AGE = 14 * 24 * 60 * 60;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.ico': 'image/x-icon',
};

// Browsers that installed the Bartenders service worker when it lived on this
// domain keep it until it is replaced. This one removes itself on the next
// visit, so it stops polling the old origin; Bartenders registers a fresh one
// on its own subdomain.
const RETIRE_SERVICE_WORKER = `self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.registration.unregister()));
`;

const NO_CACHE = 'no-cache, no-store, must-revalidate';
const HSTS = 'max-age=63072000; includeSubDomains; preload';

function config(env = process.env) {
  return {
    bartendersUrl: (env.BARTENDERS_URL || '').trim().replace(/\/+$/, ''),
    cookieDomain: (env.COOKIE_DOMAIN || '').trim().replace(/^\./, '').toLowerCase(),
    // The OAuth client ID for "Sign in with Google". Not a secret: it's on
    // the sign-in page for anyone to read. Unset, the button isn't shown.
    googleClientId: (env.GOOGLE_CLIENT_ID || '').trim(),
    // Bartenders' database URL and publishable key, to read login keys
    // without waiting for Bartenders (see lookupKey in account.js).
    keysDbUrl: (env.KEYS_SUPABASE_URL || '').trim(),
    keysDbKey: (env.KEYS_SUPABASE_KEY || '').trim(),
  };
}

// Bartenders' login cookies issued before it moved were host-only on this
// domain, so its subdomain never sees them. Move such a cookie onto the shared
// domain as its owner passes through, so they arrive still logged in.
function loginCookieValues(req) {
  const values = [];
  for (const part of (req.headers.cookie || '').split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0 && part.slice(0, eq).trim() === COOKIE_NAME) values.push(part.slice(eq + 1).trim());
  }
  return values;
}

function migrateLegacyCookie(req, cookieDomain) {
  if (!cookieDomain) return [];
  const values = loginCookieValues(req);
  if (values.length === 0) return [];
  // Delete the host-only cookie first, then set the shared one: browsers
  // disagree on whether the two are the same cookie, and in this order every
  // browser ends up holding only the shared cookie.
  const headers = [`${COOKIE_NAME}=""; Max-Age=0; Path=/; SameSite=Lax`];
  // With two copies the shared cookie already exists and is the newer login.
  if (values.length === 1) {
    headers.push(
      `${COOKIE_NAME}=${values[0]}; Domain=${cookieDomain}; HttpOnly; Max-Age=${COOKIE_MAX_AGE}; Path=/; SameSite=Strict`,
    );
  }
  return headers;
}

function send(res, status, headers, body) {
  res.writeHead(status, { 'Strict-Transport-Security': HSTS, ...headers });
  res.end(body);
}

function serveFile(req, res, filePath, extraHeaders) {
  fs.readFile(filePath, (err, data) => {
    if (err) return send(res, 404, { 'Content-Type': 'text/plain' }, 'Not found');
    send(res, 200, {
      'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream',
      ...extraHeaders,
    }, req.method === 'HEAD' ? undefined : data);
  });
}

// The routes games' pages call from their own subdomains (see above).
const GAME_ROUTES = new Set(['/api/account/me', '/api/account/switch', '/api/account/switch-back', '/api/account/logout', '/api/family']);

// The origin of one of the site's games (https://<game>.<cookie domain>), or
// null. Locally (no cookie domain), games on localhost.
function gameOrigin(origin, cookieDomain) {
  if (typeof origin !== 'string') return null;
  let url;
  try { url = new URL(origin); } catch { return null; }
  const host = url.hostname.toLowerCase();
  if (cookieDomain) {
    return url.protocol === 'https:' && host.endsWith('.' + cookieDomain) ? url.origin : null;
  }
  return host === 'localhost' || host === '127.0.0.1' ? url.origin : null;
}

function createServer(env = process.env, { fetchImpl, gcsToken, myGamesOptions } = {}) {
  const { bartendersUrl, cookieDomain, googleClientId, keysDbUrl, keysDbKey } = config(env);
  const accounts = createAccounts({ bartendersUrl, cookieDomain, googleClientId, fetchImpl, keysDbUrl, keysDbKey });
  const family = createFamily({
    upstream: accounts.upstream,
    available: Boolean(bartendersUrl),
    readJson,
    cookieOf: loginCookieValue,
  });

  // The players' games, read straight from where each game keeps them. Which
  // buckets and databases is in the environment (see games.js).
  const myGames = createMyGames({
    env, domain: cookieDomain || undefined, fetchImpl, getToken: gcsToken, ...myGamesOptions,
  });

  // GET /api/my-games: for the signed-in player, as the login cookie says
  // (checked here, as quickMe does, so nothing waits for Bartenders).
  async function sendMyGames(req, res) {
    const json = (status, body) => send(res, status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    }, JSON.stringify(body));
    const cookie = loginCookieValue(req);
    if (!cookie) return json(401, { error: 'Not signed in' });
    let claims;
    try {
      claims = await accounts.verifyCookie(cookie);
    } catch (err) {
      console.error(`my games: couldn't check a login cookie: ${err.message}`);
      return json(503, { error: "Couldn't check your sign-in right now." });
    }
    if (!claims) return json(401, { error: 'Not signed in' });
    return json(200, await myGames.list({ id: claims.id, name: claims.sub }));
  }

  return http.createServer((req, res) => {
    let url;
    try {
      url = new URL(req.url, 'http://localhost');
    } catch {
      return send(res, 400, { 'Content-Type': 'text/plain' }, 'Bad request');
    }
    const p = url.pathname;
    const read = req.method === 'GET' || req.method === 'HEAD';

    if (p === '/healthz') return send(res, 200, { 'Content-Type': 'text/plain' }, 'ok');

    if (p === '/' && read) {
      const cookies = migrateLegacyCookie(req, cookieDomain);
      return serveFile(req, res, path.join(PUBLIC_DIR, 'index.html'), {
        'Cache-Control': NO_CACHE,
        ...(cookies.length ? { 'Set-Cookie': cookies } : {}),
      });
    }

    if (p === '/login' && read) {
      return serveFile(req, res, path.join(PUBLIC_DIR, 'login.html'), { 'Cache-Control': NO_CACHE });
    }

    if (p === '/family' && read) {
      return serveFile(req, res, path.join(PUBLIC_DIR, 'family.html'), { 'Cache-Control': NO_CACHE });
    }

    if (p === '/profile' && read) {
      return serveFile(req, res, path.join(PUBLIC_DIR, 'profile.html'), { 'Cache-Control': NO_CACHE });
    }

    if (p === '/reset-password' && read) {
      // The token is in the URL: don't pass it on to other sites as a referrer.
      return serveFile(req, res, path.join(PUBLIC_DIR, 'reset-password.html'), {
        'Cache-Control': NO_CACHE,
        'Referrer-Policy': 'no-referrer',
      });
    }

    if (p === '/verify-email' && read) {
      return serveFile(req, res, path.join(PUBLIC_DIR, 'verify-email.html'), {
        'Cache-Control': NO_CACHE,
        'Referrer-Policy': 'no-referrer',
      });
    }

    // Games ask who's playing, and switch a parent to their child account and
    // back, from their own subdomains: those routes answer them (with the
    // login cookie, which is the whole site's), and nobody else.
    if (GAME_ROUTES.has(p)) {
      const origin = gameOrigin(req.headers.origin, cookieDomain);
      if (origin) {
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Access-Control-Allow-Credentials', 'true');
        res.setHeader('Vary', 'Origin');
        if (req.method === 'OPTIONS') {
          return send(res, 204, {
            'Access-Control-Allow-Methods': 'GET, POST',
            'Access-Control-Allow-Headers': 'Content-Type',
            'Access-Control-Max-Age': '600',
          });
        }
      }
    }

    if (p === '/api/my-games' && req.method === 'GET') {
      sendMyGames(req, res).catch((err) => {
        console.error(`my games: ${err && err.message}`);
        if (!res.headersSent) send(res, 502, { 'Content-Type': 'application/json' }, JSON.stringify({ error: "Couldn't look up your games." }));
      });
      return;
    }

    if (accounts.handle(req, res, url, send)) return;
    if (family.handle(req, res, url, send)) return;

    if (p === '/sw.js' && read) {
      return send(res, 200, {
        'Content-Type': 'application/javascript; charset=utf-8',
        'Cache-Control': NO_CACHE,
      }, RETIRE_SERVICE_WORKER);
    }

    if (p.startsWith('/assets/') && read) {
      let rel;
      try { rel = decodeURIComponent(p.slice('/assets/'.length)); } catch { rel = ''; }
      const filePath = path.resolve(ASSETS_DIR, rel);
      if (!rel || !filePath.startsWith(ASSETS_DIR + path.sep)) {
        return send(res, 404, { 'Content-Type': 'text/plain' }, 'Not found');
      }
      return serveFile(req, res, filePath, { 'Cache-Control': 'public, max-age=86400' });
    }

    if (!bartendersUrl) return send(res, 404, { 'Content-Type': 'text/plain' }, 'Not found');
    // 307 keeps the method and body, and browsers don't cache it forever.
    const cookies = migrateLegacyCookie(req, cookieDomain);
    return send(res, 307, {
      Location: bartendersUrl + p + url.search,
      'Cache-Control': 'no-store',
      ...(cookies.length ? { 'Set-Cookie': cookies } : {}),
    });
  });
}

if (require.main === module) {
  const port = Number(process.env.PORT) || 8080;
  createServer().listen(port, () => console.log(`cheetahmoongames.com home page on :${port}`));
}

module.exports = { createServer };
