(function () {
  var api = window.WazapiAPI;

  // Kalau sesi masih valid, langsung lempar ke dashboard - tidak perlu
  // nampilin form login/register ke user yang sudah login.
  api.device().then(function () {
    window.location.replace('/dashboard');
  }).catch(function () { /* belum login, tetap di halaman ini */ });

  document.querySelectorAll('[data-toggle-password]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var input = document.getElementById(btn.getAttribute('data-toggle-password'));
      if (!input) return;
      var show = input.type === 'password';
      input.type = show ? 'text' : 'password';
      btn.setAttribute('aria-label', show ? 'Sembunyikan password' : 'Tampilkan password');
      btn.innerHTML = show
        ? '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.94 10.94 0 0 1 12 20c-7 0-11-8-11-8a18.5 18.5 0 0 1 5.06-5.94M9.9 4.24A10.94 10.94 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>'
        : '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>';
    });
  });

  function showAlert(el, message) {
    el.textContent = message;
    el.className = 'alert alert-error show';
  }
  function hideAlert(el) { el.className = 'alert'; }
  function setLoading(btn, loading, label) {
    btn.disabled = loading;
    btn.classList.toggle('is-loading', loading);
    if (!btn.querySelector('.spinner')) {
      btn.insertAdjacentHTML('afterbegin', '<span class="spinner"></span>');
    }
    if (!btn.querySelector('.btn-text')) {
      var text = btn.textContent.trim();
      btn.innerHTML = '<span class="spinner"></span><span class="btn-text">' + text + '</span>';
    }
    if (label) btn.querySelector('.btn-text').textContent = label;
  }

  var loginForm = document.getElementById('login-form');
  if (loginForm) {
    var loginAlert = document.getElementById('login-alert');
    var loginSubmit = document.getElementById('login-submit');
    loginForm.addEventListener('submit', function (e) {
      e.preventDefault();
      hideAlert(loginAlert);
      var username = document.getElementById('login-username').value.trim();
      var password = document.getElementById('login-password').value;
      setLoading(loginSubmit, true, 'Memeriksa...');
      api.login(username, password).then(function (data) {
        if (data.nama) sessionStorage.setItem('wazapp-nama', data.nama);
        window.location.href = '/dashboard';
      }).catch(function (err) {
        showAlert(loginAlert, err.message);
        setLoading(loginSubmit, false, 'Masuk');
      });
    });
  }

  var registerForm = document.getElementById('register-form');
  if (registerForm) {
    var registerAlert = document.getElementById('register-alert');
    var registerSubmit = document.getElementById('register-submit');
    registerForm.addEventListener('submit', function (e) {
      e.preventDefault();
      hideAlert(registerAlert);
      var nama = document.getElementById('register-nama').value.trim();
      var username = document.getElementById('register-username').value.trim();
      var password = document.getElementById('register-password').value;
      var confirm = document.getElementById('register-confirm').value;
      var terms = document.getElementById('register-terms');

      if (password !== confirm) {
        showAlert(registerAlert, 'Konfirmasi password tidak sama.');
        return;
      }
      if (terms && !terms.checked) {
        showAlert(registerAlert, 'Kamu harus menyetujui syarat & ketentuan.');
        return;
      }

      setLoading(registerSubmit, true, 'Mendaftarkan...');
      api.register(username, password, nama).then(function (data) {
        if (data.nama) sessionStorage.setItem('wazapp-nama', data.nama);
        window.location.href = '/dashboard';
      }).catch(function (err) {
        showAlert(registerAlert, err.message);
        setLoading(registerSubmit, false, 'Daftar');
      });
    });
  }
})();
