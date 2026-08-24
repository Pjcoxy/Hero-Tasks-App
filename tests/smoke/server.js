// Serves the real frontend and the real API logic on localhost, with Cosmos DB
// replaced by an in-memory store — the same technique api/test-logic.js already
// uses, so no Azure, no emulator, no secrets, and nothing that cannot run on a
// pull_request trigger.
//
// This matters more than it looks. #88 was a DATA bug: the seed was correct and
// the live household, created weeks earlier, kept its old avatars. A test that
// stubs the API at the network layer invents its own responses and sails
// straight past that class of bug. Running the real handler against a real
// (if temporary) store is what makes the test able to see it.
// The window feature makes 'now' part of the app's behaviour: past 21:00
// household time a daily chore is refused. Tests must not change meaning with
// the hour CI happens to run at, so the harness pins the household timezone to
// a fixed-offset zone chosen so that local time is around noon right now, with
// the local date equal to the UTC date (the browser in CI runs UTC, and the
// two ends of the app must agree on what day it is). Etc/GMT zones use
// inverted signs: Etc/GMT-8 means UTC+8.
{
  const utcHour = new Date().getUTCHours();
  const offset = Math.max(-12, Math.min(14, 12 - utcHour));
  process.env.HOUSEHOLD_TIMEZONE = offset === 0
    ? 'Etc/GMT'
    : `Etc/GMT${offset > 0 ? '-' : '+'}${Math.abs(offset)}`;
}

const http = require('http');
const fs = require('fs');
const path = require('path');
const Module = require('module');

const API_ROOT = path.join(__dirname, '..', '..', 'api');
const FRONTEND = path.join(__dirname, '..', '..', 'frontend');

// ---------------------------------------------------------------------------
// In-memory Cosmos DB
// ---------------------------------------------------------------------------
const store = {};
const getMap = (name) => (store[name] || (store[name] = new Map()));

function mockContainer(name) {
  const map = getMap(name);
  return {
    items: {
      create: async (doc) => {
        // Real Cosmos refuses a duplicate id with 409; recordMisses leans on
        // that for idempotency, so the mock must refuse too or the tests
        // would pass against a store more forgiving than production.
        if (map.has(doc.id)) {
          const err = new Error('Entity with the specified id already exists');
          err.code = 409;
          throw err;
        }
        map.set(doc.id, doc);
        return { resource: doc };
      },
      upsert: async (doc) => { map.set(doc.id, doc); return { resource: doc }; },
      query: (q) => ({
        fetchAll: async () => {
          let docs = [...map.values()];
          if (q && q.parameters) {
            q.parameters.forEach((p) => {
              if (p.name === '@h') docs = docs.filter((d) => d.householdId === p.value);
            });
          }
          return { resources: docs };
        },
      }),
    },
    item: (id) => ({
      read: async () => {
        const doc = map.get(id);
        if (!doc) throw new Error('Not found');
        return { resource: doc };
      },
      replace: async (doc) => { map.set(id, doc); return { resource: doc }; },
      delete: async () => { map.delete(id); },
    }),
  };
}

function stub(modulePath, exports) {
  const resolved = require.resolve(modulePath);
  const m = new Module(resolved);
  m.exports = exports;
  m.loaded = true;
  require.cache[resolved] = m;
}

stub(path.join(API_ROOT, 'src/lib/cosmos.js'), { container: mockContainer });
stub(path.join(API_ROOT, 'node_modules/web-push'), {
  setVapidDetails: () => {},
  sendNotification: async () => {},
});

process.env.VAPID_PUBLIC_KEY = 'smoke-public';
process.env.VAPID_PRIVATE_KEY = 'smoke-private';

const { ensureSeeded } = require(path.join(API_ROOT, 'src/lib/seed.js'));
const { ROUTES } = require(path.join(API_ROOT, 'src/functions/hero.js'));

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.webmanifest': 'application/manifest+json',
};

const server = http.createServer(async (req, res) => {
  // Mirrors the real Azure Function handler in hero.js: seed, look the action
  // up in ROUTES, call it. Same code path the deployed app takes.
  if (req.method === 'POST' && req.url.startsWith('/api/hero')) {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', async () => {
      let payload = {};
      try { payload = JSON.parse(body || '{}'); } catch (e) { payload = {}; }
      try {
        await ensureSeeded();
        const fn = ROUTES[payload.action || 'state'];
        if (!fn) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ ok: false, error: 'Unknown action' }));
        }
        const result = await fn(payload);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      } catch (err) {
        res.writeHead(err.status || 500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
    });
    return;
  }

  const rel = (req.url === '/' ? '/index.html' : req.url).split('?')[0];
  const file = path.join(FRONTEND, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
});

const PORT = process.env.SMOKE_PORT || 4173;
server.listen(PORT, () => console.log(`smoke server on http://127.0.0.1:${PORT}`));
