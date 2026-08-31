process.env.ADMIN_TOKEN = 's3cret'; // before config loads, so basicAuth is enabled in this process
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const { createApp } = require('../src/web');
const { openDb } = require('../src/db');
const { toDateStr } = require('../src/parser');
const users = require('../src/users');

async function withServer(fn, db = openDb(':memory:')) {
  const app = createApp(db, { whatsappConnected: true, lastMessageAt: null });
  const server = app.listen(0);
  try { return await fn(`http://127.0.0.1:${server.address().port}`); }
  finally { server.close(); }
}
const authHeader = (pass) => 'Basic ' + Buffer.from('admin:' + pass).toString('base64');

test('settings API rejects missing and wrong credentials', async () => {
  await withServer(async (base) => {
    assert.strictEqual((await fetch(`${base}/api/settings`)).status, 401);
    assert.strictEqual((await fetch(`${base}/api/settings`, { headers: { authorization: authHeader('nope') } })).status, 401);
  });
});

test('settings API returns state with the right password', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/settings`, { headers: { authorization: authHeader('s3cret') } });
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(typeof body.dailySummary, 'boolean');
    assert.strictEqual(typeof body.weeklySummary, 'boolean');
  });
});

// Monitoring depends on the status code, not the body — if this regresses to a
// flat 200 the Uptime Kuma check goes green forever while nothing is recorded.
async function healthz(whatsappConnected) {
  const app = createApp(openDb(':memory:'), { whatsappConnected, lastMessageAt: null });
  const server = app.listen(0);
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/healthz`);
    return { code: res.status, body: await res.json() };
  } finally {
    server.close();
  }
}

test('healthz is 200 when WhatsApp is connected', async () => {
  const { code, body } = await healthz(true);
  assert.strictEqual(code, 200);
  assert.strictEqual(body.status, 'ok');
  assert.strictEqual(body.whatsappConnected, true);
});

test('daily summary falls back to yesterday when today has no results yet', async () => {
  const db = openDb(':memory:');
  const y = new Date(); y.setDate(y.getDate() - 1);
  db.upsertResult({
    play_date: toDateStr(y), player_id: 'ada@lid', player_name: 'Ada',
    round1: 90, round2: 90, round3: 90, round4: 90, round5: 90,
    final_score: 450, raw_text: 'x', created_at: new Date().toISOString(),
  });
  try {
    users.save({ users: [{ name: 'Ada', ids: ['ada@lid'] }] });
    await withServer(async (base) => {
      const res = await fetch(`${base}/admin/summary?kind=daily`, { headers: { authorization: authHeader('s3cret') } });
      assert.strictEqual(res.status, 200);
      assert.match(await res.text(), /Ada/);
    }, db);
  } finally { fs.rmSync(users.FILE, { force: true }); }
});

test('/api/globe: only active players with coords, layers shape', async () => {
  try {
    users.save({ users: [
      { name: 'Ana',  ids: [], city: 'Porto', country: 'Portugal', lat: 41.15, lng: -8.61 },
      { name: 'Ben',  ids: [], city: 'Basel', lat: 47.56, lng: 7.59 }, // saved before country existed
      { name: 'Gone', ids: [], city: 'Berlin', lat: 52.5, lng: 13.4, active: false },
      { name: 'Nocity', ids: [] },
    ] });
    await withServer(async (base) => {
      const res = await fetch(`${base}/api/globe`);
      assert.strictEqual(res.status, 200);
      const body = await res.json();
      assert.strictEqual(body.layers.length, 1);
      assert.strictEqual(body.layers[0].id, 'birthplaces');
      assert.deepStrictEqual(body.layers[0].points, [
        { label: 'Ana', city: 'Porto', country: 'Portugal', lat: 41.15, lng: -8.61 },
        { label: 'Ben', city: 'Basel', lat: 47.56, lng: 7.59 },
      ]);
    });
  } finally { fs.rmSync(users.FILE, { force: true }); }
});

test('upload: auth required, images only, random name, served back', async () => {
  await withServer(async (base) => {
    const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex'); // fake png bytes
    assert.strictEqual((await fetch(`${base}/api/upload`, {
      method: 'POST', headers: { 'content-type': 'image/png' }, body: png,
    })).status, 401);
    assert.strictEqual((await fetch(`${base}/api/upload`, {
      method: 'POST',
      headers: { authorization: authHeader('s3cret'), 'content-type': 'text/html' },
      body: 'nope',
    })).status, 400);
    const res = await fetch(`${base}/api/upload`, {
      method: 'POST',
      headers: { authorization: authHeader('s3cret'), 'content-type': 'image/png' },
      body: png,
    });
    assert.strictEqual(res.status, 200);
    const { file } = await res.json();
    assert.match(file, /^[a-f0-9]{16}\.png$/);
    try {
      const got = await fetch(`${base}/uploads/${file}`);
      assert.strictEqual(got.status, 200);
      assert.deepEqual(Buffer.from(await got.arrayBuffer()), png);
    } finally { fs.rmSync(`data/uploads/${file}`, { force: true }); }
  });
});

test('healthz is 503 when WhatsApp is down', async () => {
  const { code, body } = await healthz(false);
  assert.strictEqual(code, 503);
  assert.strictEqual(body.status, 'degraded');
  assert.strictEqual(body.whatsappConnected, false);
});
