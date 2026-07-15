// ponytail: spec OpenAPI ditulis tangan sebagai object JS (bukan jsdoc-comment
// parser) - lebih boring tapi nggak ada risiko syntax annotation yang gagal
// di-parse diam-diam.
module.exports = {
  openapi: '3.0.3',
  info: {
    title: 'WA Gateway API',
    version: '1.0.0',
    description:
      'Service internal pengirim notifikasi WhatsApp lewat Baileys. Dipakai bersama ' +
      'oleh beberapa project (Zona Kasir dan project lain) - tiap project pakai ' +
      'API key yang sama lewat header X-API-Key, isi "source" untuk menandai asal request.',
  },
  servers: [{ url: '/' }],
  components: {
    securitySchemes: {
      ApiKeyAuth: {
        type: 'apiKey',
        in: 'header',
        name: 'X-API-Key',
      },
    },
    schemas: {
      SendRequest: {
        type: 'object',
        required: ['nomor', 'pesan'],
        properties: {
          nomor: {
            type: 'string',
            example: '6281234567890',
            description: 'Nomor tujuan, format 62xxxxxxxxxx (kode negara, tanpa + / spasi / strip)',
          },
          pesan: {
            type: 'string',
            example: 'Halo, ini pesan test dari WA Gateway.',
          },
          source: {
            type: 'string',
            example: 'zonakasir',
            description: 'Opsional - nama project pemanggil, buat nandain asal request di log',
          },
        },
      },
      SendResponse: {
        type: 'object',
        properties: {
          success: { type: 'boolean', example: true },
        },
      },
      ErrorResponse: {
        type: 'object',
        properties: {
          error: { type: 'string', example: 'nomor dan pesan wajib diisi' },
        },
      },
      StatusResponse: {
        type: 'object',
        properties: {
          connected: { type: 'boolean', example: true },
          antrian: { type: 'integer', example: 0 },
        },
      },
    },
  },
  paths: {
    '/status': {
      get: {
        summary: 'Cek status koneksi WA',
        tags: ['Status'],
        responses: {
          200: {
            description: 'Status koneksi saat ini',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/StatusResponse' } } },
          },
        },
      },
    },
    '/pairing-code': {
      get: {
        summary: 'Minta kode pairing baru (sekali tautkan nomor WA)',
        description:
          'Panggil ini TEPAT sebelum siap mengetik di HP - kode dari WhatsApp cuma valid ' +
          'sekitar 60 detik. Halaman ini sendiri sudah digembok login Basic Auth punya /docs, ' +
          'jadi tidak butuh X-API-Key terpisah.',
        tags: ['Pairing'],
        parameters: [
          {
            name: 'nomor',
            in: 'query',
            required: false,
            schema: { type: 'string', example: '628123456789' },
            description: 'Opsional kalau PAIR_NUMBER sudah diisi di .env',
          },
        ],
        responses: {
          200: { description: 'Kode pairing (berlaku singkat)' },
          400: { description: 'Sudah tertaut, atau nomor belum diisi' },
          503: { description: 'Socket belum siap' },
        },
      },
    },
    '/send': {
      post: {
        summary: 'Kirim pesan WhatsApp',
        tags: ['Kirim Pesan'],
        security: [{ ApiKeyAuth: [] }],
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { $ref: '#/components/schemas/SendRequest' } } },
        },
        responses: {
          200: {
            description: 'Pesan berhasil masuk antrian pengiriman',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/SendResponse' } } },
          },
          400: {
            description: 'Body request tidak lengkap',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } },
          },
          401: {
            description: 'API key tidak valid',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } },
          },
          500: {
            description: 'Gagal kirim (WA belum terhubung, dsb)',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } },
          },
        },
      },
    },
  },
};
