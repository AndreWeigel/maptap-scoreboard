const test = require('node:test');
const assert = require('node:assert');
const { createApp } = require('../src/web');
const { openDb } = require('../src/db');

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
