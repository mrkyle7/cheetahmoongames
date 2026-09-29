'use strict';

// cheetahmoongames.com — the games home page.
//
//   /            the home page (public/index.html)
//   /login       sign in or create a Cheetah Moon account (public/login.html)
//   /reset-password  choose a new password from an emailed link
//   /api/account/*  accounts, shared by every game (see account.js)
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
const { createAccounts } = require('./account');

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

function createServer(env = process.env, { fetchImpl } = {}) {
  const { bartendersUrl, cookieDomain } = config(env);
  const accounts = createAccounts({ bartendersUrl, cookieDomain, fetchImpl });

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

    if (p === '/reset-password' && read) {
      // The token is in the URL: don't pass it on to other sites as a referrer.
      return serveFile(req, res, path.join(PUBLIC_DIR, 'reset-password.html'), {
        'Cache-Control': NO_CACHE,
        'Referrer-Policy': 'no-referrer',
      });
    }

    if (accounts.handle(req, res, url, send)) return;

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
