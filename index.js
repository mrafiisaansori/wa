require('dotenv').config();
const fs = require('fs');
const path = require('path');
const express = require('express');
const pino = require('pino');
const bcrypt = require('bcryptjs');
const swaggerUi = require('swagger-ui-express');
const basicAuth = require('express-basic-auth');
const { Boom } = require('@hapi/boom');
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  Browsers,
} = require('@whiskeysockets/baileys');
const db = require('./db');
const swaggerAdmin = require('./swagger-admin');
const swaggerApp = require('./swagger-app');

const PORT = process.env.PORT || 3900;
const DOCS_USER = process.env.DOCS_USER;
const DOCS_PASS = process.env.DOCS_PASS;
const APP_DOCS_USER = process.env.APP_DOCS_USER;
const APP_DOCS_PASS = process.env.APP_DOCS_PASS;
const PAIR_NUMBER = process.env.PAIR_NUMBER; // nomor WA tujuan pairing, format 628xxxxxxxxxx (tanpa + / spasi)
// Jeda antar pesan - kunci utama biar tidak kelihatan pola "blasting" ke WhatsApp.
const SEND_DELAY_MS = Number(process.env.SEND_DELAY_MS || 3000);

const logger = pino({ level: process.env.LOG_LEVEL || 'silent' });

let sock;
let authState; // ref ke state.creds - dipakai /pairing-code buat cek sudah registered atau belum
let isReady = false;
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 5;
const RECONNECT_DELAY_MS = 5000; // jeda sebelum reconnect - cegah reconnect storm kalau server WA sedang menolak koneksi

async function logKoneksi(event, detail) {
  try {
    await db.query('INSERT INTO koneksi_log (event, detail) VALUES (?, ?)', [event, detail || null]);
  } catch (err) {
    console.error('[wagateway] gagal catat koneksi_log:', err.message);
  }
}

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

// Baileys WAMessageStatus: ERROR=0, PENDING=1, SERVER_ACK=2, DELIVERY_ACK=3, READ=4, PLAYED=5.
// PENDING/SERVER_ACK tidak diubah - status "terkirim" dari insert awal sudah cukup buat itu.
function mapWAStatus(code) {
  if (code === 0) return 'gagal';
  if (code === 3) return 'delivered';
  if (code === 4 || code === 5) return 'read';
  return null;
}

async function startSock() {
  const { state, saveCreds } = await useMultiFileAuthState('./auth');
  authState = state;

  sock = makeWASocket({
    auth: state,
    logger,
    browser: Browsers.ubuntu('Chrome'),
    printQRInTerminal: false,
  });

  sock.ev.on('creds.update', saveCreds);

  // Update status pengiriman (delivered/read/gagal) begitu WhatsApp ngasih tau -
  // ini yang bikin riwayat_pesan bukan cuma "berhasil dipanggil", tapi status asli.
  sock.ev.on('messages.update', async (updates) => {
    for (const { key, update } of updates) {
      const status = mapWAStatus(update?.status);
      if (!key?.id || !status) continue;
      try {
        await db.query(
          'UPDATE riwayat_pesan SET status = ?, status_update_at = NOW() WHERE wa_message_id = ?',
          [status, key.id]
        );
      } catch (err) {
        console.error('[wagateway] gagal update status pesan:', err.message);
      }
    }
  });

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect } = update;

    if (connection === 'open') {
      isReady = true;
      reconnectAttempts = 0;
      console.log('[wagateway] terhubung ke WhatsApp.');
      logKoneksi('connected');
    }

    if (connection === 'close') {
      isReady = false;
      const statusCode = new Boom(lastDisconnect?.error)?.output?.statusCode;
      const loggedOut = statusCode === DisconnectReason.loggedOut;
      console.log('[wagateway] koneksi terputus.', { statusCode, loggedOut });

      if (loggedOut) {
        // Sesi ditolak WhatsApp (mis. di-unlink dari HP, atau kena force-logout).
        // Bersihkan sesi lama otomatis biar /pairing-code langsung bisa dipakai
        // lagi tanpa perlu restart manual.
        console.log('[wagateway] sesi logout - membersihkan sesi lama, siap pairing ulang.');
        logKoneksi('logged_out', `statusCode ${statusCode}`);
        fs.rmSync('./auth', { recursive: true, force: true });
        reconnectAttempts = 0;
        startSock();
        return;
      }

      logKoneksi('disconnected', `statusCode ${statusCode}`);
      reconnectAttempts += 1;
      if (reconnectAttempts > MAX_RECONNECT_ATTEMPTS) {
        console.error(
          `[wagateway] gagal reconnect ${MAX_RECONNECT_ATTEMPTS}x berturut-turut (statusCode terakhir: ${statusCode}). ` +
          'Berhenti auto-reconnect - kemungkinan VPS tidak bisa konek ke server WhatsApp (cek jaringan/firewall keluar), ' +
          'restart manual setelah dicek: pm2 restart wagateway'
        );
        return;
      }
      console.log(`[wagateway] reconnect percobaan ke-${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS} dalam ${RECONNECT_DELAY_MS / 1000} detik...`);
      setTimeout(startSock, RECONNECT_DELAY_MS);
    }
  });

  if (!state.creds.registered) {
    // Sengaja TIDAK auto-request kode pairing di sini. Kode WhatsApp cuma valid
    // sekitar 60 detik - kalau di-generate otomatis pas proses baru start, sering
    // keburu basi sebelum sempat dibaca dari pm2 logs. Minta kode lewat
    // GET /pairing-code (lewat Swagger /docs/admin) tepat pas HP sudah siap ketik.
    console.log('[wagateway] belum tertaut ke WhatsApp. Buka HP ke layar "Tautkan dengan nomor telepon", lalu panggil GET /pairing-code buat dapat kode barunya.');
  }
}

startSock();

const app = express();
app.use(express.json());
// UI web statis (login + kirim pesan + riwayat) - murni HTML/CSS/JS, tanpa
// build step. Ditaruh sebelum route API biar / kepegang file public/index.html.
app.use(express.static(path.join(__dirname, 'public')));

// ===== Auth admin (operator wagateway) - kredensial tunggal dari .env =====
const requireDocsAuth = DOCS_PASS
  ? basicAuth({ users: { [DOCS_USER || 'admin']: DOCS_PASS }, challenge: true })
  : (req, res) => res.status(503).json({ error: 'Admin auth belum dikonfigurasi (DOCS_PASS kosong di .env)' });

// ===== Auth khusus buka halaman /docs/app - beda dari admin, tapi ini cuma
// gerbang buat LIHAT dokumentasinya. Eksekusi /send & /history di dalamnya
// tetap minta login aplikasi (requireAppAuth) terpisah lagi. =====
const requireAppDocsAuth = APP_DOCS_PASS
  ? basicAuth({ users: { [APP_DOCS_USER || 'app']: APP_DOCS_PASS }, challenge: true })
  : (req, res) => res.status(503).json({ error: 'App docs auth belum dikonfigurasi (APP_DOCS_PASS kosong di .env)' });

// ===== Auth aplikasi (project pemanggil) - dinamis dari tabel `aplikasi` =====
// Ditulis manual (bukan express-basic-auth) karena butuh nempelin data aplikasi
// yang login (req.aplikasi) buat scoping /history, bukan cuma true/false.
async function requireAppAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const [scheme, encoded] = header.split(' ');
  if (scheme !== 'Basic' || !encoded) {
    res.set('WWW-Authenticate', 'Basic realm="wagateway-app"');
    return res.status(401).json({ error: 'Login aplikasi diperlukan (Basic Auth username/password)' });
  }
  const [username, password] = Buffer.from(encoded, 'base64').toString('utf8').split(':');
  try {
    const [rows] = await db.query(
      'SELECT id, nama, password_hash, aktif FROM aplikasi WHERE username = ? LIMIT 1',
      [username]
    );
    const row = rows[0];
    const valid = row && row.aktif && (await bcrypt.compare(password || '', row.password_hash));
    if (!valid) {
      res.set('WWW-Authenticate', 'Basic realm="wagateway-app"');
      return res.status(401).json({ error: 'Username/password aplikasi salah, atau aplikasi nonaktif' });
    }
    req.aplikasi = { id: row.id, nama: row.nama };
    next();
  } catch (err) {
    res.status(500).json({ error: 'Gagal cek login aplikasi: ' + err.message });
  }
}

app.get('/status', (req, res) => {
  res.json({ connected: isReady, antrian: queue.length });
});

// ===== Endpoint aplikasi (butuh login /aplikasi) =====

app.post('/send', requireAppAuth, async (req, res) => {
  const { nomor, pesan } = req.body || {};
  if (!nomor || !pesan) {
    return res.status(400).json({ error: 'nomor dan pesan wajib diisi' });
  }
  const jid = `${String(nomor).replace(/\D/g, '')}@s.whatsapp.net`;

  const [insertResult] = await db.query(
    'INSERT INTO riwayat_pesan (aplikasi_id, nomor_tujuan, pesan, status) VALUES (?, ?, ?, "antri")',
    [req.aplikasi.id, nomor, pesan]
  );
  const riwayatId = insertResult.insertId;

  try {
    const result = await enqueueSend(jid, pesan);
    await db.query(
      'UPDATE riwayat_pesan SET status = "terkirim", wa_message_id = ?, dikirim_at = NOW() WHERE id = ?',
      [result?.key?.id || null, riwayatId]
    );
    res.json({ success: true, id: riwayatId });
  } catch (err) {
    await db.query(
      'UPDATE riwayat_pesan SET status = "gagal", error_pesan = ? WHERE id = ?',
      [String(err.message).slice(0, 250), riwayatId]
    );
    res.status(500).json({ error: err.message });
  }
});

app.get('/history', requireAppAuth, async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 50, 200);
  const [rows] = await db.query(
    `SELECT id, nomor_tujuan, pesan, status, error_pesan, dibuat_at
     FROM riwayat_pesan WHERE aplikasi_id = ? ORDER BY id DESC LIMIT ${limit}`,
    [req.aplikasi.id]
  );
  res.json(rows);
});

// ===== Endpoint admin (butuh login admin) =====

app.get('/pairing-code', requireDocsAuth, async (req, res) => {
  if (!sock) return res.status(503).json({ error: 'Socket belum siap, coba beberapa detik lagi' });
  if (authState?.creds?.registered) {
    return res.status(400).json({ error: 'Sudah tertaut ke WhatsApp - tidak perlu pairing lagi' });
  }
  const nomor = req.query.nomor || PAIR_NUMBER;
  if (!nomor) {
    return res.status(400).json({ error: 'Isi PAIR_NUMBER di .env, atau kirim ?nomor=628xxxxxxxxxx' });
  }
  try {
    const code = await sock.requestPairingCode(nomor);
    logKoneksi('pairing_requested', nomor);
    res.json({ code, catatan: 'Berlaku sekitar 60 detik - langsung masukkan di HP: WhatsApp > Perangkat Tertaut > Tautkan dengan nomor telepon.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/admin/aplikasi', requireDocsAuth, async (req, res) => {
  const { username, password, nama } = req.body || {};
  if (!username || !password || !nama) {
    return res.status(400).json({ error: 'username, password, nama wajib diisi' });
  }
  try {
    const hash = await bcrypt.hash(password, 10);
    const [result] = await db.query(
      'INSERT INTO aplikasi (username, password_hash, nama) VALUES (?, ?, ?)',
      [username, hash, nama]
    );
    res.status(201).json({ id: result.insertId, username, nama });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') {
      return res.status(400).json({ error: 'Username sudah dipakai' });
    }
    res.status(500).json({ error: err.message });
  }
});

app.get('/admin/aplikasi', requireDocsAuth, async (req, res) => {
  const [rows] = await db.query('SELECT id, username, nama, aktif, dibuat_at FROM aplikasi ORDER BY id DESC');
  res.json(rows);
});

app.get('/admin/koneksi-log', requireDocsAuth, async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 50, 200);
  const [rows] = await db.query(`SELECT * FROM koneksi_log ORDER BY id DESC LIMIT ${limit}`);
  res.json(rows);
});

// Dua Swagger UI terpisah, dua kredensial beda buat sekadar MELIHAT halamannya:
// /docs/admin (pairing, status koneksi, kelola aplikasi) pakai login admin,
// /docs/app (kirim pesan & riwayat) pakai login app-docs sendiri. Eksekusi
// endpoint di /docs/app tetap minta login aplikasi lagi (requireAppAuth),
// jadi ini murni gerbang "siapa yang boleh lihat dokumentasinya".
if (DOCS_PASS) {
  app.use('/docs/admin', requireDocsAuth, swaggerUi.serveFiles(swaggerAdmin), swaggerUi.setup(swaggerAdmin));
} else {
  console.warn('[wagateway] DOCS_PASS belum diset di .env - /docs/admin, /pairing-code, dan /admin/* dinonaktifkan.');
}

if (APP_DOCS_PASS) {
  app.use('/docs/app', requireAppDocsAuth, swaggerUi.serveFiles(swaggerApp), swaggerUi.setup(swaggerApp));
} else {
  console.warn('[wagateway] APP_DOCS_PASS belum diset di .env - /docs/app dinonaktifkan.');
}

app.listen(PORT, () => console.log(`[wagateway] API jalan di port ${PORT}`));
