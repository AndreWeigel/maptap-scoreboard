process.env.ADMIN_TOKEN = 's3cret'; // before config loads, so basicAuth is enabled
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const { basicAuth } = require('../src/web');
const { openGameDb } = require('../src/game/db');
const liveRoutes = require('../src/game/live');

const auth = { authorization: 'Basic ' + Buffer.from('admin:s3cret').toString('base64') };
const json = { 'content-type': 'application/json' };
const adminJson = { ...auth, ...json };

async function withServer(fn) {
  const db = openGameDb(':memory:');
  const uploadsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'live-uploads-'));
  const app = express();
  app.use(express.json());
  app.use('/game', liveRoutes({ basicAuth, db, uploadsDir }));
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const g = db.createGame('Trains');
  db.saveGame(g.id, 'Trains', [
    { question: 'Highest station?', lat: 33.0106, lng: 91.6642, radius: 20, answer: 'Tanggula', photo: 'a1b2c3d4e5f60718.jpg' },
    { question: 'First railway?', lat: 54.9, lng: -1.6 },
  ]);
  fs.writeFileSync(path.join(uploadsDir, 'a1b2c3d4e5f60718.jpg'), 'notreallyajpeg');
  try { return await fn({ base, db, game: g, uploadsDir }); }
  finally { server.closeAllConnections(); server.close(); }
}
const post = (url, body, headers = json) =>
  fetch(url, { method: 'POST', headers, body: body === undefined ? undefined : JSON.stringify(body) });
const next = (base, code) => post(`${base}/game/api/admin/sessions/${code}/next`, undefined, auth);

test('admin session endpoints require auth; create → lobby; list per game', async () => {
  await withServer(async ({ base, game }) => {
    assert.equal((await post(`${base}/game/api/admin/games/${game.id}/sessions`)).status, 401);
    const r = await post(`${base}/game/api/admin/games/${game.id}/sessions`, undefined, auth);
    assert.equal(r.status, 200);
    const { code } = await r.json();
    assert.match(code, /^[a-f0-9]{10}$/);
    const list = await (await fetch(`${base}/game/api/admin/games/${game.id}/sessions`, { headers: auth })).json();
    assert.equal(list.sessions[0].code, code);
    assert.equal(list.sessions[0].state, 'lobby');
    assert.equal((await post(`${base}/game/api/admin/games/999/sessions`, undefined, auth)).status, 404);
    assert.equal((await fetch(`${base}/game/host/${code}`)).status, 401);
    assert.equal((await fetch(`${base}/game/host/${code}`, { headers: auth })).status, 200);
    assert.equal((await fetch(`${base}/game/live/${code}`)).status, 200);
    assert.equal((await fetch(`${base}/game/live/nope`)).status, 404);
  });
});

test('a game with no rounds cannot go live', async () => {
  await withServer(async ({ base, db }) => {
    const empty = db.createGame('empty');
    assert.equal((await post(`${base}/game/api/admin/games/${empty.id}/sessions`, undefined, auth)).status, 400);
  });
});

test('join: token, duplicate name 409, bad name 400; state shows you', async () => {
  await withServer(async ({ base, game }) => {
    const { code } = await (await post(`${base}/game/api/admin/games/${game.id}/sessions`, undefined, auth)).json();
    const info = await (await fetch(`${base}/game/live/api/${code}`)).json();
    assert.deepEqual(info, { title: 'Trains', roundCount: 2, state: 'lobby' });
    const j = await post(`${base}/game/live/api/${code}/join`, { name: '  Fer ' });
    assert.equal(j.status, 200);
    const fer = await j.json();
    assert.equal(fer.name, 'Fer');
    assert.match(fer.token, /^[a-f0-9]{32}$/);
    assert.equal((await post(`${base}/game/live/api/${code}/join`, { name: 'fer' })).status, 409);
    assert.equal((await post(`${base}/game/live/api/${code}/join`, { name: '   ' })).status, 400);
    assert.equal((await post(`${base}/game/live/api/nope/join`, { name: 'x' })).status, 404);
    const snap = await (await fetch(`${base}/game/live/api/${code}/state?token=${fer.token}`)).json();
    assert.equal(snap.state, 'lobby');
    assert.equal(snap.round, null);
    assert.equal(snap.reveal, null);
    assert.deepEqual(snap.players, [{ id: fer.playerId, name: 'Fer', answered: false }]);
    assert.deepEqual(snap.you, { playerId: fer.playerId, name: 'Fer' });
    assert.deepEqual(snap.standings, [{ playerId: fer.playerId, name: 'Fer', total: 0 }]);
    const anon = await (await fetch(`${base}/game/live/api/${code}/state`)).json();
    assert.equal(anon.you, null);
  });
});

test('guess only while open and for the current round; upsert; hidden until reveal', async () => {
  await withServer(async ({ base, game }) => {
    const { code } = await (await post(`${base}/game/api/admin/games/${game.id}/sessions`, undefined, auth)).json();
    const fer = await (await post(`${base}/game/live/api/${code}/join`, { name: 'Fer' })).json();
    const ana = await (await post(`${base}/game/live/api/${code}/join`, { name: 'Ana' })).json();
    const guess = (token, ord, lat, lng) => post(`${base}/game/live/api/${code}/guess`, { token, ord, lat, lng });

    assert.equal((await guess(fer.token, 0, 33, 91)).status, 409); // lobby
    let snap = await (await next(base, code)).json();
    assert.equal(snap.state, 'open');
    assert.deepEqual(snap.round, { ord: 0, question: 'Highest station?' });
    assert.equal(snap.reveal, null);

    assert.equal((await guess('badtoken', 0, 33, 91)).status, 401);
    assert.equal((await guess(fer.token, 1, 33, 91)).status, 409); // wrong round
    assert.equal((await guess(fer.token, 0, 95, 91)).status, 400); // bad coords
    const ok = await guess(fer.token, 0, 10, 10);
    assert.equal(ok.status, 200);
    assert.deepEqual(await ok.json(), { ok: true }); // no km/points/truth leak
    assert.equal((await guess(fer.token, 0, 33.0106, 91.6642)).status, 200); // re-tap replaces
    assert.equal((await guess(ana.token, 0, 30, 90)).status, 200);

    snap = await (await fetch(`${base}/game/live/api/${code}/state?token=${fer.token}`)).json();
    assert.deepEqual(snap.players.map((p) => [p.name, p.answered]), [['Fer', true], ['Ana', true]]);
    assert.equal(snap.reveal, null);
    assert.deepEqual(snap.standings.map((s) => s.total), [0, 0]);

    snap = await (await next(base, code)).json();
    assert.equal(snap.state, 'revealed');
    assert.equal(snap.reveal.truth.answer, 'Tanggula');
    assert.equal(snap.reveal.truth.lat, 33.0106);
    assert.equal(snap.reveal.truth.photo, 'a1b2c3d4e5f60718.jpg');
    assert.equal('question' in snap.reveal.truth, false);
    assert.deepEqual(snap.reveal.guesses.map((x) => [x.name, x.km, x.points]), [['Fer', 0, 100], ['Ana', snap.reveal.guesses[1].km, snap.reveal.guesses[1].points]]);
    assert.ok(snap.reveal.guesses[1].km > 100);
    assert.deepEqual(snap.standings.map((s) => [s.name, s.total]), [['Fer', 100], ['Ana', snap.reveal.guesses[1].points]]);
    assert.equal((await guess(fer.token, 0, 1, 1)).status, 409); // closed after reveal
  });
});

test('late joiner scores 0 on earlier rounds; finished → 400 on next; end from any state', async () => {
  await withServer(async ({ base, game }) => {
    const { code } = await (await post(`${base}/game/api/admin/games/${game.id}/sessions`, undefined, auth)).json();
    const fer = await (await post(`${base}/game/live/api/${code}/join`, { name: 'Fer' })).json();
    await next(base, code); // open 0
    await post(`${base}/game/live/api/${code}/guess`, { token: fer.token, ord: 0, lat: 33.0106, lng: 91.6642 });
    await next(base, code); // revealed 0
    await next(base, code); // open 1
    const late = await (await post(`${base}/game/live/api/${code}/join`, { name: 'Late' })).json();
    await post(`${base}/game/live/api/${code}/guess`, { token: late.token, ord: 1, lat: 54.9, lng: -1.6 });
    await next(base, code); // revealed 1
    let snap = await (await next(base, code)).json(); // finished
    assert.equal(snap.state, 'finished');
    assert.equal(snap.round, null);
    assert.deepEqual(snap.standings.map((s) => [s.name, s.total]), [['Fer', 100], ['Late', 100]]);
    assert.equal((await next(base, code)).status, 400);
    assert.equal((await next(base, 'nope')).status, 404);

    const s2 = await (await post(`${base}/game/api/admin/games/${game.id}/sessions`, undefined, auth)).json();
    await next(base, s2.code);
    const ended = await (await post(`${base}/game/api/admin/sessions/${s2.code}/end`, undefined, auth)).json();
    assert.equal(ended.state, 'finished');
  });
});
