// ponytail: spec OpenAPI ditulis tangan sebagai object JS, bukan jsdoc-comment
// parser - lebih boring tapi nggak ada risiko syntax annotation gagal di-parse.
//
// Dokumen ini KHUSUS admin (operator wagateway) - provisioning akun tenant
// (aplikasi pemanggil). Halaman /docs/admin sendiri sudah digembok Basic Auth
// admin di index.js, jadi endpoint di sini nggak perlu securityScheme tambahan.
// Pairing & pengelolaan koneksi WA sekarang per-tenant, lihat /docs/app.
module.exports = {
  openapi: '3.0.3',
  info: {
    title: 'WA Gateway - Admin',
    version: '1.0.0',
    description: 'Operasi admin: provisioning akun aplikasi/tenant. Terpisah dari dokumentasi buat aplikasi pemanggil (/docs/app), yang isinya kirim pesan, broadcast, dan device WA milik masing-masing tenant.',
  },
  servers: [{ url: '/' }],
  paths: {
    '/admin/aplikasi': {
      post: {
        summary: 'Daftarkan aplikasi/tenant baru (bikin akun login project lain)',
        description: 'Bikin 1 baris di tabel aplikasi - project pemanggil (zonakasir, project lain, dst) pakai username/password ini buat login ke dashboard atau Basic Auth ke /send, /history, /broadcast, /device/*. Socket WA tenant ini langsung disiapkan (belum tertaut - tinggal minta kode pairing lewat POST /device/pairing-code).',
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
        summary: 'Lihat daftar aplikasi/tenant terdaftar',
        tags: ['Aplikasi'],
        responses: { 200: { description: 'Daftar aplikasi (tanpa password)' } },
      },
    },
    '/admin/koneksi-log': {
      get: {
        summary: 'Log naik-turun koneksi WA semua tenant',
        tags: ['Aplikasi'],
        parameters: [
          { name: 'limit', in: 'query', required: false, schema: { type: 'integer', default: 50 } },
        ],
        responses: { 200: { description: 'Daftar log, terbaru duluan' } },
      },
    },
  },
};
