process.env.ADMIN_TOKEN = 's3cret'; // before config loads, so basicAuth is enabled in this process
const test = require('node:test');
const assert = require('node:assert');
const { createApp } = require('../src/web');
const { openDb } = require('../src/db');

async function withServer(fn) {
  const app = createApp(openDb(':memory:'), { whatsappConnected: true, lastMessageAt: null });
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

test('healthz is 503 when WhatsApp is down', async () => {
  const { code, body } = await healthz(false);
  assert.strictEqual(code, 503);
  assert.strictEqual(body.status, 'degraded');
  assert.strictEqual(body.whatsappConnected, false);
});
