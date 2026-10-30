'use strict';

// Families: a parent sees how their children are doing in the games.
//
// A parent asks for a child by the email on the child's account. Nothing is
// shared until the child, signed in, says yes on cheetahmoongames.com/family
// (the home page tells them someone's asking), so nobody can see a child's
// games just by knowing their email. Either of them can undo it.
//
//   GET  /api/family           who you are, your children, the emails you've
//                              asked for, who's asking for you, your parents
//   POST /api/family/ask       { email }: ask to be the parent of that account
//   POST /api/family/unask     { email }: stop asking
//   POST /api/family/answer    { parent, allow }: a child's answer
//   POST /api/family/remove    { id }: undo a link, as the parent or the child
//   GET  /api/family/children  your children, for games ({ children: [{ id, name }] }):
//                              games' auth.js asks this with the player's cookie
//
// Who's signed in comes from Bartenders (/userDetails, with the login
// cookie), which also gives their email. The links are kept in the bucket
// named by FAMILY_BUCKET (terraform/site.tf), as JSON files:
//   parents/<id>.json    { children: [{ id, name }], asked: [email] }
//   children/<id>.json   { parents: [{ id, name }] }
//   asks/<sha256 of email>.json   { parents: [{ id, name }] }   who's asking for that email
// It talks to Cloud Storage's JSON API as the site's own service account,
// with a token from Cloud Run's metadata server, so there are no keys; every
// save names the version it changes (ifGenerationMatch) and retries on a
// clash. With no bucket (locally, in tests) they're kept in memory.

const crypto = require('crypto');

const TOKEN_URL = 'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token';
const API = 'https://storage.googleapis.com';
const TRIES = 4;
const MAX_ASKED = 10;      // emails one parent can be asking for at once
const MAX_LINKS = 20;      // children (or parents) one account can have
const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/;

class Clash extends Error {}

const safe = (id) => String(id).replace(/[^A-Za-z0-9_.-]/g, '_');
const emailKey = (email) => crypto.createHash('sha256').update(String(email).trim().toLowerCase()).digest('hex');

function memoryFiles() {
  const files = new Map();   // name -> { data, generation }
  return {
    async read(name) {
      const f = files.get(name);
      return f ? { data: structuredClone(f.data), generation: f.generation } : { data: null, generation: 0 };
    },
    async write(name, data, generation) {
      const f = files.get(name);
      if ((f ? f.generation : 0) !== generation) throw new Clash();
      files.set(name, { data: structuredClone(data), generation: generation + 1 });
    },
  };
}

function bucketFiles(bucket, fetchFn) {
  let token = null;   // { value, until }
  async function auth() {
    if (!token || Date.now() >= token.until) {
      const res = await fetchFn(TOKEN_URL, { headers: { 'Metadata-Flavor': 'Google' } });
      if (!res.ok) throw new Error(`metadata token: ${res.status}`);
      const body = await res.json();
      token = { value: body.access_token, until: Date.now() + (body.expires_in - 60) * 1000 };
    }
    return { Authorization: `Bearer ${token.value}` };
  }
  return {
    async read(name) {
      const res = await fetchFn(`${API}/storage/v1/b/${bucket}/o/${encodeURIComponent(name)}?alt=media`, { headers: await auth() });
      if (res.status === 404) return { data: null, generation: 0 };
      if (!res.ok) throw new Error(`read ${name}: ${res.status}`);
      return { data: await res.json(), generation: Number(res.headers.get('x-goog-generation')) };
    },
    async write(name, data, generation) {
      const url = `${API}/upload/storage/v1/b/${bucket}/o?uploadType=media&name=${encodeURIComponent(name)}&ifGenerationMatch=${generation}`;
      const res = await fetchFn(url, {
        method: 'POST',
        headers: { ...(await auth()), 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });
      if (res.status === 412) throw new Clash();
      if (!res.ok) throw new Error(`write ${name}: ${res.status}`);
    },
  };
}

// The links, kept in files. update(name, fn) reads a file (or `empty`), lets
// fn change it, and saves it, again from the top if someone else saved first.
function createLinks({ bucket = '', fetchFn = globalThis.fetch } = {}) {
  const files = bucket ? bucketFiles(bucket, fetchFn) : memoryFiles();
  async function read(name, empty) {
    const { data } = await files.read(name);
    return { ...empty(), ...(data || {}) };
  }
  async function update(name, empty, fn) {
    for (let i = 0; ; i++) {
      const { data, generation } = await files.read(name);
      const was = { ...empty(), ...(data || {}) };
      const next = fn(structuredClone(was));
      if (JSON.stringify(next) === JSON.stringify(was)) return next;   // nothing to save
      try {
        await files.write(name, next, generation);
        return next;
      } catch (err) {
        if (!(err instanceof Clash) || i >= TRIES - 1) throw err;
      }
    }
  }
  const parentFile = (id) => `parents/${safe(id)}.json`;
  const childFile = (id) => `children/${safe(id)}.json`;
  const askFile = (email) => `asks/${emailKey(email)}.json`;
  const noParent = () => ({ children: [], asked: [] });
  const noChild = () => ({ parents: [] });
  const noAsk = () => ({ parents: [] });
  const person = ({ id, name }) => ({ id, name });
  const without = (list, id) => list.filter((p) => p.id !== id);

  return {
    // Everything about `me` ({ id, name, email }).
    async view(me) {
      const [asParent, asChild, asks] = await Promise.all([
        read(parentFile(me.id), noParent),
        read(childFile(me.id), noChild),
        me.email ? read(askFile(me.email), noAsk) : noAsk(),
      ]);
      return {
        me: person(me),
        children: asParent.children,
        asked: asParent.asked,
        requests: asks.parents,
        parents: asChild.parents,
      };
    },

    children: async (id) => (await read(parentFile(id), noParent)).children,

    // `me` asks to be the parent of the account with `email`: 'ok', or why not.
    async ask(me, email) {
      email = String(email || '').trim().toLowerCase();
      if (!EMAIL.test(email)) return 'bad-email';
      if (me.email && email === me.email.toLowerCase()) return 'yourself';
      let why = 'ok';
      await update(parentFile(me.id), noParent, (p) => {
        if (p.asked.includes(email)) return p;
        if (p.asked.length >= MAX_ASKED) {
          why = 'too-many';
          return p;
        }
        return { ...p, asked: [...p.asked, email] };
      });
      if (why !== 'ok') return why;
      await update(askFile(email), noAsk, (a) => ({ parents: [...without(a.parents, me.id), person(me)] }));
      return 'ok';
    },

    async unask(me, email) {
      email = String(email || '').trim().toLowerCase();
      await update(parentFile(me.id), noParent, (p) => ({ ...p, asked: p.asked.filter((e) => e !== email) }));
      if (EMAIL.test(email)) await update(askFile(email), noAsk, (a) => ({ parents: without(a.parents, me.id) }));
    },

    // A child's answer to a parent who asked for their email: 'ok', or why not.
    async answer(me, parentId, allow) {
      if (!me.email) return 'no-email';
      const asks = await read(askFile(me.email), noAsk);
      const parent = asks.parents.find((p) => p.id === parentId);
      if (!parent) return 'not-asked';
      if (allow) {
        const mine = await read(childFile(me.id), noChild);
        if (mine.parents.length >= MAX_LINKS) return 'too-many';
        await update(parentFile(parent.id), noParent, (p) => ({
          children: [...without(p.children, me.id), person(me)].slice(0, MAX_LINKS),
          asked: p.asked.filter((e) => e !== me.email.toLowerCase()),
        }));
        await update(childFile(me.id), noChild, (c) => ({ parents: [...without(c.parents, parent.id), person(parent)] }));
      } else {
        await update(parentFile(parent.id), noParent, (p) => ({ ...p, asked: p.asked.filter((e) => e !== me.email.toLowerCase()) }));
      }
      await update(askFile(me.email), noAsk, (a) => ({ parents: without(a.parents, parent.id) }));
      return 'ok';
    },

    // Undo a link with `id`, whichever of them `me` is.
    async remove(me, id) {
      await update(parentFile(me.id), noParent, (p) => ({ ...p, children: without(p.children, id) }));
      await update(childFile(id), noChild, (c) => ({ parents: without(c.parents, me.id) }));
      await update(childFile(me.id), noChild, (c) => ({ parents: without(c.parents, id) }));
      await update(parentFile(id), noParent, (p) => ({ ...p, children: without(p.children, me.id) }));
    },
  };
}

const MESSAGES = {
  'bad-email': "That doesn't look like an email address.",
  yourself: "That's your own email.",
  'too-many': "That's as many as there can be at once.",
  'not-asked': "They aren't asking any more.",
  'no-email': 'Your account has no email address.',
};

// The /api/family routes. `whoIs(cookie)` resolves to { id, name, email } for
// a signed-in player, or null.
function createFamily({ links, whoIs, readJson, cookieOf }) {
  async function route(req, p, send) {
    const cookie = cookieOf(req);
    const me = cookie ? await whoIs(cookie) : null;
    if (!me) return send(401, { error: 'Sign in first.' });
    if (p === '/api/family' && req.method === 'GET') return send(200, await links.view(me));
    if (p === '/api/family/children' && req.method === 'GET') return send(200, { children: await links.children(me.id) });
    if (req.method !== 'POST') return send(404, { error: 'Not found' });
    const body = (await readJson(req)) || {};
    let why = 'ok';
    if (p === '/api/family/ask') why = await links.ask(me, body.email);
    else if (p === '/api/family/unask') await links.unask(me, body.email);
    else if (p === '/api/family/answer') why = await links.answer(me, String(body.parent || ''), body.allow === true);
    else if (p === '/api/family/remove') await links.remove(me, String(body.id || ''));
    else return send(404, { error: 'Not found' });
    if (why !== 'ok') return send(400, { error: MESSAGES[why] || 'That didn\'t work.' });
    return send(200, await links.view(me));
  }

  // Handles /api/family and /api/family/* (returns true), or leaves the request alone.
  function handle(req, res, url, sendRaw) {
    const p = url.pathname;
    if (p !== '/api/family' && !p.startsWith('/api/family/')) return false;
    const send = (status, body) => sendRaw(res, status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    }, JSON.stringify(body));
    route(req, p, send).catch((err) => {
      console.error(`family ${p}: ${err && err.message}`);
      if (!res.headersSent) send(502, { error: "That didn't work. Please try again in a minute." });
    });
    return true;
  }

  return { handle };
}

module.exports = { createLinks, createFamily, emailKey };
