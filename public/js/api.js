// Wrapper fetch tipis ke endpoint backend yang SUDAH ADA - tidak ada endpoint
// baru di sini, cuma satu tempat biar auth.js/dashboard.js tidak duplikasi
// pola fetch+error-handling.
window.WazapiAPI = (function () {
  function request(url, options) {
    return fetch(url, Object.assign({ credentials: 'include' }, options)).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) {
        if (!res.ok) {
          var err = new Error(data.error || 'Terjadi kesalahan, coba lagi.');
          err.status = res.status;
          err.data = data;
          throw err;
        }
        return data;
      });
    });
  }

  function postJSON(url, body) {
    return request(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
    });
  }

  return {
    login: function (username, password) { return postJSON('/login', { username: username, password: password }); },
    register: function (username, password, nama) { return postJSON('/register', { username: username, password: password, nama: nama }); },
    logout: function () { return postJSON('/logout'); },
    device: function () { return request('/device'); },
    pairingCode: function (nomor) { return postJSON('/device/pairing-code', { nomor: nomor }); },
    deviceQr: function () { return request('/device/qr'); },
    deviceLogout: function () { return postJSON('/device/logout'); },
    send: function (nomor, pesan) { return postJSON('/send', { nomor: nomor, pesan: pesan }); },
    broadcast: function (pesan, nomorList) { return postJSON('/broadcast', { pesan: pesan, nomor_list: nomorList }); },
    history: function (limit) { return request('/history?limit=' + (limit || 50)); },
    stats: function () { return request('/stats'); },
    apiKeyStatus: function () { return request('/api-key'); },
    apiKeyGenerate: function () { return postJSON('/api-key/generate'); },
    apiKeyRevoke: function () { return postJSON('/api-key/revoke'); },
  };
})();
