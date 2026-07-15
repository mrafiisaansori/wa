// Dokumentasi buat aplikasi pemanggil (Zona Kasir, project lain, dst) - kirim
// pesan & lihat histori pengiriman punya sendiri. Login pakai username/password
// yang didaftarkan admin lewat /docs/admin (endpoint POST /admin/aplikasi).
module.exports = {
  openapi: '3.0.3',
  info: {
    title: 'WA Gateway - Aplikasi',
    version: '1.0.0',
    description:
      'Kirim pesan WhatsApp & lihat histori pengiriman. Login pakai username/password ' +
      'aplikasi kamu sendiri (klik Authorize di kanan atas) - histori yang muncul cuma ' +
      'punya aplikasi yang sedang login, punya aplikasi lain tidak ikut kelihatan.',
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
            description: 'Pesan masuk antrian pengiriman',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/SendResponse' } } },
          },
          400: { description: 'Body tidak lengkap', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
          401: { description: 'Username/password aplikasi salah' },
          500: { description: 'Gagal kirim (WA belum terhubung, dsb)' },
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
          401: { description: 'Username/password aplikasi salah' },
        },
      },
    },
  },
};
