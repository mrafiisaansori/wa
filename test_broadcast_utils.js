// Self-check kecil buat 2 fungsi murni di broadcast-utils.js (jitter & kuota
// harian) - jalankan manual: node test_broadcast_utils.js
const assert = require('assert');
const { jitterDelay, sisaKuotaBroadcast } = require('./broadcast-utils');

// jitterDelay selalu ada di rentang [min, max]
for (let i = 0; i < 200; i++) {
  const d = jitterDelay(2500, 6000);
  assert(d >= 2500 && d <= 6000, `jitterDelay di luar rentang: ${d}`);
}

// min === max -> selalu balikin nilai itu (tidak crash / tidak NaN)
assert.strictEqual(jitterDelay(3000, 3000), 3000);

// kuota harian: sisa = limit - terpakai, termasuk kasus batas & lebih
assert.strictEqual(sisaKuotaBroadcast(200, 0), 200);
assert.strictEqual(sisaKuotaBroadcast(200, 150), 50);
assert.strictEqual(sisaKuotaBroadcast(200, 200), 0);
assert.strictEqual(sisaKuotaBroadcast(200, 250), -50); // sudah lewat kuota, harus negatif (caller nolak batch)

console.log('OK - broadcast-utils lolos self-check');
