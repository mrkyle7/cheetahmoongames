'use strict';

// __TITLE__ — served at https://__SUBDOMAIN__.cheetahmoongames.com
//
// A starting point with no dependencies: it serves public/, a health check,
// and /api/me, who the player is signed in as (see auth.js).
// Replace or grow it into the game; keep reading PORT and serving the game at /.

const http = require('http');
const fs = require('fs');
const path = require('path');
const { createAuth } = require('./auth');

const PUBLIC_DIR = path.join(__dirname, 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
};

function createServer({ auth = createAuth() } = {}) {
  return http.createServer(async (req, res) => {
    let pathname;
    try {
      pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    } catch {
      res.writeHead(400, { 'Content-Type': 'text/plain' }).end('Bad request');
      return;
    }

    if (pathname === '/healthz') {
      res.writeHead(200, { 'Content-Type': 'text/plain' }).end('ok');
      return;
    }

    // Who's playing. Players sign in once, at cheetahmoongames.com/login.
    if (pathname === '/api/me') {
      const player = await auth.player(req);
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(player
        ? { signedIn: true, id: player.id, name: player.name }
        : { signedIn: false, loginUrl: auth.loginUrl('https://__SUBDOMAIN__.cheetahmoongames.com/') }));
      return;
    }

    const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
    const filePath = path.resolve(PUBLIC_DIR, rel);
    if (!filePath.startsWith(PUBLIC_DIR + path.sep)) {
      res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
      return;
    }
    fs.readFile(filePath, (err, data) => {
      if (err) {
        res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
        return;
      }
      res.writeHead(200, {
        'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream',
        'Cache-Control': 'no-cache',
      });
      res.end(data);
    });
  });
}

if (require.main === module) {
  const port = Number(process.env.PORT) || 8080;
  createServer().listen(port, () => console.log(`Listening on http://localhost:${port}`));
}

module.exports = { createServer };
