'use strict';

// Families: a parent sees how their children are doing in the games.
//
// A parent asks for a child by the email on the child's account. Nothing is
// shared until the child, signed in, says yes on cheetahmoongames.com/family
// (the home page tells them someone's asking), so nobody can see a child's
// games just by knowing their email. Either of them can undo it.
//
// The links live in Bartenders, beside the accounts (its app/family.py, in
// Supabase). These routes pass each request on, with the login cookie, the
// way account.js does:
//
//   GET  /api/family           who you are, your children, the emails you've
//                              asked for, who's asking for you, your parents
//   POST /api/family/ask       { email }: ask to be the parent of that account
//   POST /api/family/unask     { email }: stop asking
//   POST /api/family/answer    { parent, allow }: a child's answer
//   POST /api/family/remove    { id }: undo a link, as the parent or the child
//   GET  /api/family/children  your children, for games ({ children: [{ id, name }] }):
//                              games' auth.js asks this with the player's cookie

const ROUTES = {
  'GET /api/family': '/v1/family',
  'GET /api/family/children': '/v1/family/children',
  'POST /api/family/ask': '/v1/family/ask',
  'POST /api/family/unask': '/v1/family/unask',
  'POST /api/family/answer': '/v1/family/answer',
  'POST /api/family/remove': '/v1/family/remove',
};
const UNAVAILABLE = "That didn't work. Please try again in a minute.";

// `upstream(path, { method, body, cookie })` asks Bartenders (account.js's).
function createFamily({ upstream, readJson, cookieOf, available = true }) {
  async function route(req, path, send) {
    const cookie = cookieOf(req);
    if (!cookie) return send(401, { error: 'Sign in first.' });
    const body = req.method === 'POST' ? await readJson(req) : undefined;
    if (req.method === 'POST' && !body) return send(400, { error: "That didn't work." });
    const r = await upstream(path, { method: req.method, body, cookie });
    if (r.status === 200) return send(200, r.json);
    if (r.status === 401 || r.status === 404) return send(401, { error: 'Sign in first.' });
    if (r.status === 400 && r.json && typeof r.json.error === 'string') return send(400, { error: r.json.error });
    return send(502, { error: UNAVAILABLE });
  }

  // Handles /api/family and /api/family/* (returns true), or leaves the request alone.
  function handle(req, res, url, sendRaw) {
    const p = url.pathname;
    if (p !== '/api/family' && !p.startsWith('/api/family/')) return false;
    const send = (status, body) => sendRaw(res, status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    }, JSON.stringify(body));
    const path = ROUTES[`${req.method} ${p}`];
    if (!path) {
      send(404, { error: 'Not found' });
      return true;
    }
    if (!available) {
      send(503, { error: UNAVAILABLE });
      return true;
    }
    route(req, path, send).catch((err) => {
      console.error(`family ${p}: ${err && err.message}`);
      if (!res.headersSent) send(502, { error: UNAVAILABLE });
    });
    return true;
  }

  return { handle };
}

module.exports = { createFamily };
