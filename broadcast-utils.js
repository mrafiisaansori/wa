// Fungsi murni dipisah dari index.js supaya bisa dites tanpa efek samping
// (index.js langsung buka koneksi DB & socket WA begitu di-require).

function jitterDelay(minMs, maxMs) {
  const span = Math.max(1, maxMs - minMs + 1);
  return minMs + Math.floor(Math.random() * span);
}

function sisaKuotaBroadcast(dailyLimit, sentToday) {
  return dailyLimit - sentToday;
}

module.exports = { jitterDelay, sisaKuotaBroadcast };
