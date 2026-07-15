// ponytail: spec OpenAPI ditulis tangan sebagai object JS, bukan jsdoc-comment
// parser - lebih boring tapi nggak ada risiko syntax annotation gagal di-parse.
//
// Dokumen ini KHUSUS admin (operator wagateway) - status koneksi & pairing
// device. Halaman /docs/admin sendiri sudah digembok Basic Auth admin di
// index.js, jadi endpoint di sini nggak perlu securityScheme tambahan.
module.exports = {
  openapi: '3.0.3',
  info: {
    title: 'WA Gateway - Admin',
    version: '1.0.0',
    description: 'Operasi admin: cek koneksi WA dan tautkan/pairing device. Terpisah dari dokumentasi buat aplikasi pemanggil (/docs/app).',
  },
  servers: [{ url: '/' }],
  components: {
    schemas: {
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
          'sekitar 60 detik. Kalau koneksi ke server WhatsApp tidak stabil, kode bisa jadi ' +
          'tidak berlaku lebih cepat dari itu - cek /status dan pm2 logs kalau sering gagal.',
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
    '/admin/aplikasi': {
      post: {
        summary: 'Daftarkan aplikasi pemanggil baru (bikin akun login project lain)',
        description: 'Bikin 1 baris di tabel aplikasi - project pemanggil (zonakasir, project lain, dst) pakai username/password ini buat login ke /send dan /history.',
        tags: ['Aplikasi'],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['username', 'password', 'nama'],
                properties: {
                  username: { type: 'string', example: 'zonakasir' },
                  password: { type: 'string', example: 'password-kuat-punya-zonakasir' },
                  nama: { type: 'string', example: 'Zona Kasir' },
                },
              },
            },
          },
        },
        responses: {
          201: { description: 'Aplikasi berhasil dibuat' },
          400: { description: 'Data tidak lengkap, atau username sudah dipakai' },
        },
      },
      get: {
        summary: 'Lihat daftar aplikasi terdaftar',
        tags: ['Aplikasi'],
        responses: { 200: { description: 'Daftar aplikasi (tanpa password)' } },
      },
    },
  },
};
