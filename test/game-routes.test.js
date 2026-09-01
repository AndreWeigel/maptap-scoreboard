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
        { question: 'Highest railway station?', lat: 33.0106, lng: 91.6642,
          answer: ' Tanggula, Qinghai–Tibet Railway, China ', radius: 20 },
      ] }),
    });
    assert.equal(put.status, 200);
    const { rounds } = await (await fetch(`${base}/game/api/admin/games/${g.id}`, { headers: auth })).json();
    assert.deepEqual(rounds.map((r) => [r.ord, r.question]),
      [[0, 'Born?'], [1, 'Highest railway station?']]);
    assert.equal(rounds[1].answer, 'Tanggula, Qinghai–Tibet Railway, China');
    assert.equal(rounds[1].radius, 20);
    assert.equal(rounds[0].radius, null);

    const play = await fetch(`${base}/game/${g.slug}`);
    assert.equal(play.status, 200); // the play page; its data comes from /game/api/:slug
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
      { question: 'q', lat: 1, lng: 2, radius: -5 },          // negative radius
      { question: 'q', lat: 1, lng: 2, radius: 'x' },         // non-numeric radius
      { question: 'q', lat: 1, lng: 2, radius: 20001 },       // absurd radius
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

// ---- Public play API (slice 3) ----
async function makeGame(base, rounds) {
  const g = await (await fetch(`${base}/game/api/admin/games`, {
    method: 'POST', headers: json, body: JSON.stringify({ title: 'Trip' }),
  })).json();
  await fetch(`${base}/game/api/admin/games/${g.id}`, {
    method: 'PUT', headers: json, body: JSON.stringify({ title: 'Trip', rounds }),
  });
  return g;
}
const R1 = { question: 'Born?', lat: 38.5707, lng: -7.9092, answer: 'Évora', story: 'alentejo' };
const R2 = { question: 'Station?', lat: 33.0106, lng: 91.6642, radius: 20 };

test('public game info leaks no secrets', async () => {
  await withServer(async (base) => {
    const g = await makeGame(base, [R1, R2]);
    const info = await (await fetch(`${base}/game/api/${g.slug}`)).json();
    assert.equal(info.title, 'Trip');
    assert.deepEqual(info.rounds, [{ ord: 0, question: 'Born?' }, { ord: 1, question: 'Station?' }]);
    assert.equal((await fetch(`${base}/game/api/nope`)).status, 404);
  });
});

test('guess endpoint scores and reveals; validates input', async () => {
  await withServer(async (base) => {
    const g = await makeGame(base, [R1, R2]);
    const r = await (await fetch(`${base}/game/api/${g.slug}/guess`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ord: 1, lat: 33.0106, lng: 91.6642 }),
    })).json();
    assert.equal(r.points, 100);
    assert.equal(r.km, 0);
    assert.equal(r.truth.radius, 20);
    assert.equal(r.truth.lat, 33.0106);
    const bad = await fetch(`${base}/game/api/${g.slug}/guess`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ord: 9, lat: 0, lng: 0 }),
    });
    assert.equal(bad.status, 404);
    assert.equal((await fetch(`${base}/game/api/${g.slug}/guess`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ord: 0, lat: 91, lng: 0 }),
    })).status, 400);
  });
});

test('submit recomputes total, blocks replays with 409, leaderboard sorts', async () => {
  await withServer(async (base) => {
    const g = await makeGame(base, [R1, R2]);
    const submit = (name, guesses) => fetch(`${base}/game/api/${g.slug}/plays`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ player_name: name, guesses }),
    });
    const perfect = [{ ord: 0, lat: R1.lat, lng: R1.lng }, { ord: 1, lat: R2.lat, lng: R2.lng }];
    const far = [{ ord: 0, lat: -33, lng: 151 }, { ord: 1, lat: -33, lng: 151 }];
    const a = await (await submit('Ana', perfect)).json();
    assert.equal(a.total, 200);
    const b = await submit('bob', far);
    assert.equal(b.status, 200);
    const dup = await submit(' Ana ', perfect); // trimmed, case-insensitive block
    assert.equal(dup.status, 409);
    assert.ok((await dup.json()).leaderboard.length === 2);
    const lb = await (await fetch(`${base}/game/api/${g.slug}/leaderboard`)).json();
    assert.deepEqual(lb.leaderboard.map((p) => p.player_name), ['Ana', 'bob']);
    assert.equal((await submit('Cara', [perfect[0]])).status, 400);   // missing a round
    assert.equal((await submit('', perfect)).status, 400);            // no name
  });
});

test('GET /game/:slug serves the play page for real slugs only', async () => {
  await withServer(async (base) => {
    const g = await makeGame(base, [R1]);
    const page = await fetch(`${base}/game/${g.slug}`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /maplibre/i);
    assert.equal((await fetch(`${base}/game/deadbeefdeadbeef`)).status, 404);
  });
});
