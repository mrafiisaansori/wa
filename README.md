# wagateway

Service internal terpisah untuk kirim notifikasi WhatsApp (struk, stok menipis, dsb), pakai [Baileys](https://github.com/WhiskeySockets/Baileys) (protokol WhatsApp Web tidak resmi). Dipakai bareng-bareng oleh beberapa project (Zona Kasir, project lain) - tiap project punya akun login sendiri dan cuma bisa lihat riwayat pengirimannya sendiri.

## Cara kerja singkat

1. Service ini menautkan **1 nomor WhatsApp** sebagai perangkat tertaut, pakai pairing code (bukan scan QR, karena jalan di VPS tanpa layar). Sesi login tersimpan di folder `./auth`.
2. Tiap **project pemanggil** (Zona Kasir, project lain) punya akun sendiri di tabel `aplikasi` (dibuat admin lewat `/docs/admin`). Mereka login pakai Basic Auth username/password sendiri untuk kirim pesan dan lihat riwayat - riwayat punya project A tidak kelihatan dari akun project B.
3. Ada jeda (`SEND_DELAY_MS`) antar pesan supaya tidak terlihat pola "blasting".
4. Status tiap pesan (terkirim/delivered/read/gagal) di-update otomatis dari event asli WhatsApp lewat Baileys, bukan cuma "berhasil dipanggil doang".

## Dua Swagger UI, dua auth berbeda

| | `/docs/admin` | `/docs/app` |
|---|---|---|
| Login buka halamannya | Basic Auth admin (`DOCS_USER`/`DOCS_PASS` di `.env`) | Basic Auth admin juga (sekadar buat lihat dokumentasinya) |
| Auth buat eksekusi endpoint | sama, admin | **Beda lagi** - login akun aplikasi (dibuat lewat `/docs/admin`), tombol Authorize di `/docs/app` |
| Isinya | `/status`, `/pairing-code`, kelola akun aplikasi (`/admin/aplikasi`), `/admin/koneksi-log` | `/send`, `/history` |
| Dipakai siapa | Kamu (operator wagateway) | Tiap project pemanggil, buat testing kirim pesan sendiri |

## Setup pertama kali di VPS

```bash
git clone https://github.com/mrafiisaansori/wa.git wagateway
cd wagateway
npm install --production

# 1. Buat database & tabel
mysql -u root -p < wagateway.sql

# 2. Konfigurasi
cp .env.example .env
nano .env
# isi: DOCS_USER, DOCS_PASS, DB_USER, DB_PASS, DB_NAME (samain sama step 1),
# dan PAIR_NUMBER (nomor WA lama yang mau ditautkan)

# 3. Jalankan
npm install -g pm2   # kalau belum ada
pm2 start ecosystem.config.js
pm2 logs wagateway
```

## Pairing (tautkan nomor WA)

1. Buka HP ke layar **WhatsApp > Perangkat Tertaut > Tautkan dengan nomor telepon**, siap-siap ketik.
2. Baru buka `http://ip-vps:3900/docs/admin`, login admin, jalankan `GET /pairing-code`.
3. Kode langsung muncul di response - ketik ke HP secepatnya (berlaku ~60 detik, tapi kalau koneksi VPS ke server WhatsApp tidak stabil bisa lebih cepat basi dari itu - cek `pm2 logs` kalau sering gagal).
4. Kalau meleset, panggil ulang endpoint yang sama buat kode baru - tidak perlu restart proses.

## Daftarkan project pemanggil

Lewat `/docs/admin` > `POST /admin/aplikasi`:

```json
{ "username": "zonakasir", "password": "password-kuat-punya-zonakasir", "nama": "Zona Kasir" }
```

Kasih username/password ini ke project yang bersangkutan - mereka pakai ini buat login ke `/send` dan `/history` (lewat `/docs/app`, atau langsung dari kode mereka).

## Pakai dari project lain (mis. pos-backend)

```js
const auth = Buffer.from('zonakasir:password-kuat-punya-zonakasir').toString('base64');

await axios.post('http://127.0.0.1:3900/send', {
  nomor: '6281234567890',
  pesan: 'Halo, ini contoh notifikasi.',
}, {
  headers: { Authorization: `Basic ${auth}` },
});
```

## Redeploy - apakah perlu pairing ulang?

**Tidak**, selama folder `./auth` di VPS tidak dihapus dan device tidak di-unlink dari HP. Folder ini **tidak** ikut ke-`git pull` (sudah di `.gitignore`), jadi redeploy kode (fitur DB, auth, dsb di atas) sama sekali tidak menyentuh sesi WA yang sudah tertaut.

```bash
cd ~/pos/wa
git pull
npm install --production
mysql -u root -p wagateway < wagateway.sql   # aman dijalankan ulang - CREATE TABLE IF NOT EXISTS
nano .env   # tambahkan DB_HOST, DB_USER, DB_PASS, DB_NAME kalau belum ada
pm2 restart wagateway
pm2 logs wagateway
```

Yang **akan** memaksa pairing ulang (bukan karena redeploy, tapi hal lain): folder `./auth` terhapus manual, device di-unlink dari HP (WhatsApp > Perangkat Tertaut > pilih device ini > Log Out), atau WhatsApp mem-force-logout sesi (`statusCode 401` di log - kode saat ini otomatis bersih-bersih dan siap pairing ulang lewat `/pairing-code` kalau ini terjadi, tanpa perlu restart manual).

## Endpoint

| Method | Path | Auth | Body/Query |
|---|---|---|---|
| GET | `/status` | - | - |
| GET | `/pairing-code` | Admin | `?nomor=` opsional |
| POST | `/admin/aplikasi` | Admin | `{ username, password, nama }` |
| GET | `/admin/aplikasi` | Admin | - |
| GET | `/admin/koneksi-log` | Admin | `?limit=` opsional |
| POST | `/send` | Aplikasi | `{ nomor, pesan }` |
| GET | `/history` | Aplikasi | `?limit=` opsional |

## Batasan yang disengaja (ponytail)

- Antrian pengiriman masih in-memory (hilang kalau proses restart selagi ada antrian) - cukup untuk 1 nomor/1 proses. Kalau nanti butuh multi-nomor atau throughput tinggi, ganti ke queue eksternal (BullMQ + Redis).
- Tidak ada retry otomatis kalau `sendMessage` gagal - baris riwayat ditandai `gagal`, caller yang perlu putuskan mau retry atau tidak.
- Tidak ada endpoint terima pesan masuk (cuma kirim) - sesuai kebutuhan awal (notifikasi searah).
- 1 proses wagateway = 1 nomor WA. Kalau nanti butuh banyak nomor, perlu banyak instance + tabel `aplikasi`/`riwayat_pesan` ditambah kolom nomor pengirim.
