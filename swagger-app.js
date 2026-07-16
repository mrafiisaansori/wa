// Dokumentasi PUBLIK buat aplikasi pemanggil (Zona Kasir, project lain, dst) -
// SENGAJA cuma 3 endpoint inti (kirim pesan, broadcast, riwayat). Endpoint
// lain (register, device/pairing/qr, api-key, stats) dipakai dashboard sendiri
// lewat sesi cookie, bukan buat integrasi API pihak luar - jadi tidak perlu
// (dan tidak boleh) nongol di sini, walau endpoint-nya sendiri tetap jalan di
// index.js. Autentikasi pakai API key Bearer token (generate dari dashboard >
// menu API Key, klik Authorize di kanan atas buat tempel di sini) - data yang
// muncul cuma punya tenant pemilik key itu, tenant lain tidak ikut kelihatan.
module.exports = {
  openapi: '3.0.3',
  info: {
    title: 'WA Gateway - Aplikasi',
    version: '1.0.0',
    description:
      'Kirim pesan WhatsApp, broadcast, dan lihat riwayat pengiriman. Autentikasi pakai ' +
      'API key Bearer token (klik Authorize di kanan atas, tempel key yang di-generate dari dashboard) ' +
      '- data yang muncul cuma punya tenant pemilik key itu, punya tenant lain tidak ikut kelihatan.',
  },
  servers: [{ url: '/' }],
  components: {
    securitySchemes: {
      ApiKeyAuth: { type: 'http', scheme: 'bearer', description: 'Tempel API key kamu (mis. wzp_live_xxxxx...) - generate dari dashboard > menu API Key.' },
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
  security: [{ ApiKeyAuth: [] }],
  paths: {
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
          401: { description: 'API key salah/dicabut, atau login aplikasi diperlukan' },
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
          401: { description: 'API key salah/dicabut, atau login aplikasi diperlukan' },
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
          401: { description: 'API key salah/dicabut, atau login aplikasi diperlukan' },
        },
      },
    },
  },
};
