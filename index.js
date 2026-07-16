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
  return { sock: null, authState: null, isReady: false, reconnectAttempts: 0, queue: [], processing: false, terhubungSejak: null };
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

    if (connection === 'open') {
      tenant.isReady = true;
      tenant.reconnectAttempts = 0;
      tenant.terhubungSejak = new Date();
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

// ===== Auth admin (operator wagateway) - kredensial tunggal dari .env, buat
// provisioning tenant baru. Ini BUKAN akun tenant. =====
const requireDocsAuth = DOCS_PASS
  ? basicAuth({ users: { [DOCS_USER || 'admin']: DOCS_PASS }, challenge: true })
  : (req, res) => res.status(503).json({ error: 'Admin auth belum dikonfigurasi (DOCS_PASS kosong di .env)' });

// ===== Auth aplikasi (tenant) - dua cara masuk yang keduanya cek ke tabel
// `aplikasi` yang sama: sesi cookie (dashboard browser, dari POST /login) atau
// Basic Auth (project pemanggil kayak Zona Kasir, tidak berubah dari sebelumnya). =====
async function loadAplikasi(username, password) {
  const [rows] = await db.query(
    'SELECT id, nama, password_hash, aktif FROM aplikasi WHERE username = ? LIMIT 1',
    [username]
  );
  const row = rows[0];
  const valid = row && row.aktif && (await bcrypt.compare(password || '', row.password_hash));
  return valid ? { id: row.id, nama: row.nama } : null;
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

async function requireAppAuth(req, res, next) {
  if (req.session?.aplikasiId) {
    try {
      const [rows] = await db.query('SELECT id, nama, aktif FROM aplikasi WHERE id = ? LIMIT 1', [req.session.aplikasiId]);
      const row = rows[0];
      if (!row || !row.aktif) {
        return req.session.destroy(() => res.status(401).json({ error: 'Sesi tidak valid, silakan login lagi' }));
      }
      req.aplikasi = { id: row.id, nama: row.nama };
      return next();
    } catch (err) {
      return res.status(500).json({ error: 'Gagal cek sesi: ' + err.message });
    }
  }

  // ponytail: SENGAJA tidak set header WWW-Authenticate di sini. Kalau di-set,
  // browser (bukan cuma HTTP client) langsung nampilin dialog login native-nya
  // sendiri begitu fetch() dari dashboard kena 401 - nimpa form login custom
  // kita. Zona Kasir/aplikasi lain tidak butuh header ini karena mereka selalu
  // ngirim Basic Auth duluan (preemptive), bukan nunggu challenge dulu.
  const header = req.headers.authorization || '';
  const [scheme, encoded] = header.split(' ');
  if (scheme !== 'Basic' || !encoded) {
    return res.status(401).json({ error: 'Login aplikasi diperlukan (Basic Auth username/password, atau login sesi)' });
  }
  const [username, password] = Buffer.from(encoded, 'base64').toString('utf8').split(':');
  try {
    const aplikasi = await loadAplikasi(username, password);
    if (!aplikasi) {
      return res.status(401).json({ error: 'Username/password aplikasi salah, atau aplikasi nonaktif' });
    }
    req.aplikasi = aplikasi;
    next();
  } catch (err) {
    res.status(500).json({ error: 'Gagal cek login aplikasi: ' + err.message });
  }
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

// ===== Endpoint aplikasi (butuh login /aplikasi - sesi atau Basic) =====

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
