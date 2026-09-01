process.env.ADMIN_TOKEN = 's3cret'; // before config loads, so basicAuth is enabled
const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { basicAuth } = require('../src/web');
const gameRoutes = require('../src/game/routes');

async function withServer(fn) {
  const app = express();
  app.use(express.json());
  app.use('/game', gameRoutes({ basicAuth, dbPath: ':memory:' }));
  const server = app.listen(0);
  try { return await fn(`http://127.0.0.1:${server.address().port}`); }
  finally { server.close(); }
}
const auth = { authorization: 'Basic ' + Buffer.from('admin:s3cret').toString('base64') };
const json = { ...auth, 'content-type': 'application/json' };

test('admin API requires auth', async () => {
  await withServer(async (base) => {
    assert.equal((await fetch(`${base}/game/api/admin/games`)).status, 401);
    assert.equal((await fetch(`${base}/game/admin`)).status, 401);
  });
});

test('create → update rounds → fetch round-trip; share slug resolves', async () => {
  await withServer(async (base) => {
    const g = await (await fetch(`${base}/game/api/admin/games`, {
      method: 'POST', headers: json, body: JSON.stringify({ title: "Daniel's 30th" }),
    })).json();
    assert.match(g.slug, /^[a-f0-9]{16}$/);

    const put = await fetch(`${base}/game/api/admin/games/${g.id}`, {
      method: 'PUT', headers: json,
      body: JSON.stringify({ title: g.title, rounds: [
        { question: ' Born? ', lat: 38.57, lng: -7.9, city: 'Évora', story: ' s ', photo: 'a1b2c3d4e5f60718.jpg' },
        { question: 'Studied?', lat: 41.15, lng: -8.61 },
      ] }),
    });
    assert.equal(put.status, 200);
    const { rounds } = await (await fetch(`${base}/game/api/admin/games/${g.id}`, { headers: auth })).json();
    assert.deepEqual(rounds.map((r) => [r.ord, r.question]), [[0, 'Born?'], [1, 'Studied?']]);

    const play = await fetch(`${base}/game/${g.slug}`);
    assert.equal(play.status, 200);
    assert.match(await play.text(), /Daniel's 30th/);
    assert.equal((await fetch(`${base}/game/deadbeefdeadbeef`)).status, 404);
  });
});

test('PUT rejects invalid rounds with 400', async () => {
  await withServer(async (base) => {
    const g = await (await fetch(`${base}/game/api/admin/games`, {
      method: 'POST', headers: json, body: JSON.stringify({ title: 't' }),
    })).json();
    for (const bad of [
      { question: '', lat: 1, lng: 2 },                       // empty question
      { question: 'q', lat: 91, lng: 2 },                     // lat out of range
      { question: 'q', lat: 1, lng: '2' },                    // non-numeric lng
      { question: 'q', lat: 1, lng: 2, photo: '../etc/pwd' }, // bad photo name
    ]) {
      const r = await fetch(`${base}/game/api/admin/games/${g.id}`, {
        method: 'PUT', headers: json, body: JSON.stringify({ title: 't', rounds: [bad] }),
      });
      assert.equal(r.status, 400, JSON.stringify(bad));
    }
    assert.equal((await fetch(`${base}/game/api/admin/games`, {
      method: 'POST', headers: json, body: JSON.stringify({}),
    })).status, 400); // missing title
  });
});

test('delete removes the game and its share page', async () => {
  await withServer(async (base) => {
    const g = await (await fetch(`${base}/game/api/admin/games`, {
      method: 'POST', headers: json, body: JSON.stringify({ title: 't' }),
    })).json();
    assert.equal((await fetch(`${base}/game/api/admin/games/${g.id}`, { method: 'DELETE', headers: auth })).status, 200);
    assert.equal((await fetch(`${base}/game/${g.slug}`)).status, 404);
    assert.equal((await fetch(`${base}/game/api/admin/games/${g.id}`, { headers: auth })).status, 404);
  });
});
