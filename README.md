# wagateway

Service internal terpisah untuk kirim notifikasi WhatsApp (struk, stok menipis, dsb) buat Zona Kasir, pakai [Baileys](https://github.com/WhiskeySockets/Baileys) (protokol WhatsApp Web tidak resmi). Sengaja dipisah dari `pos-backend` supaya kalau sesi WA putus/reconnect, API POS utama tidak ikut kena dampak.

## Cara kerja singkat

1. Service ini "menautkan" 1 nomor WhatsApp sebagai perangkat tertaut (persis seperti buka WhatsApp Web), pakai **pairing code** (bukan scan QR) karena jalan di VPS tanpa layar.
2. Setelah tertaut, sesi login tersimpan di folder `./auth` di server - selama folder ini tidak dihapus dan device tidak di-unlink dari HP, tidak perlu pairing ulang setiap restart.
3. `pos-backend` (atau proses lain) tinggal `POST /send` ke service ini buat kirim pesan.
4. Ada jeda (`SEND_DELAY_MS`) antar pesan yang dikirim - sengaja dibuat tidak instan biar tidak terlihat pola "blasting" ke sistem deteksi WhatsApp.

## Setup lokal (opsional, buat belajar alurnya dulu)

```bash
npm install
cp .env.example .env
# isi API_KEY dan PAIR_NUMBER pakai NOMOR TEST/BUANGAN dulu, bukan nomor produksi
npm start
```

Kode pairing akan muncul di terminal - masukkan di HP: **WhatsApp > Perangkat Tertaut > Tautkan dengan nomor telepon**.

> Catatan: jangan bolak-balik pairing nomor yang sama antara laptop lokal dan VPS (beda IP/jaringan berkali-kali dalam waktu singkat bisa mencurigakan buat sistem deteksi WhatsApp). Pakai nomor test di lokal, lalu pairing ulang dari nol langsung di VPS pakai nomor produksi yang memang mau dipakai selamanya.

## Deploy ke VPS

```bash
git clone https://github.com/mrafiisaansori/wa.git wagateway
cd wagateway
npm install --production
cp .env.example .env
nano .env   # isi API_KEY (wajib) dan PAIR_NUMBER (nomor WA produksi yang sudah lama dipakai)

npm install -g pm2   # kalau belum ada
pm2 start ecosystem.config.js
pm2 logs wagateway   # lihat kode pairing yang muncul di sini
```

Setelah tertaut dan `pm2 logs` menunjukan `[wagateway] terhubung ke WhatsApp.`, boleh kosongkan `PAIR_NUMBER` di `.env` lagi (tidak dipakai lagi setelah pairing pertama) lalu `pm2 restart wagateway`.

Terakhir:

```bash
pm2 save          # supaya proses ini auto-jalan lagi kalau VPS reboot
pm2 startup       # sekali saja per VPS, ikuti instruksi yang muncul
```

## Testing lewat Swagger UI

Buka `http://ip-vps-kamu:3900/docs` di browser. Bakal muncul prompt login Basic Auth (username/password dari `DOCS_USER`/`DOCS_PASS` di `.env`) - beda dari `API_KEY` yang dipakai project pemanggil (`/send`). Setelah login, klik tombol **Authorize** di halaman Swagger, isi `X-API-Key` sesuai `API_KEY` di `.env`, baru bisa coba `POST /send` langsung dari browser.

`/docs` otomatis nonaktif kalau `DOCS_PASS` belum diisi (fail closed, bukan malah kebuka bebas tanpa password).

## Dipakai lebih dari satu project

Service ini sengaja tidak dibikin spesifik untuk Zona Kasir - project lain tinggal panggil endpoint yang sama pakai `API_KEY` yang sama, dan boleh isi field `source` di body `/send` (opsional) buat nandain asal request di log, misal `"source": "zonakasir"` atau `"source": "project-lain"`. Kalau nanti butuh key terpisah per project (biar bisa dicabut satu-satu tanpa ganggu yang lain), tinggal ganti `API_KEY` tunggal jadi daftar key per project - belum dibikin sekarang karena belum perlu.

## Pakai dari pos-backend

```js
await axios.post('http://127.0.0.1:3900/send', {
  nomor: '6281234567890',
  pesan: 'Halo, ini contoh notifikasi dari Zona Kasir.',
}, {
  headers: { 'X-API-Key': process.env.WAGATEWAY_API_KEY },
});
```

## Endpoint

| Method | Path | Body | Keterangan |
|---|---|---|---|
| GET | `/status` | - | `{ connected, antrian }` - cek koneksi WA masih hidup atau tidak |
| POST | `/send` | `{ nomor, pesan }` | Header `X-API-Key` wajib kalau `API_KEY` sudah diset di `.env` |

## Batasan yang disengaja (ponytail)

- Antrian pengiriman masih in-memory (hilang kalau proses restart selagi ada antrian) - cukup untuk 1 nomor/1 proses. Kalau nanti butuh multi-nomor atau throughput tinggi, ganti ke queue eksternal (BullMQ + Redis).
- Tidak ada retry otomatis kalau `sendMessage` gagal - caller (pos-backend) yang perlu putuskan mau retry atau tidak.
- Tidak ada endpoint terima pesan masuk (cuma kirim) - sesuai kebutuhan awal (notifikasi searah).
