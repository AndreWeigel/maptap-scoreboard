process.env.ADMIN_TOKEN = 's3cret'; // before config loads, so basicAuth is enabled in this process
process.env.FRIENDS_TOKEN = 'friends'; // ditto for the globe/photos gate
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const { createApp, seasonsAsOf } = require('../src/web');
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

test('/api/globe: locked to friends, only active players with coords, layers shape', async () => {
  try {
    users.save({ users: [
      { name: 'Ana',  ids: [], city: 'Porto', country: 'Portugal', lat: 41.15, lng: -8.61,
        story: 'Loves maps.', photos: [{ file: 'a1b2c3d4e5f60718.jpg', caption: 'Beach' }] },
      { name: 'Ben',  ids: [], city: 'Basel', lat: 47.56, lng: 7.59 }, // saved before country existed
      { name: 'Gone', ids: [], city: 'Berlin', lat: 52.5, lng: 13.4, active: false },
      { name: 'Nocity', ids: [] },
    ] });
    await withServer(async (base) => {
      assert.strictEqual((await fetch(`${base}/api/globe`)).status, 401);
      const res = await fetch(`${base}/api/globe`, { headers: { authorization: authHeader('friends') } });
      assert.strictEqual(res.status, 200);
      const body = await res.json();
      assert.strictEqual(body.layers.length, 1);
      assert.strictEqual(body.layers[0].id, 'birthplaces');
      assert.deepStrictEqual(body.layers[0].points, [
        { label: 'Ana', city: 'Porto', country: 'Portugal', lat: 41.15, lng: -8.61,
          story: 'Loves maps.', photos: [{ file: 'a1b2c3d4e5f60718.jpg', caption: 'Beach' }] },
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
      assert.strictEqual((await fetch(`${base}/uploads/${file}`)).status, 401);
      const got = await fetch(`${base}/uploads/${file}`, { headers: { authorization: authHeader('friends') } });
      assert.strictEqual(got.status, 200);
      assert.deepEqual(Buffer.from(await got.arrayBuffer()), png);
      // The admin password opens the friends door too (so /users and the game builder still preview).
      assert.strictEqual((await fetch(`${base}/uploads/${file}`,
        { headers: { authorization: authHeader('s3cret') } })).status, 200);
    } finally { fs.rmSync(`data/uploads/${file}`, { force: true }); }
  });
});

test('seasons: back-to-back ranges, unstarted ones hidden, ?season= picks one', async () => {
  const list = [{ name: 'S1', from: '2026-01-01' }, { name: 'Autumn', from: '2026-09-23' }, { name: 'Next', from: '2027-01-01' }];
  const spans = (today) => seasonsAsOf(list, today).map((s) => [s.id, s.from, s.to]);
  assert.deepStrictEqual(spans('2026-09-15'), [[1, '2026-01-01', '2026-09-15']]);
  assert.deepStrictEqual(spans('2026-09-23'), [[1, '2026-01-01', '2026-09-22'], [2, '2026-09-23', '2026-09-23']]);
  assert.deepStrictEqual(spans('2027-02-01'), [
    [1, '2026-01-01', '2026-09-22'], [2, '2026-09-23', '2026-12-31'], [3, '2027-01-01', '2027-02-01']]);

  await withServer(async (base) => {
    const live = await (await fetch(`${base}/api/standings`)).json();
    assert.strictEqual(live.season.id, live.seasons.length);
    const first = await (await fetch(`${base}/api/standings?season=1`)).json();
    assert.deepStrictEqual(first.range, { from: first.seasons[0].from, to: first.seasons[0].to });
  });
});

test('/ stamps the live season theme on <html>, and only while that season is live', async () => {
  const config = require('../config');
  const saved = config.SEASONS;
  try {
    await withServer(async (base) => {
      config.SEASONS = [{ name: 'S1', from: '2000-01-01' }, { name: 'S2', from: '2000-06-01', theme: 'autumn' }];
      assert.match(await (await fetch(base)).text(), /<html lang="en" data-theme="autumn">/);
      config.SEASONS = [{ name: 'S1', from: '2000-01-01', theme: 'autumn' }, { name: 'S2', from: '2000-06-01' }];
      assert.match(await (await fetch(base)).text(), /<html lang="en">/); // past season's theme doesn't stick
    });
  } finally { config.SEASONS = saved; }
});

test('healthz is 503 when WhatsApp is down', async () => {
  const { code, body } = await healthz(false);
  assert.strictEqual(code, 503);
  assert.strictEqual(body.status, 'degraded');
  assert.strictEqual(body.whatsappConnected, false);
});

// Public write endpoint — the only unauthenticated thing that touches the DB,
// so the validation is what keeps junk out.
test('feedback: stores valid posts, rejects junk, and stays admin-only to read', async () => {
  const db = openDb(':memory:');
  await withServer(async (base) => {
    const post = (body) => fetch(`${base}/api/feedback`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });

    const good = { kind: 'bug', message: 'the globe is upside down', sender: 'Hen', email: 'hen@example.com' };
    assert.strictEqual((await post(good)).status, 200);
    assert.strictEqual((await post({ ...good, kind: 'wat' })).status, 400);      // kind off the list
    assert.strictEqual((await post({ ...good, message: '   ' })).status, 400);   // blank after trim
    assert.strictEqual((await post({ ...good, sender: '  ' })).status, 400);     // name now required
    assert.strictEqual((await post({ ...good, email: '' })).status, 400);        // email now required
    assert.strictEqual((await post({ ...good, email: 'hen@example' })).status, 400);  // no dot in domain
    assert.strictEqual((await post({ ...good, email: 'not an email' })).status, 400);

    const rows = db.listFeedback();
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].message, 'the globe is upside down');
    assert.strictEqual(rows[0].sender, 'Hen');
    assert.strictEqual(rows[0].email, 'hen@example.com');

    // Long messages are truncated, not rejected, so a rambler still gets through.
    await post({ ...good, kind: 'other', message: 'x'.repeat(5000) });
    assert.strictEqual(db.listFeedback()[0].message.length, 4000);

    assert.strictEqual((await fetch(`${base}/admin/feedback`)).status, 401);
    const ok = await fetch(`${base}/admin/feedback`, { headers: { authorization: authHeader('s3cret') } });
    assert.strictEqual(ok.status, 200);
    assert.match(await ok.text(), /the globe is upside down/);
  }, db);
});
