require('dotenv').config();
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const session = require('express-session');
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
const QRCode = require('qrcode');
const db = require('./db');
const swaggerAdmin = require('./swagger-admin');
const swaggerApp = require('./swagger-app');
const { jitterDelay, sisaKuotaBroadcast } = require('./broadcast-utils');

const PORT = process.env.PORT || 3900;
const DOCS_USER = process.env.DOCS_USER;
const DOCS_PASS = process.env.DOCS_PASS;
const APP_DOCS_USER = process.env.APP_DOCS_USER;
const APP_DOCS_PASS = process.env.APP_DOCS_PASS;
// Jeda antar pesan diacak dalam rentang ini - kunci utama biar tidak kelihatan
// pola "blasting" ke WhatsApp (delay tetap = pola robot yang gampang dikenali).
const SEND_DELAY_MIN_MS = Number(process.env.SEND_DELAY_MIN_MS || 2500);
const SEND_DELAY_MAX_MS = Number(process.env.SEND_DELAY_MAX_MS || 6000);
const BROADCAST_DAILY_LIMIT = Number(process.env.BROADCAST_DAILY_LIMIT || 200);
const BROADCAST_MAX_PER_CALL = 500;

// ponytail: kalau SESSION_SECRET tidak diisi, generate acak tiap boot supaya
// server tetap jalan (bukan crash) - konsekuensinya semua sesi login putus
// tiap restart. Isi SESSION_SECRET di .env untuk sesi yang bertahan lintas restart.
const SESSION_SECRET = process.env.SESSION_SECRET || (() => {
  console.warn('[wagateway] SESSION_SECRET kosong di .env - pakai secret acak sementara (sesi login putus tiap restart).');
  return crypto.randomBytes(32).toString('hex');
})();

const logger = pino({ level: process.env.LOG_LEVEL || 'silent' });

// ===== Tenant registry: 1 aplikasi = 1 koneksi WA sendiri =====
// ponytail: Map in-memory dalam 1 proses, cukup untuk skala puluhan tenant.
// Kalau nanti perlu proses/worker terpisah per tenant (skala ratusan), pisah ke situ.
const tenants = new Map(); // aplikasi_id -> tenant state

function newTenantState() {
  return { sock: null, authState: null, isReady: false, reconnectAttempts: 0, queue: [], processing: false, terhubungSejak: null, qr: null };
}

// Nama device yang dikirim ke WhatsApp saat pairing - ini yang muncul di HP
// pemilik nomor, di daftar "Perangkat Tertaut". Dipakai juga di makeWASocket()
// di bawah supaya info di /device konsisten sama yang tampil di HP.
const NAMA_PERANGKAT = 'Chrome (Ubuntu)';

function getTenant(aplikasiId) {
  let tenant = tenants.get(aplikasiId);
  if (!tenant) {
    tenant = newTenantState();
    tenants.set(aplikasiId, tenant);
  }
  return tenant;
}

function authFolder(aplikasiId) {
  return path.join(__dirname, 'auth', String(aplikasiId));
}

// Exponential backoff, TIDAK PERNAH menyerah total - cuma jarak antar percobaan
// makin lama kalau terus gagal (cegah reconnect storm), sampai maksimal 5 menit.
const BASE_RECONNECT_DELAY_MS = 5000;
const MAX_RECONNECT_DELAY_MS = 5 * 60 * 1000;
function nextReconnectDelay(attempt) {
  const delay = BASE_RECONNECT_DELAY_MS * (2 ** Math.min(attempt - 1, 6));
  return Math.min(delay, MAX_RECONNECT_DELAY_MS);
}

async function logKoneksi(aplikasiId, event, detail) {
  try {
    await db.query('INSERT INTO koneksi_log (aplikasi_id, event, detail) VALUES (?, ?, ?)', [aplikasiId, event, detail || null]);
  } catch (err) {
    console.error('[wagateway] gagal catat koneksi_log:', err.message);
  }
}

function enqueueSend(tenant, jid, message) {
  return new Promise((resolve, reject) => {
    tenant.queue.push({ jid, message, resolve, reject });
    processQueue(tenant);
  });
}

async function processQueue(tenant) {
  if (tenant.processing || tenant.queue.length === 0) return;
  tenant.processing = true;
  const { jid, message, resolve, reject } = tenant.queue.shift();
  try {
    if (!tenant.isReady) throw new Error('WA belum terhubung');
    const result = await tenant.sock.sendMessage(jid, { text: message });
    resolve(result);
  } catch (err) {
    reject(err);
  } finally {
    tenant.processing = false;
    if (tenant.queue.length > 0) setTimeout(() => processQueue(tenant), jitterDelay(SEND_DELAY_MIN_MS, SEND_DELAY_MAX_MS));
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

async function startSock(aplikasiId) {
  const tenant = getTenant(aplikasiId);
  const { state, saveCreds } = await useMultiFileAuthState(authFolder(aplikasiId));
  tenant.authState = state;

  const sock = makeWASocket({
    auth: state,
    logger,
    browser: Browsers.ubuntu('Chrome'),
    printQRInTerminal: false,
  });
  tenant.sock = sock;

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

    // Baileys nerbitin QR baru tiap ~20-60 detik selama belum registered,
    // di luar/bareng jalur pairing-code - dua-duanya jalan dari socket yang
    // sama, tenant tinggal pilih mau pakai yang mana dari dashboard.
    if (update.qr) {
      tenant.qr = update.qr;
    }

    if (connection === 'open') {
      tenant.isReady = true;
      tenant.reconnectAttempts = 0;
      tenant.terhubungSejak = new Date();
      tenant.qr = null;
      console.log(`[wagateway] aplikasi #${aplikasiId} terhubung ke WhatsApp.`);
      logKoneksi(aplikasiId, 'connected');
    }

    if (connection === 'close') {
      tenant.isReady = false;
      tenant.terhubungSejak = null;
      const statusCode = new Boom(lastDisconnect?.error)?.output?.statusCode;
      const loggedOut = statusCode === DisconnectReason.loggedOut;
      console.log(`[wagateway] aplikasi #${aplikasiId} koneksi terputus.`, { statusCode, loggedOut });

      if (loggedOut) {
        // Sesi ditolak WhatsApp (mis. di-unlink dari HP, atau kena force-logout).
        // Bersihkan sesi lama otomatis biar /device/pairing-code langsung bisa
        // dipakai lagi tanpa perlu restart manual.
        console.log(`[wagateway] aplikasi #${aplikasiId} sesi logout - membersihkan sesi lama, siap pairing ulang.`);
        logKoneksi(aplikasiId, 'logged_out', `statusCode ${statusCode}`);
        fs.rmSync(authFolder(aplikasiId), { recursive: true, force: true });
        tenant.reconnectAttempts = 0;
        tenant.qr = null;
        startSock(aplikasiId);
        return;
      }

      logKoneksi(aplikasiId, 'disconnected', `statusCode ${statusCode}`);
      tenant.reconnectAttempts += 1;
      const delay = nextReconnectDelay(tenant.reconnectAttempts);
      if (tenant.reconnectAttempts > 5) {
        console.warn(`[wagateway] aplikasi #${aplikasiId} sudah gagal reconnect ${tenant.reconnectAttempts}x berturut-turut (statusCode terakhir: ${statusCode}) - tetap dicoba terus, jarak makin lama.`);
      }
      console.log(`[wagateway] aplikasi #${aplikasiId} reconnect percobaan ke-${tenant.reconnectAttempts} dalam ${Math.round(delay / 1000)} detik...`);
      setTimeout(() => startSock(aplikasiId), delay);
    }
  });

  if (!state.creds.registered) {
    // Sengaja TIDAK auto-request kode pairing di sini. Kode WhatsApp cuma valid
    // sekitar 60 detik - kalau di-generate otomatis pas proses baru start, sering
    // keburu basi sebelum sempat dibaca. Minta kode lewat POST /device/pairing-code
    // tepat pas HP sudah siap ketik.
    console.log(`[wagateway] aplikasi #${aplikasiId} belum tertaut ke WhatsApp. Minta kode lewat POST /device/pairing-code.`);
  }
}

async function startAllTenants() {
  const [rows] = await db.query('SELECT id FROM aplikasi WHERE aktif = 1');
  for (const row of rows) {
    startSock(row.id).catch((err) => console.error(`[wagateway] gagal start socket aplikasi #${row.id}:`, err.message));
  }
}

startAllTenants().catch((err) => console.error('[wagateway] gagal load daftar aplikasi saat startup:', err.message));

const app = express();
// Di belakang reverse proxy (nginx dsb di VPS) - biar Express baca header
// X-Forwarded-Proto dan tau koneksi aslinya HTTPS meski proxy connect ke
// Node lewat HTTP biasa. Tanpa ini, cookie session "secure" di bawah bisa
// gagal diset browser walau situsnya sudah https (kelihatannya kayak "gabisa
// login" - login sukses tapi sesinya nggak nempel).
app.set('trust proxy', 1);
app.use(express.json());
app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax', secure: 'auto' },
}));
// UI web statis (landing, login, register, dashboard) - murni HTML/CSS/JS,
// tanpa build step. `extensions: ['html']` bikin /login, /register,
// /dashboard otomatis ke-resolve ke login.html/register.html/dashboard.html
// (routing doang, bukan endpoint/logic baru). Ditaruh sebelum route API biar
// / kepegang file public/index.html (landing page).
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));

// Sub-route dashboard (/dashboard/perangkat, dst) - client-side routing pakai
// history.pushState di dashboard.js, jadi tiap menu bisa direfresh langsung
// tanpa balik ke section Dashboard. Ini cuma nyajiin shell HTML yang sama
// (dashboard.js yang baca URL dan render section yang sesuai) - bukan
// endpoint/logic baru, murni routing biar URL tetap benar pas di-refresh.
app.get(['/dashboard/perangkat', '/dashboard/pesan', '/dashboard/apikey'], (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

// ===== Auth admin (operator wagateway) - kredensial tunggal dari .env, buat
// provisioning tenant baru. Ini BUKAN akun tenant. =====
const requireDocsAuth = DOCS_PASS
  ? basicAuth({ users: { [DOCS_USER || 'admin']: DOCS_PASS }, challenge: true })
  : (req, res) => res.status(503).json({ error: 'Admin auth belum dikonfigurasi (DOCS_PASS kosong di .env)' });

// ===== Auth aplikasi (tenant) - dua kredensial TERPISAH dengan sengaja:
// username/password (bcrypt) cuma buat login sesi dashboard (POST /login,
// /register), API key (SHA-256, Bearer token) cuma buat panggil REST API
// (/send, /broadcast, /history, /stats, /device/*). Bocor satu tidak
// otomatis bocorin yang lain, dan API key bisa dicabut tanpa ganti password. =====
async function loadAplikasi(username, password) {
  const [rows] = await db.query(
    'SELECT id, nama, password_hash, aktif FROM aplikasi WHERE username = ? LIMIT 1',
    [username]
  );
  const row = rows[0];
  const valid = row && row.aktif && (await bcrypt.compare(password || '', row.password_hash));
  return valid ? { id: row.id, nama: row.nama } : null;
}

async function loadAplikasiFromSession(req) {
  if (!req.session?.aplikasiId) return null;
  const [rows] = await db.query('SELECT id, nama, aktif FROM aplikasi WHERE id = ? LIMIT 1', [req.session.aplikasiId]);
  const row = rows[0];
  if (!row || !row.aktif) return null;
  return { id: row.id, nama: row.nama };
}

const API_KEY_PREFIX = 'wzp_live_';
function generateApiKeyString() {
  return API_KEY_PREFIX + crypto.randomBytes(24).toString('hex');
}
function hashApiKey(key) {
  return crypto.createHash('sha256').update(key).digest('hex');
}

// Dipakai admin (POST /admin/aplikasi) MAUPUN pendaftaran mandiri (POST
// /register) - satu jalur pembuatan tenant, supaya socket-nya selalu ikut
// disiapkan (startSock) di manapun tenant itu dibuat.
async function createAplikasi(username, password, nama) {
  const hash = await bcrypt.hash(password, 10);
  const [result] = await db.query(
    'INSERT INTO aplikasi (username, password_hash, nama) VALUES (?, ?, ?)',
    [username, hash, nama]
  );
  startSock(result.insertId).catch((err) => console.error(`[wagateway] gagal start socket aplikasi #${result.insertId}:`, err.message));
  return result.insertId;
}

// Endpoint aplikasi (/send, /broadcast, /history, /stats, /device/*) - terima
// sesi dashboard ATAU API key Bearer. ponytail: SENGAJA tidak set header
// WWW-Authenticate di 401 manapun di sini - browser bisa nampilin dialog
// login native-nya sendiri kalau header itu ada, nimpa form login custom kita.
async function requireAppAuth(req, res, next) {
  try {
    const sessionAplikasi = await loadAplikasiFromSession(req);
    if (sessionAplikasi) { req.aplikasi = sessionAplikasi; return next(); }
    if (req.session?.aplikasiId) {
      return req.session.destroy(() => res.status(401).json({ error: 'Sesi tidak valid, silakan login lagi' }));
    }
  } catch (err) {
    return res.status(500).json({ error: 'Gagal cek sesi: ' + err.message });
  }

  const header = req.headers.authorization || '';
  const [scheme, token] = header.split(' ');
  if (scheme !== 'Bearer' || !token) {
    return res.status(401).json({ error: 'Login aplikasi diperlukan (API key Bearer token, atau login sesi)' });
  }
  try {
    const hash = hashApiKey(token.trim());
    const [rows] = await db.query('SELECT id, nama, aktif FROM aplikasi WHERE api_key_hash = ? LIMIT 1', [hash]);
    const row = rows[0];
    if (!row || !row.aktif) {
      return res.status(401).json({ error: 'API key salah, sudah dicabut, atau aplikasi nonaktif' });
    }
    req.aplikasi = { id: row.id, nama: row.nama };
    db.query('UPDATE aplikasi SET api_key_last_used_at = NOW() WHERE id = ?', [row.id]).catch(() => {});
    next();
  } catch (err) {
    res.status(500).json({ error: 'Gagal cek API key: ' + err.message });
  }
}

// Kelola API key (generate/lihat/cabut) SENGAJA cuma terima sesi dashboard,
// TIDAK terima API key - supaya key yang bocor tidak bisa dipakai buat
// regenerate/cabut key itu sendiri atau lihat metadatanya.
function requireSession(req, res, next) {
  loadAplikasiFromSession(req).then((aplikasi) => {
    if (!aplikasi) return res.status(401).json({ error: 'Wajib login sesi dashboard - API key tidak berlaku untuk kelola API key sendiri' });
    req.aplikasi = aplikasi;
    next();
  }).catch((err) => res.status(500).json({ error: 'Gagal cek sesi: ' + err.message }));
}

// ===== Auth khusus buka halaman /docs/app - terima sesi tenant (dashboard
// yang sudah login) ATAU kredensial APP_DOCS_USER/PASS terpisah (buat lihat
// dokumentasi tanpa perlu login tenant). Eksekusi endpoint di dalam Swagger
// tetap minta login aplikasi lagi (requireAppAuth). =====
function requireAppDocsAuth(req, res, next) {
  if (req.session?.aplikasiId) return next();
  if (!APP_DOCS_PASS) {
    return res.status(503).json({ error: 'App docs auth belum dikonfigurasi (APP_DOCS_PASS kosong di .env)' });
  }
  return basicAuth({ users: { [APP_DOCS_USER || 'app']: APP_DOCS_PASS }, challenge: true })(req, res, next);
}

app.get('/status', (req, res) => {
  // Liveness publik ringan (server up) - status koneksi WA per tenant yang
  // sebenarnya ada di GET /device (butuh login), bukan di sini.
  res.json({ ok: true, tenant_aktif: tenants.size });
});

// ===== Login / logout dashboard (sesi cookie, beda dari Basic Auth API) =====

app.post('/login', async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'username dan password wajib diisi' });
  try {
    const aplikasi = await loadAplikasi(username, password);
    if (!aplikasi) {
      // ponytail: log server-side biar gampang dicek `pm2 logs` kalau ada
      // laporan "gabisa login" - tanpa nyimpan/nampilin password-nya.
      console.warn(`[wagateway] login gagal untuk username="${username}"`);
      return res.status(401).json({ error: 'Username/password salah, atau aplikasi nonaktif' });
    }
    req.session.aplikasiId = aplikasi.id;
    req.session.save((err) => {
      if (err) return res.status(500).json({ error: 'Gagal simpan sesi: ' + err.message });
      res.json({ success: true, nama: aplikasi.nama });
    });
  } catch (err) {
    res.status(500).json({ error: 'Gagal login: ' + err.message });
  }
});

app.post('/logout', (req, res) => {
  req.session.destroy(() => res.json({ success: true }));
});

// Pendaftaran tenant mandiri (publik, tanpa admin) - langsung login (sesi)
// setelah sukses supaya bisa lanjut tautkan device tanpa login ulang.
app.post('/register', async (req, res) => {
  const { username, password, nama } = req.body || {};
  if (!username || !password || !nama) {
    return res.status(400).json({ error: 'nama, username, dan password wajib diisi' });
  }
  if (String(password).length < 6) {
    return res.status(400).json({ error: 'Password minimal 6 karakter' });
  }
  try {
    const id = await createAplikasi(username, password, nama);
    req.session.aplikasiId = id;
    req.session.save((err) => {
      if (err) return res.status(500).json({ error: 'Gagal simpan sesi: ' + err.message });
      res.status(201).json({ success: true, id, nama });
    });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') {
      return res.status(400).json({ error: 'Username sudah dipakai' });
    }
    res.status(500).json({ error: err.message });
  }
});

// ===== API Key (kredensial buat panggil REST API - terpisah dari password
// login). Sengaja requireSession, bukan requireAppAuth - lihat komentar di
// definisi requireSession. =====

app.get('/api-key', requireSession, async (req, res) => {
  const [rows] = await db.query(
    'SELECT api_key_prefix, api_key_generated_at, api_key_last_used_at FROM aplikasi WHERE id = ?',
    [req.aplikasi.id]
  );
  const row = rows[0];
  res.json({
    ada: !!row.api_key_prefix,
    prefix: row.api_key_prefix,
    dibuat_at: row.api_key_generated_at,
    terakhir_dipakai: row.api_key_last_used_at,
  });
});

app.post('/api-key/generate', requireSession, async (req, res) => {
  const rawKey = generateApiKeyString();
  const hash = hashApiKey(rawKey);
  const prefix = rawKey.slice(0, 16);
  await db.query(
    'UPDATE aplikasi SET api_key_hash = ?, api_key_prefix = ?, api_key_generated_at = NOW(), api_key_last_used_at = NULL WHERE id = ?',
    [hash, prefix, req.aplikasi.id]
  );
  res.json({
    api_key: rawKey,
    prefix,
    catatan: 'Simpan sekarang - kode lengkap TIDAK akan ditampilkan lagi setelah ini. Kalau sebelumnya sudah ada API key, key lama langsung tidak berlaku.',
  });
});

app.post('/api-key/revoke', requireSession, async (req, res) => {
  await db.query(
    'UPDATE aplikasi SET api_key_hash = NULL, api_key_prefix = NULL, api_key_generated_at = NULL, api_key_last_used_at = NULL WHERE id = ?',
    [req.aplikasi.id]
  );
  res.json({ success: true });
});

// ===== Endpoint aplikasi (butuh login /aplikasi - sesi atau API key) =====

app.post('/send', requireAppAuth, async (req, res) => {
  const { nomor, pesan } = req.body || {};
  if (!nomor || !pesan) {
    return res.status(400).json({ error: 'nomor dan pesan wajib diisi' });
  }
  const tenant = getTenant(req.aplikasi.id);
  const jid = `${String(nomor).replace(/\D/g, '')}@s.whatsapp.net`;

  const [insertResult] = await db.query(
    'INSERT INTO riwayat_pesan (aplikasi_id, nomor_tujuan, pesan, status) VALUES (?, ?, ?, "antri")',
    [req.aplikasi.id, nomor, pesan]
  );
  const riwayatId = insertResult.insertId;

  try {
    const result = await enqueueSend(tenant, jid, pesan);
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

app.get('/stats', requireAppAuth, async (req, res) => {
  const [rows] = await db.query(
    'SELECT status, COUNT(*) AS jumlah FROM riwayat_pesan WHERE aplikasi_id = ? GROUP BY status',
    [req.aplikasi.id]
  );
  const stats = { total: 0, antri: 0, terkirim: 0, delivered: 0, read: 0, gagal: 0 };
  rows.forEach((r) => { stats[r.status] = r.jumlah; stats.total += r.jumlah; });
  res.json(stats);
});

// ===== Broadcast - kirim ke banyak nomor sekaligus. TIDAK ada jalur kirim
// terpisah: tiap nomor lewat enqueueSend/processQueue yang sama seperti
// /send, jadi tetap kena jeda acak (jitterDelay) yang sama. Kalau jumlah
// nomor melebihi sisa kuota harian, SELURUH batch ditolak (bukan sebagian)
// supaya perilakunya jelas buat caller - bukan garansi anti-block, cuma
// mengurangi pola pengiriman yang gampang dikenali WhatsApp sebagai spam. =====
app.post('/broadcast', requireAppAuth, async (req, res) => {
  const { pesan, nomor_list: nomorList } = req.body || {};
  if (!pesan || !Array.isArray(nomorList) || nomorList.length === 0) {
    return res.status(400).json({ error: 'pesan dan nomor_list (array, minimal 1) wajib diisi' });
  }
  if (nomorList.length > BROADCAST_MAX_PER_CALL) {
    return res.status(400).json({ error: `Maksimal ${BROADCAST_MAX_PER_CALL} nomor per panggilan` });
  }

  const tenant = getTenant(req.aplikasi.id);
  const [hariIniRows] = await db.query(
    'SELECT COUNT(*) AS jumlah FROM riwayat_pesan WHERE aplikasi_id = ? AND dibuat_at > CURDATE()',
    [req.aplikasi.id]
  );
  const sisaKuota = sisaKuotaBroadcast(BROADCAST_DAILY_LIMIT, hariIniRows[0].jumlah);
  if (nomorList.length > sisaKuota) {
    return res.status(400).json({
      error: `Kuota broadcast harian tersisa ${Math.max(sisaKuota, 0)}, diminta ${nomorList.length}`,
    });
  }

  let diterima = 0;
  for (const nomor of nomorList) {
    const jid = `${String(nomor).replace(/\D/g, '')}@s.whatsapp.net`;
    const [insertResult] = await db.query(
      'INSERT INTO riwayat_pesan (aplikasi_id, nomor_tujuan, pesan, status) VALUES (?, ?, ?, "antri")',
      [req.aplikasi.id, nomor, pesan]
    );
    const riwayatId = insertResult.insertId;
    diterima += 1;
    enqueueSend(tenant, jid, pesan)
      .then((result) => db.query(
        'UPDATE riwayat_pesan SET status = "terkirim", wa_message_id = ?, dikirim_at = NOW() WHERE id = ?',
        [result?.key?.id || null, riwayatId]
      ))
      .catch((err) => db.query(
        'UPDATE riwayat_pesan SET status = "gagal", error_pesan = ? WHERE id = ?',
        [String(err.message).slice(0, 250), riwayatId]
      ));
  }
  res.json({ success: true, diterima });
});

// ===== Device - tenant lihat/kelola koneksi WA miliknya sendiri =====

app.get('/device', requireAppAuth, async (req, res) => {
  const tenant = getTenant(req.aplikasi.id);
  const [rows] = await db.query(
    'SELECT event, detail, dicatat_at FROM koneksi_log WHERE aplikasi_id = ? ORDER BY id DESC LIMIT 5',
    [req.aplikasi.id]
  );
  res.json({
    connected: tenant.isReady,
    nomor: tenant.sock?.user?.id ? tenant.sock.user.id.split(':')[0] : null,
    nama_wa: tenant.sock?.user?.name || null,
    platform: tenant.authState?.creds?.platform || null,
    nama_perangkat: NAMA_PERANGKAT,
    terhubung_sejak: tenant.terhubungSejak,
    antrian: tenant.queue.length,
    percobaan_reconnect: tenant.reconnectAttempts,
    riwayat_koneksi: rows,
  });
});

app.post('/device/pairing-code', requireAppAuth, async (req, res) => {
  const tenant = getTenant(req.aplikasi.id);
  if (!tenant.sock) return res.status(503).json({ error: 'Socket belum siap, coba beberapa detik lagi' });
  if (tenant.authState?.creds?.registered) {
    return res.status(400).json({ error: 'Sudah tertaut ke WhatsApp - tidak perlu pairing lagi' });
  }
  const nomor = (req.body && req.body.nomor) || req.query.nomor;
  if (!nomor) {
    return res.status(400).json({ error: 'Isi nomor WA tujuan pairing, format 628xxxxxxxxxx' });
  }
  try {
    const code = await tenant.sock.requestPairingCode(nomor);
    logKoneksi(req.aplikasi.id, 'pairing_requested', String(nomor));
    res.json({ code, catatan: 'Berlaku sekitar 60 detik - langsung masukkan di HP: WhatsApp > Perangkat Tertaut > Tautkan dengan nomor telepon.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// QR alternatif dari kode pairing nomor - Baileys nerbitin dua-duanya dari
// socket yang sama (lihat handler connection.update di startSock), endpoint
// ini cuma nyajiin QR terakhir yang ketangkep sebagai gambar PNG data-URL.
app.get('/device/qr', requireAppAuth, async (req, res) => {
  const tenant = getTenant(req.aplikasi.id);
  if (tenant.authState?.creds?.registered) {
    return res.status(400).json({ error: 'Sudah tertaut ke WhatsApp - tidak perlu pairing lagi' });
  }
  if (!tenant.qr) {
    return res.status(503).json({ error: 'QR belum tersedia, coba lagi beberapa detik' });
  }
  try {
    const dataUrl = await QRCode.toDataURL(tenant.qr, { margin: 1, width: 280 });
    res.json({ qr: dataUrl });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/device/logout', requireAppAuth, async (req, res) => {
  const aplikasiId = req.aplikasi.id;
  const tenant = getTenant(aplikasiId);
  try {
    if (tenant.sock && tenant.isReady) {
      await tenant.sock.logout();
    }
  } catch (err) {
    console.error(`[wagateway] gagal logout socket aplikasi #${aplikasiId}:`, err.message);
  }
  fs.rmSync(authFolder(aplikasiId), { recursive: true, force: true });
  tenant.isReady = false;
  tenant.reconnectAttempts = 0;
  tenant.qr = null;
  logKoneksi(aplikasiId, 'device_unlinked');
  startSock(aplikasiId).catch((err) => console.error(`[wagateway] gagal restart socket aplikasi #${aplikasiId}:`, err.message));
  res.json({ success: true });
});

// ===== Endpoint admin (butuh login admin) - provisioning tenant, bukan
// pengelolaan koneksi WA (itu sudah pindah ke /device/* per tenant di atas). =====

app.post('/admin/aplikasi', requireDocsAuth, async (req, res) => {
  const { username, password, nama } = req.body || {};
  if (!username || !password || !nama) {
    return res.status(400).json({ error: 'username, password, nama wajib diisi' });
  }
  try {
    const id = await createAplikasi(username, password, nama);
    res.status(201).json({ id, username, nama });
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
// /docs/admin (kelola aplikasi) pakai login admin, /docs/app (kirim pesan,
// device, broadcast) pakai sesi tenant atau login app-docs terpisah. Eksekusi
// endpoint di /docs/app tetap minta login aplikasi lagi (requireAppAuth),
// jadi ini murni gerbang "siapa yang boleh lihat dokumentasinya".
if (DOCS_PASS) {
  app.use('/docs/admin', requireDocsAuth, swaggerUi.serveFiles(swaggerAdmin), swaggerUi.setup(swaggerAdmin));
} else {
  console.warn('[wagateway] DOCS_PASS belum diset di .env - /docs/admin dan /admin/* dinonaktifkan.');
}

app.use('/docs/app', requireAppDocsAuth, swaggerUi.serveFiles(swaggerApp), swaggerUi.setup(swaggerApp));

app.listen(PORT, () => console.log(`[wagateway] API jalan di port ${PORT}`));
