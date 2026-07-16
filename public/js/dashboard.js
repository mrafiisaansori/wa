(function () {
  var api = window.WazapiAPI;

  // ---------- Guard sesi ----------
  var currentTenantName = '-';
  api.device().catch(function (err) {
    if (err.status === 401) { window.location.replace('/login'); throw err; }
    throw err;
  }).then(function () {
    init();
  }).catch(function () { /* redirect sudah jalan di atas */ });

  function escapeHtml(str) { var d = document.createElement('div'); d.textContent = str == null ? '' : String(str); return d.innerHTML; }
  function fmtDate(iso) {
    if (!iso) return '-';
    try { return new Date(iso).toLocaleString('id-ID', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }); }
    catch (e) { return iso; }
  }
  function showAlert(el, message, type) { el.textContent = message; el.className = 'alert show alert-' + (type || 'error'); }
  function hideAlert(el) { el.className = 'alert'; }

  function showToast(message, type) {
    var stack = document.getElementById('toast-stack');
    var el = document.createElement('div');
    el.className = 'toast toast-' + (type || 'success');
    var icon = type === 'error'
      ? '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>'
      : '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"><polyline points="20 6 9 17 4 12"/></svg>';
    el.innerHTML = '<span class="toast-icon">' + icon + '</span><span>' + escapeHtml(message) + '</span>';
    stack.appendChild(el);
    setTimeout(function () {
      el.classList.add('leaving');
      setTimeout(function () { el.remove(); }, 200);
    }, 5000);
  }

  function init() {
    setupSidebar();
    setupProfileMenu();
    setupWarnBanner();
    setupNav();
    setupModal();
    setupPairing();
    setupUnlink();
    setupDeviceActions();
    setupApiKey();
    setupHistoryTable();
    loadWhoAmI();
    setSection('dashboard');
    loadDevice(); // inisialisasi status koneksi + mulai pantau kalau belum terhubung, apapun section yang lagi dibuka
  }

  // ---------- Sidebar collapse (desktop) + drawer (mobile) ----------
  function setupSidebar() {
    var sidebar = document.getElementById('sidebar');
    var collapseBtn = document.getElementById('sidebar-collapse-btn');
    var hamburgerBtn = document.getElementById('hamburger-btn');
    var overlay = document.getElementById('sidebar-overlay');

    if (localStorage.getItem('wazapp-sidebar-collapsed') === '1') sidebar.classList.add('collapsed');
    collapseBtn.addEventListener('click', function () {
      sidebar.classList.toggle('collapsed');
      localStorage.setItem('wazapp-sidebar-collapsed', sidebar.classList.contains('collapsed') ? '1' : '0');
    });

    function openDrawer() { sidebar.classList.add('mobile-open'); overlay.classList.add('open'); }
    function closeDrawer() { sidebar.classList.remove('mobile-open'); overlay.classList.remove('open'); }
    hamburgerBtn.addEventListener('click', openDrawer);
    overlay.addEventListener('click', closeDrawer);
    sidebar.querySelectorAll('.nav-item').forEach(function (el) { el.addEventListener('click', closeDrawer); });
  }

  // ---------- Profile dropdown ----------
  function setupProfileMenu() {
    var btn = document.getElementById('profile-btn');
    var dropdown = document.getElementById('profile-dropdown');
    btn.addEventListener('click', function (e) {
      e.stopPropagation();
      dropdown.classList.toggle('open');
    });
    document.addEventListener('click', function () { dropdown.classList.remove('open'); });
    document.getElementById('logout-btn').addEventListener('click', function () {
      api.logout().finally(function () { window.location.href = '/login'; });
    });
  }

  function loadWhoAmI() {
    // Nama tenant tidak dikembalikan GET /device - dipakai dari /login response
    // kalau ada (session render pertama), atau fallback ke label generik.
    var stored = sessionStorage.getItem('wazapp-nama');
    currentTenantName = stored || 'Akun';
    document.getElementById('who-name').textContent = currentTenantName;
    document.getElementById('profile-name').textContent = currentTenantName;
    document.getElementById('profile-avatar').textContent = currentTenantName.slice(0, 1).toUpperCase();
  }

  // ---------- Warning banner ----------
  function setupWarnBanner() {
    var banner = document.getElementById('warn-banner');
    if (sessionStorage.getItem('wazapp-warn-dismissed') !== '1') {
      banner.classList.remove('hidden');
    }
    document.getElementById('warn-dismiss').addEventListener('click', function () {
      sessionStorage.setItem('wazapp-warn-dismissed', '1');
      banner.classList.add('hidden');
    });
  }

  // ---------- Navigasi section ----------
  var sectionTitles = { dashboard: 'Dashboard', pesan: 'Pesan', perangkat: 'Perangkat', apikey: 'API Key' };
  function setSection(name) {
    document.querySelectorAll('.content-section').forEach(function (el) {
      el.classList.toggle('hidden', el.id !== 'section-' + name);
    });
    document.querySelectorAll('.nav-item[data-section]').forEach(function (el) {
      el.classList.toggle('active', el.getAttribute('data-section') === name);
    });
    document.getElementById('navbar-title').textContent = sectionTitles[name] || '';
    if (name !== 'perangkat') stopQrPolling();
    if (name === 'dashboard') { loadDashboardData(); }
    if (name === 'pesan') { loadHistory(); }
    if (name === 'perangkat') { loadDevice(); loadDeviceMiniStats(); }
    if (name === 'apikey') { loadApiKeyStatus(); }
  }
  function setupNav() {
    document.querySelectorAll('[data-section]').forEach(function (el) {
      el.addEventListener('click', function () { setSection(el.getAttribute('data-section')); });
    });
    document.getElementById('nav-docs').addEventListener('click', function () { window.open('/docs/app', '_blank'); });
  }

  // ---------- Dashboard: stats + charts + activity ----------
  function loadDashboardData() {
    Promise.all([api.stats(), api.device(), api.history(200)]).then(function (results) {
      var stats = results[0], device = results[1], history = results[2];
      var sukses = (stats.terkirim || 0) + (stats.delivered || 0) + (stats.read || 0);
      var rate = stats.total ? Math.round((sukses / stats.total) * 100) : 0;

      document.getElementById('stat-device').innerHTML = device.connected
        ? '<span style="color:var(--success)">Terhubung</span>' : '<span style="color:var(--danger)">Terputus</span>';
      document.getElementById('stat-total').textContent = stats.total || 0;
      document.getElementById('stat-success-rate').textContent = rate + '%';
      document.getElementById('stat-gagal').textContent = stats.gagal || 0;
      document.getElementById('stat-queue').textContent = device.antrian || 0;
      document.getElementById('stat-api').textContent = stats.total || 0;

      renderVolumeChart(history);
      renderStatusChart(stats);
      renderActivity(history.slice(0, 5));
    }).catch(function () { /* biarkan tampil placeholder */ });
  }

  function renderActivity(rows) {
    var el = document.getElementById('activity-list');
    if (!rows.length) { el.innerHTML = '<li class="empty-state">Belum ada aktivitas.</li>'; return; }
    el.innerHTML = rows.map(function (r) {
      return '<li class="activity-row">' +
        '<span class="activity-num">' + escapeHtml(r.nomor_tujuan) + '</span>' +
        '<span class="activity-msg">' + escapeHtml(r.pesan) + '</span>' +
        '<span class="badge badge-' + statusBadgeClass(r.status) + '">' + r.status + '</span>' +
        '<span class="activity-time">' + fmtDate(r.dibuat_at) + '</span>' +
      '</li>';
    }).join('');
  }

  function statusBadgeClass(status) {
    if (status === 'gagal') return 'danger';
    if (status === 'antri') return 'neutral';
    if (status === 'terkirim') return 'primary';
    return 'success'; // delivered, read
  }

  // ---------- Chart: volume 7 hari (SVG line, tanpa library) ----------
  function renderVolumeChart(rows) {
    var days = [];
    for (var i = 6; i >= 0; i--) {
      var d = new Date(); d.setDate(d.getDate() - i);
      days.push({ key: d.toISOString().slice(0, 10), label: d.toLocaleDateString('id-ID', { weekday: 'short' }), count: 0 });
    }
    var byDay = {};
    days.forEach(function (d) { byDay[d.key] = d; });
    rows.forEach(function (r) {
      var key = String(r.dibuat_at).slice(0, 10);
      if (byDay[key]) byDay[key].count += 1;
    });

    var w = 480, h = 140, pad = 8;
    var max = Math.max.apply(null, days.map(function (d) { return d.count; }).concat([1]));
    var stepX = (w - pad * 2) / (days.length - 1);
    var points = days.map(function (d, i) {
      var x = pad + i * stepX;
      var y = h - pad - ((d.count / max) * (h - pad * 2));
      return { x: x, y: y, d: d };
    });
    var line = points.map(function (p) { return p.x + ',' + p.y; }).join(' ');
    var area = line + ' ' + points[points.length - 1].x + ',' + h + ' ' + points[0].x + ',' + h;

    var svg = '<svg width="100%" height="150" viewBox="0 0 ' + w + ' ' + (h + 24) + '" preserveAspectRatio="none">' +
      '<polygon points="' + area + '" fill="var(--primary)" opacity="0.1"></polygon>' +
      '<polyline points="' + line + '" fill="none" stroke="var(--primary)" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"></polyline>' +
      points.map(function (p) { return '<circle cx="' + p.x + '" cy="' + p.y + '" r="3" fill="var(--primary)"></circle>'; }).join('') +
      points.map(function (p) { return '<text x="' + p.x + '" y="' + (h + 18) + '" font-size="10" fill="var(--text-muted)" text-anchor="middle">' + p.d.label + '</text>'; }).join('') +
      '</svg>';
    document.getElementById('chart-volume').innerHTML = rows.length ? svg : '<div class="empty-state" style="padding:24px;">Belum ada data pesan.</div>';
  }

  // ---------- Chart: distribusi status (SVG bar) ----------
  function renderStatusChart(stats) {
    var items = [
      { key: 'antri', label: 'Antri', color: 'var(--text-muted)' },
      { key: 'terkirim', label: 'Terkirim', color: 'var(--primary)' },
      { key: 'delivered', label: 'Delivered', color: 'var(--secondary)' },
      { key: 'read', label: 'Read', color: '#0EA5E9' },
      { key: 'gagal', label: 'Gagal', color: 'var(--danger)' },
    ];
    var max = Math.max.apply(null, items.map(function (i) { return stats[i.key] || 0; }).concat([1]));
    var w = 260, barH = 20, gap = 14, h = items.length * (barH + gap);
    var bars = items.map(function (item, i) {
      var val = stats[item.key] || 0;
      var bw = (val / max) * (w - 70);
      var y = i * (barH + gap);
      return '<text x="0" y="' + (y + barH - 6) + '" font-size="11" fill="var(--text-dim)">' + item.label + '</text>' +
        '<rect x="66" y="' + y + '" width="' + Math.max(bw, 2) + '" height="' + barH + '" rx="5" fill="' + item.color + '"></rect>' +
        '<text x="' + (66 + Math.max(bw, 2) + 8) + '" y="' + (y + barH - 6) + '" font-size="11" font-weight="700" fill="var(--text)">' + val + '</text>';
    }).join('');
    document.getElementById('chart-status').innerHTML =
      '<svg width="100%" height="' + h + '" viewBox="0 0 ' + w + ' ' + h + '">' + bars + '</svg>';
    document.getElementById('chart-status-legend').innerHTML = items.map(function (item) {
      return '<span><i style="background:' + item.color + '"></i>' + item.label + '</span>';
    }).join('');
  }

  // ---------- Pesan: tabel dengan search/filter/pagination (client-side) ----------
  var historyState = { rows: [], search: '', filter: '', page: 1, pageSize: 10 };

  function setupHistoryTable() {
    document.getElementById('history-search').addEventListener('input', function (e) {
      historyState.search = e.target.value.trim().toLowerCase();
      historyState.page = 1;
      renderHistoryTable();
    });
    document.getElementById('history-filter').addEventListener('change', function (e) {
      historyState.filter = e.target.value;
      historyState.page = 1;
      renderHistoryTable();
    });
    document.getElementById('refresh-btn').addEventListener('click', function () {
      var btn = document.getElementById('refresh-btn');
      btn.querySelector('svg').classList.add('spin');
      loadHistory().finally(function () { setTimeout(function () { btn.querySelector('svg').classList.remove('spin'); }, 400); });
    });
  }

  function loadHistory() {
    var wrap = document.getElementById('history-wrap');
    wrap.innerHTML = skeletonRows(6);
    return api.history(200).then(function (rows) {
      historyState.rows = rows;
      historyState.page = 1;
      renderHistoryTable();
    }).catch(function () {
      wrap.innerHTML = '<div class="empty-state">Gagal memuat riwayat.</div>';
    });
  }

  function skeletonRows(n) {
    var row = '<div class="skeleton-row" style="padding:14px 16px;display:flex;gap:16px;"><div class="skeleton-bar" style="width:110px;"></div><div class="skeleton-bar" style="flex:1;"></div><div class="skeleton-bar" style="width:80px;"></div><div class="skeleton-bar" style="width:90px;"></div></div>';
    return new Array(n).fill(row).join('');
  }

  function renderHistoryTable() {
    var filtered = historyState.rows.filter(function (r) {
      if (historyState.filter && r.status !== historyState.filter) return false;
      if (historyState.search) {
        var hay = (r.nomor_tujuan + ' ' + r.pesan).toLowerCase();
        if (hay.indexOf(historyState.search) === -1) return false;
      }
      return true;
    });

    var wrap = document.getElementById('history-wrap');
    if (!filtered.length) {
      wrap.innerHTML = '<div class="empty-state">Tidak ada riwayat yang cocok.</div>';
      document.getElementById('history-pagination').innerHTML = '';
      return;
    }

    var totalPages = Math.max(1, Math.ceil(filtered.length / historyState.pageSize));
    if (historyState.page > totalPages) historyState.page = totalPages;
    var start = (historyState.page - 1) * historyState.pageSize;
    var pageRows = filtered.slice(start, start + historyState.pageSize);

    var html = '<table><thead><tr><th>Nomor</th><th>Pesan</th><th>Status</th><th>Waktu</th></tr></thead><tbody>';
    pageRows.forEach(function (r) {
      html += '<tr>' +
        '<td style="font-family:ui-monospace,monospace;font-size:12.5px;white-space:nowrap;">' + escapeHtml(r.nomor_tujuan) + '</td>' +
        '<td style="max-width:320px;color:var(--text-dim);">' + escapeHtml(r.pesan) + '</td>' +
        '<td><span class="badge badge-' + statusBadgeClass(r.status) + '">' + r.status + '</span></td>' +
        '<td style="color:var(--text-muted);font-size:12px;white-space:nowrap;">' + fmtDate(r.dibuat_at) + '</td>' +
        '</tr>';
    });
    html += '</tbody></table>';
    wrap.innerHTML = html;

    renderPagination(totalPages);
  }

  function renderPagination(totalPages) {
    var el = document.getElementById('history-pagination');
    if (totalPages <= 1) { el.innerHTML = ''; return; }
    var html = '<button class="page-btn" ' + (historyState.page === 1 ? 'disabled' : '') + ' data-page="' + (historyState.page - 1) + '">&laquo;</button>';
    for (var i = 1; i <= totalPages; i++) {
      html += '<button class="page-btn ' + (i === historyState.page ? 'active' : '') + '" data-page="' + i + '">' + i + '</button>';
    }
    html += '<button class="page-btn" ' + (historyState.page === totalPages ? 'disabled' : '') + ' data-page="' + (historyState.page + 1) + '">&raquo;</button>';
    el.innerHTML = html;
    el.querySelectorAll('.page-btn').forEach(function (btn) {
      btn.addEventListener('click', function () {
        historyState.page = Number(btn.getAttribute('data-page'));
        renderHistoryTable();
      });
    });
  }

  // ---------- Perangkat ----------
  // Pantau status koneksi biar user tau device-nya berhasil tertaut TANPA
  // harus pindah section atau reload manual - jalan di background (bukan
  // cuma pas lagi buka section Perangkat) sampai device terhubung.
  var DEVICE_LABEL_KEY = 'wazapp-device-label';
  var lastKnownConnected = null;
  var deviceWatchTimer = null;
  var pairingMode = 'qr';
  var qrPollTimer = null;
  var pairingModalOpen = false;

  function stopDeviceWatch() { if (deviceWatchTimer) { clearInterval(deviceWatchTimer); deviceWatchTimer = null; } }
  function startDeviceWatch() {
    if (deviceWatchTimer) return;
    deviceWatchTimer = setInterval(loadDevice, 6000);
  }

  // Klasifikasi status dari data REAL yang ada - tidak ada field "reconnecting"
  // tersendiri dari server, tapi percobaan_reconnect > 0 saat belum connected
  // adalah sinyal jujur bahwa itu lagi proses sambung ulang, bukan diam total.
  function classifyDeviceState(data) {
    if (!data.nomor) return 'not-connected';
    if (data.connected) return 'connected';
    if (data.percobaan_reconnect > 0) return 'reconnecting';
    return 'disconnected';
  }
  var STATE_LABEL = {
    connected: 'Perangkat terhubung', reconnecting: 'Menyambungkan ulang...',
    disconnected: 'Perangkat terputus', 'not-connected': 'Belum ada perangkat',
  };
  var STATE_PILL_CLASS = { connected: 'online', reconnecting: 'reconnecting', disconnected: 'offline', 'not-connected': 'neutral' };
  var STATE_ICON_CLASS = { connected: 'icon-wa', reconnecting: 'icon-spinner', disconnected: 'icon-warn', 'not-connected': 'icon-qr' };

  function renderPhoneMock(state, justConnected) {
    var phone = document.getElementById('phone-mock');
    phone.setAttribute('data-state', state);
    phone.querySelectorAll('.phone-mock-icon').forEach(function (ic) { ic.classList.remove('is-active'); });
    var iconEl = phone.querySelector('.' + STATE_ICON_CLASS[state]);
    if (iconEl) iconEl.classList.add('is-active');
    document.getElementById('phone-mock-badge').classList.toggle('is-visible', state === 'connected');
    document.querySelectorAll('.illus-line').forEach(function (l) { l.classList.toggle('is-live', state === 'connected'); });
    if (justConnected) {
      phone.classList.add('just-connected');
      setTimeout(function () { phone.classList.remove('just-connected'); }, 900);
    }
  }

  function refreshHeroCopy(state) {
    var label = (localStorage.getItem(DEVICE_LABEL_KEY) || '').trim();
    document.getElementById('device-hero-title').textContent = label
      ? label
      : (state === 'connected' ? 'Perangkat WhatsApp Terhubung' : 'Hubungkan Perangkat WhatsApp');
    document.getElementById('device-hero-connect-btn').classList.toggle('hidden', state === 'connected');
  }

  function renderDeviceTimeline(log) {
    var el = document.getElementById('device-log-list');
    if (!log.length) { el.innerHTML = '<li class="empty-state">Belum ada riwayat koneksi.</li>'; return; }
    var meta = {
      connected: { dot: 'dot-success', label: 'Perangkat terhubung' },
      disconnected: { dot: 'dot-warning', label: 'Koneksi terputus' },
      logged_out: { dot: 'dot-danger', label: 'Sesi logout dari HP' },
      pairing_requested: { dot: 'dot-primary', label: 'Kode/QR pairing diminta' },
      device_unlinked: { dot: 'dot-danger', label: 'Perangkat diputus manual' },
    };
    el.innerHTML = log.map(function (r) {
      var m = meta[r.event] || { dot: '', label: r.event };
      return '<li>' +
        '<span class="timeline-dot ' + m.dot + '"><svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="12" r="6"/></svg></span>' +
        '<span class="timeline-body"><span class="title">' + escapeHtml(m.label) + (r.detail ? ' - ' + escapeHtml(r.detail) : '') + '</span><span class="time">' + fmtDate(r.dicatat_at) + '</span></span>' +
      '</li>';
    }).join('');
  }

  function loadDevice() {
    return api.device().then(function (data) {
      var state = classifyDeviceState(data);
      var justConnected = data.connected && lastKnownConnected === false;
      if (justConnected) {
        showToast('Perangkat berhasil terhubung ke WhatsApp!', 'success');
        burstConfetti();
        closePairingModal();
      }
      lastKnownConnected = data.connected;
      if (data.connected) { stopDeviceWatch(); stopQrPolling(); } else { startDeviceWatch(); }

      renderPhoneMock(state, justConnected);
      var pill = document.getElementById('device-status');
      pill.className = 'status-pill ' + STATE_PILL_CLASS[state];
      pill.innerHTML = '<span class="led"></span> ' + STATE_LABEL[state];
      refreshHeroCopy(state);

      document.getElementById('device-nomor').textContent = data.nomor || '-';
      document.getElementById('device-nama-wa').textContent = data.nama_wa || '-';
      document.getElementById('device-platform').textContent = data.platform || '-';
      document.getElementById('device-nama-perangkat').textContent = data.nama_perangkat || '-';
      document.getElementById('device-terhubung-sejak').textContent = data.terhubung_sejak ? fmtDate(data.terhubung_sejak) : '-';
      document.getElementById('device-reconnect').textContent = data.percobaan_reconnect;
      document.getElementById('mini-stat-status').textContent = STATE_LABEL[state];
      document.getElementById('mini-stat-queue').textContent = data.antrian;

      renderDeviceTimeline(data.riwayat_koneksi || []);

      if (pairingModalOpen) {
        document.getElementById('pairing-live-text').textContent = data.connected ? 'Terhubung!' : 'Menunggu HP kamu scan/masukkan kode...';
        document.getElementById('pairing-live-status').classList.toggle('is-waiting', !data.connected);
      }
    }).catch(function () { /* diamkan, guard sesi sudah nangani 401 di awal load */ });
  }

  // Cuma dihitung dari /history yang sudah ada (bukan endpoint baru) - jumlah
  // pesan hari ini per status, buat mini-stat "Terkirim/Gagal Hari Ini".
  function loadDeviceMiniStats() {
    api.history(200).then(function (rows) {
      var todayKey = new Date().toISOString().slice(0, 10);
      var sentToday = 0, failedToday = 0;
      rows.forEach(function (r) {
        if (String(r.dibuat_at).slice(0, 10) !== todayKey) return;
        if (r.status === 'gagal') failedToday += 1;
        else if (r.status !== 'antri') sentToday += 1;
      });
      document.getElementById('mini-stat-sent-today').textContent = sentToday;
      document.getElementById('mini-stat-failed-today').textContent = failedToday;
    }).catch(function () { /* biarkan tampil placeholder */ });
  }

  // ---------- QR & kode pairing (dalam modal) ----------
  function stopQrPolling() { if (qrPollTimer) { clearInterval(qrPollTimer); qrPollTimer = null; } }

  function resetCountdown(el, className) {
    el.classList.remove('is-counting', 'is-counting-60');
    void el.offsetWidth; // paksa reflow biar animasi CSS restart dari awal
    el.classList.add(className);
  }

  function fetchQr() {
    if (document.hidden) return; // hemat request pas tab tidak aktif dilihat
    var img = document.getElementById('qr-image');
    var loading = document.getElementById('qr-loading');
    var statusText = document.getElementById('qr-status-text');
    var alertEl = document.getElementById('qr-alert');
    hideAlert(alertEl);
    api.deviceQr().then(function (data) {
      img.src = data.qr;
      img.classList.remove('hidden');
      loading.classList.add('hidden');
      statusText.textContent = 'QR diperbarui otomatis tiap ±20 detik.';
      resetCountdown(document.getElementById('qr-countdown-bar'), 'is-counting');
    }).catch(function (err) {
      if (err.status === 400) { stopQrPolling(); return; } // sudah tertaut
      statusText.textContent = err.message;
    });
  }

  function startQrPolling() {
    stopQrPolling();
    document.getElementById('qr-image').classList.add('hidden');
    document.getElementById('qr-loading').classList.remove('hidden');
    document.getElementById('qr-status-text').textContent = 'Memuat QR...';
    fetchQr();
    qrPollTimer = setInterval(fetchQr, 20000);
  }

  function openPairingModal() {
    pairingModalOpen = true;
    document.getElementById('modal-pairing').classList.remove('hidden');
    document.getElementById('pairing-live-status').classList.add('is-waiting');
    document.getElementById('pairing-live-text').textContent = 'Menunggu HP kamu scan/masukkan kode...';
    if (pairingMode === 'qr') startQrPolling();
  }
  function closePairingModal() {
    pairingModalOpen = false;
    document.getElementById('modal-pairing').classList.add('hidden');
    stopQrPolling();
  }

  function setupPairing() {
    var modeToggle = document.getElementById('pairing-mode-toggle');
    var codeBlock = document.getElementById('pairing-mode-code');
    var qrBlock = document.getElementById('pairing-mode-qr');
    var stepsQr = document.getElementById('pairing-steps-qr');
    var stepsCode = document.getElementById('pairing-steps-code');

    modeToggle.querySelectorAll('button').forEach(function (btn) {
      btn.addEventListener('click', function () {
        pairingMode = btn.getAttribute('data-pairing-mode');
        modeToggle.querySelectorAll('button').forEach(function (b) { b.classList.toggle('active', b === btn); });
        codeBlock.classList.toggle('hidden', pairingMode !== 'code');
        qrBlock.classList.toggle('hidden', pairingMode !== 'qr');
        stepsCode.classList.toggle('hidden', pairingMode !== 'code');
        stepsQr.classList.toggle('hidden', pairingMode !== 'qr');
        if (pairingMode === 'qr') startQrPolling(); else stopQrPolling();
      });
    });

    document.getElementById('pairing-form').addEventListener('submit', function (e) {
      e.preventDefault();
      var alertEl = document.getElementById('pairing-alert');
      hideAlert(alertEl);
      document.getElementById('pairing-code-wrap').classList.add('hidden');
      var nomor = document.getElementById('pairing-nomor').value.trim();
      var btn = document.getElementById('pairing-submit');
      btn.disabled = true; btn.textContent = 'Meminta kode...';
      api.pairingCode(nomor).then(function (data) {
        document.getElementById('pairing-code').textContent = data.code;
        document.getElementById('pairing-code-wrap').classList.remove('hidden');
        resetCountdown(document.getElementById('code-countdown-bar'), 'is-counting-60');
        showAlert(alertEl, data.catatan || 'Kode diterbitkan.', 'success');
      }).catch(function (err) {
        showAlert(alertEl, err.message, 'error');
      }).finally(function () {
        btn.disabled = false; btn.textContent = 'Minta Kode Pairing';
      });
    });

    document.getElementById('device-hero-connect-btn').addEventListener('click', openPairingModal);
    document.getElementById('qa-open-pairing').addEventListener('click', openPairingModal);
    document.getElementById('close-pairing-modal').addEventListener('click', closePairingModal);
    document.getElementById('modal-pairing').addEventListener('click', function (e) {
      if (e.target === document.getElementById('modal-pairing')) closePairingModal();
    });
  }

  function setupUnlink() {
    document.getElementById('qa-unlink').addEventListener('click', function () {
      if (!confirm('Putuskan perangkat WA dari akun ini? Perlu pairing ulang setelah ini.')) return;
      var btn = document.getElementById('qa-unlink');
      btn.disabled = true;
      api.deviceLogout().then(function () {
        document.getElementById('pairing-code-wrap').classList.add('hidden');
        loadDevice();
        showToast('Perangkat diputus.', 'success');
      }).catch(function () { showToast('Gagal memutuskan perangkat.', 'error'); })
        .finally(function () { btn.disabled = false; });
    });
  }

  // Aksi cepat lain: refresh manual, dan "ganti nama" kosmetik (localStorage
  // saja, TIDAK dikirim ke server - lihat catatan di field-hint UI).
  function setupDeviceActions() {
    document.getElementById('qa-refresh-status').addEventListener('click', function (e) {
      var svg = e.currentTarget.querySelector('svg');
      svg.classList.add('spin');
      Promise.all([loadDevice(), loadDeviceMiniStats()]).finally(function () {
        setTimeout(function () { svg.classList.remove('spin'); }, 400);
        showToast('Status diperbarui.', 'success');
      });
    });

    document.getElementById('qa-rename').addEventListener('click', function () {
      var current = localStorage.getItem(DEVICE_LABEL_KEY) || '';
      var next = prompt('Nama perangkat (cuma tersimpan di browser ini):', current);
      if (next === null) return;
      next = next.trim().slice(0, 60);
      if (next) localStorage.setItem(DEVICE_LABEL_KEY, next); else localStorage.removeItem(DEVICE_LABEL_KEY);
      document.getElementById('device-label-input').value = next;
      refreshHeroCopy(lastKnownConnected ? 'connected' : 'not-connected');
      showToast('Nama perangkat diperbarui.', 'success');
    });

    var labelInput = document.getElementById('device-label-input');
    labelInput.value = localStorage.getItem(DEVICE_LABEL_KEY) || '';
    labelInput.addEventListener('change', function () {
      var v = labelInput.value.trim().slice(0, 60);
      if (v) localStorage.setItem(DEVICE_LABEL_KEY, v); else localStorage.removeItem(DEVICE_LABEL_KEY);
      refreshHeroCopy(lastKnownConnected ? 'connected' : 'not-connected');
    });
  }

  // ---------- Confetti (murni CSS/JS, tanpa library) ----------
  function burstConfetti() {
    var colors = ['#16A34A', '#22C55E', '#F59E0B', '#0EA5E9', '#EF4444'];
    for (var i = 0; i < 28; i++) {
      var el = document.createElement('div');
      el.className = 'confetti-piece';
      el.style.left = (35 + Math.random() * 30) + 'vw';
      el.style.background = colors[i % colors.length];
      el.style.animationDuration = (1.3 + Math.random() * 0.9) + 's';
      el.style.animationDelay = (Math.random() * 0.25) + 's';
      document.body.appendChild(el);
      (function (node) { setTimeout(function () { node.remove(); }, 3000); })(el);
    }
  }

  // ---------- Modal kirim / broadcast ----------
  function setupModal() {
    var modal = document.getElementById('modal-kirim');
    var sendForm = document.getElementById('send-form');
    var sendAlert = document.getElementById('send-alert');
    var sendSubmit = document.getElementById('send-submit');
    var modeToggle = document.getElementById('send-mode-toggle');
    var nomorField = document.getElementById('send-nomor-field');
    var nomorListField = document.getElementById('send-nomor-list-field');
    var nomorHint = document.getElementById('send-nomor-hint');
    var mode = 'single';

    function openModal(initialMode) {
      hideAlert(sendAlert);
      sendForm.reset();
      setMode(initialMode || 'single');
      modal.classList.remove('hidden');
    }
    function closeModal() { modal.classList.add('hidden'); }
    function setMode(m) {
      mode = m;
      modeToggle.querySelectorAll('button').forEach(function (b) { b.classList.toggle('active', b.getAttribute('data-mode') === m); });
      nomorField.classList.toggle('hidden', m === 'broadcast');
      nomorListField.classList.toggle('hidden', m === 'single');
      nomorHint.classList.toggle('hidden', m === 'broadcast');
    }

    document.getElementById('qa-send').addEventListener('click', function () { openModal('single'); });
    document.getElementById('qa-broadcast').addEventListener('click', function () { openModal('broadcast'); });
    document.getElementById('close-send-modal').addEventListener('click', closeModal);
    modal.addEventListener('click', function (e) { if (e.target === modal) closeModal(); });
    modeToggle.querySelectorAll('button').forEach(function (b) {
      b.addEventListener('click', function () { setMode(b.getAttribute('data-mode')); });
    });

    sendForm.addEventListener('submit', function (e) {
      e.preventDefault();
      hideAlert(sendAlert);
      var pesan = document.getElementById('send-pesan').value.trim();
      var request;

      if (mode === 'broadcast') {
        var list = document.getElementById('send-nomor-list').value.split('\n').map(function (s) { return s.trim(); }).filter(Boolean);
        if (!list.length) { showAlert(sendAlert, 'Isi minimal 1 nomor.', 'error'); return; }
        request = api.broadcast(pesan, list);
      } else {
        var nomor = document.getElementById('send-nomor').value.trim();
        request = api.send(nomor, pesan);
      }

      sendSubmit.disabled = true; sendSubmit.textContent = 'Mengirim...';
      request.then(function (data) {
        showAlert(sendAlert, mode === 'broadcast' ? (data.diterima + ' pesan masuk antrian broadcast.') : 'Pesan masuk antrian pengiriman.', 'success');
        var pesanSection = document.getElementById('section-pesan');
        if (!pesanSection.classList.contains('hidden')) loadHistory();
        var dashSection = document.getElementById('section-dashboard');
        if (!dashSection.classList.contains('hidden')) loadDashboardData();
        setTimeout(closeModal, 900);
      }).catch(function (err) {
        showAlert(sendAlert, err.message, 'error');
      }).finally(function () {
        sendSubmit.disabled = false; sendSubmit.textContent = 'Kirim Pesan';
      });
    });
  }

  // ---------- API Key ----------
  function loadApiKeyStatus() {
    var pill = document.getElementById('apikey-status');
    api.apiKeyStatus().then(function (data) {
      pill.className = 'status-pill ' + (data.ada ? 'online' : 'offline');
      pill.innerHTML = '<span class="led"></span> ' + (data.ada ? 'API key aktif' : 'Belum ada API key');
      document.getElementById('apikey-prefix').textContent = data.ada ? (data.prefix + '••••') : '-';
      document.getElementById('apikey-created').textContent = data.dibuat_at ? fmtDate(data.dibuat_at) : '-';
      document.getElementById('apikey-last-used').textContent = data.terakhir_dipakai ? fmtDate(data.terakhir_dipakai) : 'Belum pernah dipakai';
      document.getElementById('apikey-revoke-btn').disabled = !data.ada;
    }).catch(function () {
      pill.className = 'status-pill offline';
      pill.innerHTML = '<span class="led"></span> Gagal memuat status';
    });
  }

  function setupApiKey() {
    var alertEl = document.getElementById('apikey-alert');
    var newWrap = document.getElementById('apikey-new-wrap');
    var newValue = document.getElementById('apikey-new-value');
    var generateBtn = document.getElementById('apikey-generate-btn');
    var revokeBtn = document.getElementById('apikey-revoke-btn');

    generateBtn.addEventListener('click', function () {
      var sudahAda = document.getElementById('apikey-prefix').textContent !== '-';
      if (sudahAda && !confirm('Sudah ada API key aktif - generate baru bikin key LAMA langsung tidak berlaku. Lanjut?')) return;
      hideAlert(alertEl);
      generateBtn.disabled = true; generateBtn.textContent = 'Membuat...';
      api.apiKeyGenerate().then(function (data) {
        newValue.textContent = data.api_key;
        newWrap.classList.remove('hidden');
        showAlert(alertEl, data.catatan, 'success');
        loadApiKeyStatus();
      }).catch(function (err) {
        showAlert(alertEl, err.message, 'error');
      }).finally(function () {
        generateBtn.disabled = false; generateBtn.textContent = 'Generate API Key Baru';
      });
    });

    document.getElementById('apikey-copy-btn').addEventListener('click', function () {
      var btn = document.getElementById('apikey-copy-btn');
      navigator.clipboard.writeText(newValue.textContent).then(function () {
        var original = btn.textContent;
        btn.textContent = 'Tersalin!';
        setTimeout(function () { btn.textContent = original; }, 1500);
      }).catch(function () { alert('Gagal menyalin, salin manual saja.'); });
    });

    revokeBtn.addEventListener('click', function () {
      if (!confirm('Cabut API key? Semua integrasi yang masih pakai key ini langsung berhenti bisa akses API.')) return;
      hideAlert(alertEl);
      revokeBtn.disabled = true;
      api.apiKeyRevoke().then(function () {
        newWrap.classList.add('hidden');
        showAlert(alertEl, 'API key dicabut.', 'success');
        loadApiKeyStatus();
      }).catch(function (err) {
        showAlert(alertEl, err.message, 'error');
      }).finally(function () {
        revokeBtn.disabled = false;
      });
    });
  }
})();
