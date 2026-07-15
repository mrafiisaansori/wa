require('dotenv').config();
const express = require('express');
const pino = require('pino');
const swaggerUi = require('swagger-ui-express');
const basicAuth = require('express-basic-auth');
const { Boom } = require('@hapi/boom');
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  Browsers,
} = require('@whiskeysockets/baileys');
const swaggerSpec = require('./swagger');

const PORT = process.env.PORT || 3900;
const API_KEY = process.env.API_KEY;
const DOCS_USER = process.env.DOCS_USER;
const DOCS_PASS = process.env.DOCS_PASS;
const PAIR_NUMBER = process.env.PAIR_NUMBER; // nomor WA tujuan pairing, format 628xxxxxxxxxx (tanpa + / spasi)
// Jeda antar pesan - kunci utama biar tidak kelihatan pola "blasting" ke WhatsApp.
const SEND_DELAY_MS = Number(process.env.SEND_DELAY_MS || 3000);

const logger = pino({ level: process.env.LOG_LEVEL || 'silent' });

let sock;
let isReady = false;

// ponytail: antrian in-memory, cukup untuk 1 proses/1 nomor. Kalau nanti perlu
// multi-nomor atau proses paralel, ganti ke queue eksternal (BullMQ + Redis).
const queue = [];
let processing = false;

function enqueueSend(jid, message) {
  return new Promise((resolve, reject) => {
    queue.push({ jid, message, resolve, reject });
    processQueue();
  });
}

async function processQueue() {
  if (processing || queue.length === 0) return;
  processing = true;
  const { jid, message, resolve, reject } = queue.shift();
  try {
    if (!isReady) throw new Error('WA belum terhubung');
    const result = await sock.sendMessage(jid, { text: message });
    resolve(result);
  } catch (err) {
    reject(err);
  } finally {
    processing = false;
    if (queue.length > 0) setTimeout(processQueue, SEND_DELAY_MS);
  }
}

async function startSock() {
  const { state, saveCreds } = await useMultiFileAuthState('./auth');

  sock = makeWASocket({
    auth: state,
    logger,
    browser: Browsers.ubuntu('Chrome'),
    printQRInTerminal: false,
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect } = update;

    if (connection === 'open') {
      isReady = true;
      console.log('[wagateway] terhubung ke WhatsApp.');
    }

    if (connection === 'close') {
      isReady = false;
      const statusCode = new Boom(lastDisconnect?.error)?.output?.statusCode;
      const loggedOut = statusCode === DisconnectReason.loggedOut;
      console.log('[wagateway] koneksi terputus.', { statusCode, loggedOut });
      if (!loggedOut) {
        startSock(); // reconnect otomatis (drop koneksi sementara, dsb)
      } else {
        console.log('[wagateway] sesi logout dari HP - hapus folder ./auth lalu pairing ulang.');
      }
    }
  });

  // Minta kode pairing sekali saja, waktu sesi belum pernah ter-register.
  if (!state.creds.registered) {
    if (!PAIR_NUMBER) {
      console.log('[wagateway] belum pairing dan PAIR_NUMBER belum diisi di .env - isi dulu lalu restart.');
      return;
    }
    setTimeout(async () => {
      try {
        const code = await sock.requestPairingCode(PAIR_NUMBER);
        console.log('==================================================');
        console.log('[wagateway] KODE PAIRING:', code);
        console.log('Buka WhatsApp di HP -> Perangkat Tertaut -> Tautkan dengan nomor telepon -> masukkan kode di atas.');
        console.log('==================================================');
      } catch (err) {
        console.error('[wagateway] gagal minta kode pairing:', err.message);
      }
    }, 3000);
  }
}

startSock();

const app = express();
app.use(express.json());

function requireApiKey(req, res, next) {
  if (!API_KEY) {
    console.warn('[wagateway] API_KEY belum diset - endpoint /send TIDAK terproteksi. Isi API_KEY sebelum production.');
    return next();
  }
  if (req.headers['x-api-key'] !== API_KEY) {
    return res.status(401).json({ error: 'API key tidak valid' });
  }
  next();
}

app.get('/status', (req, res) => {
  res.json({ connected: isReady, antrian: queue.length });
});

app.post('/send', requireApiKey, async (req, res) => {
  const { nomor, pesan, source } = req.body || {};
  if (!nomor || !pesan) {
    return res.status(400).json({ error: 'nomor dan pesan wajib diisi' });
  }
  const jid = `${String(nomor).replace(/\D/g, '')}@s.whatsapp.net`;
  console.log(`[wagateway] kirim -> ${jid}${source ? ` (source: ${source})` : ''}`);
  try {
    await enqueueSend(jid, pesan);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Swagger UI buat testing manual - digembok Basic Auth (bukan API key) karena
// ini konsol interaktif buat manusia, bukan dipanggil dari kode project lain.
if (DOCS_PASS) {
  app.use(
    '/docs',
    basicAuth({ users: { [DOCS_USER || 'admin']: DOCS_PASS }, challenge: true }),
    swaggerUi.serve,
    swaggerUi.setup(swaggerSpec)
  );
} else {
  console.warn('[wagateway] DOCS_PASS belum diset di .env - Swagger UI (/docs) dinonaktifkan.');
}

app.listen(PORT, () => console.log(`[wagateway] API jalan di port ${PORT}`));
