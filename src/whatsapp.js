const {
  default: makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason,
} = require('@whiskeysockets/baileys');
const pino = require('pino');
const qrcode = require('qrcode-terminal');
const config = require('../config');
const { ingestMessage } = require('./ingest');

function extractText(msg) {
  const m = msg.message?.ephemeralMessage?.message ?? msg.message;
  return m?.conversation || m?.extendedTextMessage?.text || '';
}

async function startWhatsApp(db, status) {
  const { state, saveCreds } = await useMultiFileAuthState(config.AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: 'warn' }),
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      console.log('Scan this QR with WhatsApp (Linked devices > Link a device):');
      qrcode.generate(qr, { small: true });
    }
    if (connection === 'open') {
      status.whatsappConnected = true;
      console.log('[whatsapp] connected');
      if (!config.GROUP_ID) {
        console.log('[whatsapp] GROUP_ID is empty — post a message in the target group; its JID will be logged. Copy it into config.js and restart.');
      }
    }
    if (connection === 'close') {
      status.whatsappConnected = false;
      const code = lastDisconnect?.error?.output?.statusCode;
      if (code === DisconnectReason.loggedOut) {
        console.error('[whatsapp] logged out — delete data/auth and restart to re-scan the QR.');
      } else {
        console.log(`[whatsapp] connection closed (${code}), reconnecting…`);
        startWhatsApp(db, status);
      }
    }
  });

  sock.ev.on('messages.upsert', ({ messages }) => {
    for (const msg of messages) {
      const jid = msg.key.remoteJid;
      if (!jid) continue;
      if (!config.GROUP_ID && jid.endsWith('@g.us')) {
        console.log(`[whatsapp] group message seen — JID: ${jid}`);
        continue;
      }
      if (jid !== config.GROUP_ID) continue;

      const text = extractText(msg);
      if (!text) continue;
      status.lastMessageAt = new Date().toISOString();

      const playerId = msg.key.participant || jid; // own posts (fromMe) count too
      const playerName = msg.pushName || playerId.split('@')[0];
      // message timestamp, not wall clock, so history-sync replays date correctly
      const now = msg.messageTimestamp ? new Date(Number(msg.messageTimestamp) * 1000) : new Date();
      const res = ingestMessage(db, { playerId, playerName, text, now });
      if (res.kind === 'ok') console.log(`[whatsapp] recorded ${playerName} for ${res.playDate}`);
    }
  });

  return sock;
}

module.exports = { startWhatsApp };
