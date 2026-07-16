// Dokumentasi buat aplikasi pemanggil (Zona Kasir, project lain, dst) dan buat
// tenant sendiri lewat dashboard - kirim pesan, broadcast, dan kelola device WA
// milik sendiri. Login pakai username/password aplikasi (klik Authorize di
// kanan atas kalau manggil langsung dari sini) - data yang muncul cuma punya
// aplikasi yang sedang login, punya aplikasi lain tidak ikut kelihatan.
module.exports = {
  openapi: '3.0.3',
  info: {
    title: 'WA Gateway - Aplikasi',
    version: '1.0.0',
    description:
      'Kirim pesan WhatsApp, broadcast, dan kelola device (pairing/status/putus). Login pakai ' +
      'username/password aplikasi kamu sendiri (klik Authorize di kanan atas) - data yang muncul ' +
      'cuma punya aplikasi yang sedang login, punya aplikasi lain tidak ikut kelihatan.',
  },
  servers: [{ url: '/' }],
  components: {
    securitySchemes: {
      AplikasiAuth: { type: 'http', scheme: 'basic' },
    },
    schemas: {
      SendRequest: {
        type: 'object',
        required: ['nomor', 'pesan'],
        properties: {
          nomor: { type: 'string', example: '6281234567890', description: 'Format 62xxxxxxxxxx' },
          pesan: { type: 'string', example: 'Halo, ini pesan test dari WA Gateway.' },
        },
      },
      SendResponse: {
        type: 'object',
        properties: { success: { type: 'boolean', example: true }, id: { type: 'integer', example: 42 } },
      },
      BroadcastRequest: {
        type: 'object',
        required: ['pesan', 'nomor_list'],
        properties: {
          pesan: { type: 'string', example: 'Promo hari ini khusus untuk kamu!' },
          nomor_list: {
            type: 'array',
            items: { type: 'string' },
            example: ['6281234567890', '6281234567891'],
            description: 'Maksimal 500 nomor per panggilan, dan tunduk ke kuota harian (BROADCAST_DAILY_LIMIT).',
          },
        },
      },
      BroadcastResponse: {
        type: 'object',
        properties: { success: { type: 'boolean', example: true }, diterima: { type: 'integer', example: 2 } },
      },
      DeviceResponse: {
        type: 'object',
        properties: {
          connected: { type: 'boolean', example: true },
          nomor: { type: 'string', nullable: true, example: '6281234567890' },
          nama_wa: { type: 'string', nullable: true, example: 'Toko Berkah', description: 'Nama profil WhatsApp (push name) dari HP yang tertaut' },
          platform: { type: 'string', nullable: true, example: 'android', description: 'Platform client WA dari HP yang tertaut (android/ios/smba/dst), dari data pairing' },
          nama_perangkat: { type: 'string', example: 'Chrome (Ubuntu)', description: 'Nama yang muncul di HP pada daftar "Perangkat Tertaut"' },
          terhubung_sejak: { type: 'string', format: 'date-time', nullable: true },
          antrian: { type: 'integer', example: 0 },
          percobaan_reconnect: { type: 'integer', example: 0 },
          riwayat_koneksi: {
            type: 'array',
            items: { type: 'object', properties: { event: { type: 'string' }, detail: { type: 'string', nullable: true }, dicatat_at: { type: 'string', format: 'date-time' } } },
            description: '5 event koneksi terakhir (connected/disconnected/logged_out/pairing_requested/device_unlinked)',
          },
        },
      },
      RiwayatItem: {
        type: 'object',
        properties: {
          id: { type: 'integer' },
          nomor_tujuan: { type: 'string' },
          pesan: { type: 'string' },
          status: { type: 'string', enum: ['antri', 'terkirim', 'delivered', 'read', 'gagal'] },
          error_pesan: { type: 'string', nullable: true },
          dibuat_at: { type: 'string', format: 'date-time' },
        },
      },
      ErrorResponse: {
        type: 'object',
        properties: { error: { type: 'string' } },
      },
    },
  },
  security: [{ AplikasiAuth: [] }],
  paths: {
    '/register': {
      post: {
        summary: 'Daftar tenant baru (publik, tidak butuh login)',
        description: 'Bikin akun tenant sendiri tanpa lewat admin. Dipakai halaman "Daftar tenant baru" di dashboard.',
        tags: ['Aplikasi'],
        security: [],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['username', 'password', 'nama'],
                properties: {
                  username: { type: 'string', example: 'tokoberkah' },
                  password: { type: 'string', example: 'password-minimal-6-karakter' },
                  nama: { type: 'string', example: 'Toko Berkah' },
                },
              },
            },
          },
        },
        responses: {
          201: { description: 'Akun dibuat, sesi langsung aktif' },
          400: { description: 'Data tidak lengkap, password kurang dari 6 karakter, atau username sudah dipakai', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
        },
      },
    },
    '/send': {
      post: {
        summary: 'Kirim pesan WhatsApp',
        tags: ['Kirim Pesan'],
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { $ref: '#/components/schemas/SendRequest' } } },
        },
        responses: {
          200: {
            description: 'Pesan masuk antrian pengiriman (dikirim dengan jeda acak, bukan langsung)',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/SendResponse' } } },
          },
          400: { description: 'Body tidak lengkap', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
          401: { description: 'Login aplikasi diperlukan' },
          500: { description: 'Gagal kirim (WA belum terhubung, dsb)' },
        },
      },
    },
    '/broadcast': {
      post: {
        summary: 'Kirim pesan yang sama ke banyak nomor sekaligus',
        description:
          'Tiap nomor tetap lewat antrian & jeda acak yang sama seperti /send (bukan jalur kirim ' +
          'terpisah). Kalau jumlah nomor melebihi sisa kuota harian, SELURUH batch ditolak (bukan ' +
          'sebagian dikirim). Ini mengurangi risiko diblokir WhatsApp, bukan garansi anti-block - ' +
          'tetap variasikan isi pesan dan jangan kirim ke nomor yang tidak pernah berinteraksi.',
        tags: ['Broadcast'],
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { $ref: '#/components/schemas/BroadcastRequest' } } },
        },
        responses: {
          200: {
            description: 'Batch diterima dan masuk antrian',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/BroadcastResponse' } } },
          },
          400: { description: 'Body tidak lengkap, melebihi 500 nomor per panggilan, atau melebihi sisa kuota harian', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
          401: { description: 'Login aplikasi diperlukan' },
        },
      },
    },
    '/device': {
      get: {
        summary: 'Status device WA milik aplikasi yang sedang login',
        tags: ['Device'],
        responses: {
          200: {
            description: 'Status koneksi, nomor tertaut, panjang antrian, dan log terakhir',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/DeviceResponse' } } },
          },
          401: { description: 'Login aplikasi diperlukan' },
        },
      },
    },
    '/device/pairing-code': {
      post: {
        summary: 'Minta kode pairing baru buat menautkan nomor WA sendiri',
        description:
          'Panggil ini TEPAT sebelum siap mengetik di HP - kode dari WhatsApp cuma valid sekitar ' +
          '60 detik. Cek GET /device kalau sering gagal untuk lihat status koneksi socket.',
        tags: ['Device'],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['nomor'],
                properties: { nomor: { type: 'string', example: '628123456789' } },
              },
            },
          },
        },
        responses: {
          200: { description: 'Kode pairing (berlaku singkat)' },
          400: { description: 'Sudah tertaut, atau nomor belum diisi' },
          401: { description: 'Login aplikasi diperlukan' },
          503: { description: 'Socket belum siap' },
        },
      },
    },
    '/device/logout': {
      post: {
        summary: 'Putuskan device WA (unlink) dan siapkan sesi baru untuk pairing ulang',
        description: 'Aksi ini melepas nomor WA dari gateway - device perlu di-pairing ulang lewat POST /device/pairing-code sesudahnya.',
        tags: ['Device'],
        responses: {
          200: { description: 'Device berhasil diputus' },
          401: { description: 'Login aplikasi diperlukan' },
        },
      },
    },
    '/history': {
      get: {
        summary: 'Riwayat pengiriman punya aplikasi yang sedang login',
        tags: ['Riwayat'],
        parameters: [
          { name: 'limit', in: 'query', required: false, schema: { type: 'integer', default: 50 } },
        ],
        responses: {
          200: {
            description: 'Daftar riwayat, terbaru duluan',
            content: { 'application/json': { schema: { type: 'array', items: { $ref: '#/components/schemas/RiwayatItem' } } } },
          },
          401: { description: 'Login aplikasi diperlukan' },
        },
      },
    },
    '/stats': {
      get: {
        summary: 'Ringkasan jumlah pesan per status (dipakai dashboard)',
        tags: ['Riwayat'],
        responses: {
          200: {
            description: 'Jumlah pesan per status milik aplikasi yang login',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    total: { type: 'integer' }, antri: { type: 'integer' }, terkirim: { type: 'integer' },
                    delivered: { type: 'integer' }, read: { type: 'integer' }, gagal: { type: 'integer' },
                  },
                },
              },
            },
          },
          401: { description: 'Login aplikasi diperlukan' },
        },
      },
    },
  },
};
