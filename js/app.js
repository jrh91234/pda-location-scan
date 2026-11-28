// ======================= PDA Location Scan — หน้าจอหลัก =======================
// ใช้กับ Zebra DataWedge แบบ Keystroke output + ENTER: ค่าที่สแกนจะถูก "พิมพ์" ลงช่องสแกนแล้วกด Enter ให้เอง

var APP_VERSION = '20261128-0252'; // ตั้งโดย tools/bump-version.py
var MAX_RECENT = 200;
var SYNC_BATCH = 20;

var S = {
  view: ['scan', 'manual', 'count', 'map', 'kd', 'scrap', 'history'].indexOf(store('pda_view')) >= 0 ? store('pda_view') : 'scan', // เปิดแอป / รีเฟรช → อยู่หน้าเดิม
  user: validName(store('pda_user')) ? store('pda_user') : '', // ชื่อ "0" ฯลฯ ที่ตั้งไว้กันแอบอ้าง = ถือว่ายังไม่มีชื่อ
  device: store('pda_device') || '',
  location: store('pda_loc') || '',
  recent: storeJson('pda_recent') || [],
  draft: storeJson('pda_draft'),
  syncing: false,
  online: true,
  photoQueue: storeJson('pda_photo_queue') || [], // [{photo_id, scan_id}] รูปที่ยังไม่ได้อัปโหลด (ตัวรูปอยู่ใน IndexedDB)
  photoSyncing: false,
  photoCache: {},
  msg: null,
  hist: { filter: { dateFrom: '', dateTo: '', shift: '', location: '', user: '', q: '', includeDeleted: false }, auto: true, users: storeJson('pda_users') || [], lots: storeJson('pda_lots') || [], data: null, loading: false, error: '' }
};

// ---------- helpers ----------
function $(id) { return document.getElementById(id); }
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}
function pad(n) { return (n < 10 ? '0' : '') + n; }
// วันทำงานตัดที่ 08:00 (08:00 – 07:59 ของอีกวัน) · กะเช้า 08:00–19:59 · กะดึก 20:00–07:59
var WD_DAY_START = 8, WD_NIGHT_START = 20;
var SHIFT_TEXT = { day: 'เช้า', night: 'ดึก' };
function workDay(d) {
  d = d ? new Date(d) : new Date();
  if (d.getHours() < WD_DAY_START) d.setDate(d.getDate() - 1);
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
}
function currentShift() { var h = new Date().getHours(); return h >= WD_DAY_START && h < WD_NIGHT_START ? 'day' : 'night'; }
function shiftOf(at) { // 'yyyy-MM-dd HH:mm:ss' → { date, shift }
  var m = String(at || '').match(/^(\d{4})-(\d\d)-(\d\d) (\d\d)/);
  if (!m) return { date: '', shift: '' };
  var h = Number(m[4]);
  return { date: workDay(new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), h)), shift: h >= WD_DAY_START && h < WD_NIGHT_START ? 'day' : 'night' };
}
// ---------- BOM: รหัสสินค้า → ชื่อ / Specification (js/bom.js) ----------
function bomInfo(code) { var b = window.BOM && code ? window.BOM[String(code).trim()] : null; return b ? { name: b[0], spec: b[1], org: (window.BOM_ORG || [])[b[2]] || '', wh: (window.BOM_WH || [])[b[3]] || '' } : null; }
function bomLine(code) {
  var b = bomInfo(code); if (!b || !(b.name || b.spec)) return '';
  return '<div class="bom-line">' + (b.name ? '<span class="bom-name">' + esc(b.name) + '</span>' : '') + (b.spec ? '<span class="bom-spec">' + esc(b.spec) + '</span>' : '') + '</div>';
}
// บรรทัด 2–6 ของแต่ละรายการ: ชื่อ / Spec / จำนวน / Lot / Location (บรรทัด 1 = รหัส อยู่ใน row-top)
function itemLines(r, qtyHtml, locHtml) {
  var b = bomInfo(r.part_code) || {};
  function line(k, v, cls) { return '<div class="il' + (cls ? ' ' + cls : '') + '"><span class="il-k">' + k + '</span><span class="il-v">' + (v || '<span class="muted">-</span>') + '</span></div>'; }
  return '<div class="ilines">' +
    line('ชื่อ', b.name ? esc(b.name) : '', 'il-name') +
    line('Spec', b.spec ? esc(b.spec) : '', 'il-spec') +
    line('จำนวน', qtyHtml !== undefined ? qtyHtml : esc(fmtQty(r.qty, r.unit))) +
    line('Lot', (r.lot_no ? esc(r.lot_no) : '') + (r.pkg_ref ? ' <span class="muted small">· Pkg ' + esc(r.pkg_ref) + '</span>' : '')) +
    line('Location', locHtml !== undefined ? locHtml : (r.location ? '<span class="loc-pill">' + esc(r.location) + '</span>' : '')) +
    (r.note ? line('หมายเหตุ', '<span class="note-v">📝 ' + esc(r.note) + '</span>') : '') +
  '</div>';
}

// รหัสสินค้าที่ชื่อหรือ Specification มีคำค้นนี้ (ส่งไปให้เซิร์ฟเวอร์ค้นต่อ)
function bomSearch(q) {
  q = String(q || '').trim().toLowerCase(); if (q.length < 2 || !window.BOM) return [];
  var out = [];
  for (var k in window.BOM) {
    var b = window.BOM[k];
    if ((b[0] + ' ' + b[1]).toLowerCase().indexOf(q) >= 0) { out.push(k); if (out.length >= 500) break; }
  }
  return out;
}
function today() { var d = new Date(); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
function hhmm(iso) {
  if (!iso) return '';
  if (/^\d{4}-\d\d-\d\d \d\d:\d\d/.test(iso)) return iso.slice(11, 19);
  var d = new Date(iso); return isNaN(d) ? '' : pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
}
function uid() {
  if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
  return 'x' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}
function fmtQty(q, u) { return q === '' || q == null ? '' : (Number(q).toLocaleString('en-US', { maximumFractionDigits: 3 }) + (u ? ' ' + u : '')); }

function saveRecent() {
  var keep = [], others = 0;
  S.recent.forEach(function (r) {
    if (r.status === 'pending') keep.push(r);
    else if (others++ < MAX_RECENT) keep.push(r);
  });
  S.recent = keep;
  storeJson('pda_recent', S.recent);
}

function toast(text, ms) {
  var t = $('toast'); t.textContent = text; t.classList.remove('hidden');
  clearTimeout(toast._t); toast._t = setTimeout(function () { t.classList.add('hidden'); }, ms || 2200);
}

// ---------- เสียง / สั่น ----------
var audioCtx = null;
function beep(ok) {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    var seq = ok ? [[1800, 0.09]] : [[400, 0.18], [300, 0.25]];
    var t = audioCtx.currentTime;
    seq.forEach(function (s) {
      var o = audioCtx.createOscillator(), g = audioCtx.createGain();
      o.frequency.value = s[0]; o.type = 'square'; g.gain.value = 0.15;
      o.connect(g); g.connect(audioCtx.destination); o.start(t); o.stop(t + s[1]); t += s[1] + 0.04;
    });
  } catch (e) { /* ไม่มีเสียงก็ไม่เป็นไร */ }
  if (navigator.vibrate) navigator.vibrate(ok ? 60 : [200, 80, 200]);
}

function setMsg(type, text, camFor) { S.msg = { type: type, text: text, at: Date.now(), camFor: camFor || '' }; renderMsg(); }

// ======================= Layout =======================
var VIEWS = [['scan', '📷', 'สแกน'], ['manual', '⌨️', 'กรอกเอง'], ['map', '🗺', 'ผัง'], ['kd', '📊', 'Kingdee'],
  ['history', '🕘', 'ประวัติ / ลบ'], ['count', '🔢', 'นับรูป'], ['scrap', '♻️', 'Scrap']];
function viewInfo(v) { return VIEWS.filter(function (x) { return x[0] === v; })[0] || VIEWS[0]; }
function pendingCount() { return S.recent.filter(function (r) { return r.status === 'pending'; }).length; }

function render() {
  store('pda_view', S.view);
  var pending = pendingCount(), cur = viewInfo(S.view);
  $('app').innerHTML =
    '<header class="top">' +
      '<button class="icon burger" id="btnMenu" aria-label="เมนู" aria-expanded="false">☰' + (pending ? '<b class="badge burger-badge">' + pending + '</b>' : '') + '</button>' +
      '<div class="brand"><span class="view-title">' + esc(cur[2]) + '</span> <span class="ver">v' + esc(APP_VERSION) + '</span></div>' +
      '<button class="chip" id="btnUser">' + (S.user ? '👤 ' + esc(S.user) : '👤 ใส่ชื่อ') + '</button>' +
      '<span id="net" class="dot ' + (S.online ? 'on' : 'off') + '" title="สถานะเครือข่าย"></span>' +
      '<button class="icon" id="btnSettings" aria-label="ตั้งค่า">⚙</button>' +
    '</header>' +
    '<div id="drawer" class="drawer hidden" aria-hidden="true"><nav class="drawer-panel" aria-label="เมนู">' +
      '<div class="drawer-head">PDA Scan <span class="ver">v' + esc(APP_VERSION) + '</span></div>' +
      VIEWS.map(function (v) {
        return '<button data-view="' + v[0] + '" class="' + (S.view === v[0] ? 'active' : '') + '"><span class="dv-ico">' + v[1] + '</span>' + esc(v[2]) +
          (v[0] === 'scan' && pending ? ' <b class="badge">' + pending + '</b>' : '') + '</button>';
      }).join('') +
    '</nav></div>' +
    '<main id="main" class="view-' + (S.view === 'kd' ? 'map view-kd' : S.view) + '"></main>';
  $('btnUser').onclick = openUserModal;
  $('btnSettings').onclick = openSettings;
  $('btnMenu').onclick = function () { toggleDrawer(); };
  $('drawer').onclick = function (e) { if (e.target === $('drawer')) toggleDrawer(false); };
  Array.prototype.forEach.call(document.querySelectorAll('#drawer [data-view]'), function (b) {
    b.onclick = function () {
      toggleDrawer(false);
      var v = b.getAttribute('data-view'); if (v === S.view) return;
      S.view = v; render(); if (S.view !== 'history' && S.view !== 'count' && S.view !== 'scrap' && !isMapView()) syncRecent();
    };
  });
  if (S.view === 'scan') renderScan(); else if (S.view === 'manual') renderManual(); else if (S.view === 'count') renderCount(); else if (isMapView()) renderMap(); else if (S.view === 'scrap') renderScrap(); else renderHistory();
}

function toggleDrawer(open) {
  var d = $('drawer'); if (!d) return;
  if (open === undefined) open = d.classList.contains('hidden');
  d.classList.toggle('hidden', !open);
  d.setAttribute('aria-hidden', open ? 'false' : 'true');
  $('btnMenu').setAttribute('aria-expanded', open ? 'true' : 'false');
  if (!open) setTimeout(focusScan, 50);
}
document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && $('drawer') && !$('drawer').classList.contains('hidden')) toggleDrawer(false); });

function refreshHeader() {
  var pending = pendingCount();
  var bm = $('btnMenu');
  if (bm) bm.innerHTML = '☰' + (pending ? '<b class="badge burger-badge">' + pending + '</b>' : '');
  var tab = document.querySelector('#drawer [data-view="scan"]');
  if (tab) tab.innerHTML = '<span class="dv-ico">📷</span>สแกน' + (pending ? ' <b class="badge">' + pending + '</b>' : '');
  var n = $('net'); if (n) n.className = 'dot ' + (S.online ? 'on' : 'off');
}

// ======================= หน้าสแกน =======================
// ช่องสแกนสร้างครั้งเดียว ส่วนอื่นอัปเดตแยก — กันตัวอักษรหายระหว่าง DataWedge กำลังพิมพ์
function renderScan() {
  $('main').innerHTML =
    '<div class="seg io-seg"><button type="button" data-io="in" class="' + (S.outMode ? '' : 'active') + '">📥 เก็บเข้า Location</button>' +
      '<button type="button" data-io="out" class="' + (S.outMode ? 'active out' : '') + '">📤 เอาออก</button></div>' +
    (S.outMode ? '<section class="out-card"><b>📤 โหมดเอาออก</b><div class="small">สแกน QR กล่องที่จะเอาออกจาก Location (เบิกไปผลิต / ย้ายไปคลังอื่น ฯลฯ) · ไม่ต้องเลือก Location</div></section>'
      : '<section id="locCard" class="loc-card"></section>') +
    '<div id="kdLoc"></div>' +
    '<section class="scan-box">' +
      '<input id="scanInput" class="scan-input" inputmode="none" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="กดปุ่มสแกนที่ตัวเครื่อง">' +
      '<button id="btnType" class="btn ghost" title="พิมพ์รหัสเอง">⌨</button>' +
    '</section>' +
    '<button id="btnCam" class="btn cam-btn">📸 สแกนด้วยกล้อง (โทรศัพท์)</button>' +
    '<div id="draft"></div>' +
    '<div id="msg"></div>' +
    '<div id="sync"></div>' +
    '<section><div class="sec-title"><span>รายการล่าสุด (เครื่องนี้)</span><span id="count" class="muted"></span></div>' +
    '<div id="recent"></div></section>';

  var inp = $('scanInput');
  inp.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' || e.key === 'Tab' || e.keyCode === 13) {
      e.preventDefault();
      commitScanInput();
    }
  });
  // ไม่ต้องรอ Enter: DataWedge พิมพ์ทั้ง QR เสร็จในเสี้ยววินาที ถ้าเงียบไป SCAN_IDLE_MS ถือว่าสแกนจบ
  // การสแกนครั้งถัดไปจึงเริ่มในช่องว่างเสมอ ไม่ไปต่อท้ายครั้งก่อน
  inp.addEventListener('input', function () {
    clearTimeout(scanIdleTimer);
    if (inp.getAttribute('inputmode') === 'text') return; // พิมพ์เอง → รอ Enter
    scanIdleTimer = setTimeout(commitScanInput, SCAN_IDLE_MS);
  });
  $('btnCam').onclick = function () { openCameraScanner(handleScan, S.outMode ? {} : { onEach: camContinuous }); };
  Array.prototype.forEach.call(document.querySelectorAll('[data-io]'), function (b) {
    b.onclick = function () {
      var out = b.getAttribute('data-io') === 'out'; if (out === !!S.outMode) return;
      S.outMode = out; if (out) setDraft(null);
      S.msg = out ? { type: 'warn', text: '📤 โหมดเอาออก — สแกน QR กล่องที่จะเอาออก', at: Date.now() } : null;
      renderScan();
    };
  });
  $('btnType').onclick = function () {
    inp.setAttribute('inputmode', 'text');
    inp.blur(); setTimeout(function () { inp.focus(); }, 30);
    toast('พิมพ์รหัสแล้วกด Enter');
  };
  renderLoc(); renderDraft(); renderMsg(); renderSync(); renderRecent();
  focusScan();
}

var SCAN_IDLE_MS = 350;
var scanIdleTimer = null;

function commitScanInput() {
  clearTimeout(scanIdleTimer);
  var inp = $('scanInput'); if (!inp) return;
  var v = inp.value; inp.value = '';
  if (inp.getAttribute('inputmode') === 'text') { inp.setAttribute('inputmode', 'none'); inp.blur(); setTimeout(focusScan, 50); }
  handleScan(v);
}

function focusScan() {
  var inp = $('scanInput');
  if (!inp || !$('modal').classList.contains('hidden')) return;
  if (document.activeElement !== inp) inp.focus({ preventScroll: true });
}

function renderLoc() {
  var el = $('locCard'); if (!el) return;
  el.innerHTML = S.location
    ? '<div class="loc-label">Location ปัจจุบัน</div><div class="loc-code">' + esc(S.location) + '</div>' +
      '<button class="btn" id="btnLoc">เปลี่ยน Location</button>'
    : '<div class="loc-label warn-text">ยังไม่ได้เลือก Location</div><div class="loc-hint">สแกน QR ของ Location หรือกดเลือก</div>' +
      '<button class="btn primary" id="btnLoc">เลือก Location</button>';
  el.className = 'loc-card' + (S.location ? '' : ' empty');
  $('btnLoc').onclick = openLocationPicker;
  renderKdLoc();
}

function renderMsg() {
  var el = $('msg'); if (!el) return;
  if (!S.msg) { el.innerHTML = '<div class="msg idle">พร้อมสแกน — สแกน QR สินค้า เลือก Location แล้วกด บันทึก</div>'; return; }
  el.innerHTML = '<div class="msg ' + S.msg.type + '">' + S.msg.text +
    (S.msg.camFor ? '<div class="msg-act"><button class="btn small" data-cam="' + esc(S.msg.camFor) + '">📷 ถ่ายรูปรายการนี้</button></div>' : '') + '</div>';
  bindPhotoButtons(el, function () { return null; });
}

function renderSync() {
  var el = $('sync'); if (!el) return;
  var pending = S.recent.filter(function (r) { return r.status === 'pending'; }).length;
  var pPhotos = S.photoQueue.length;
  var parts = [];
  if (pending) parts.push((S.syncing ? '⏳ กำลังส่ง ' : '⏸ รอส่ง ') + pending + ' รายการ');
  if (pPhotos) parts.push((S.photoSyncing ? '📤 กำลังอัปโหลดรูปเบื้องหลัง ' : '🖼 รูปรออัปโหลด ') + pPhotos + ' รูป');
  el.innerHTML = pending || pPhotos
    ? '<div class="sync-bar"><span>' + parts.join(' · ') + (S.online ? '' : ' (ออฟไลน์)') +
        (pPhotos && !pending ? '<br><span class="muted small">สแกนต่อได้เลย รูปจะส่งเองเมื่อมีสัญญาณ</span>' : '') + '</span>' +
      '<button class="btn small" id="btnSync"' + (S.syncing ? ' disabled' : '') + '>ส่งตอนนี้</button></div>'
    : '';
  if ($('btnSync')) $('btnSync').onclick = function () { flush(true); flushPhotos(true); };
  refreshHeader();
}

var STATUS_TEXT = { pending: 'รอส่ง', saved: 'บันทึกแล้ว', duplicate: 'ซ้ำ', error: 'ผิดพลาด', deleted: 'ลบแล้ว', out: 'เอาออกแล้ว' };

function renderRecent() {
  var el = $('recent'); if (!el) return;
  var t = today();
  var savedToday = S.recent.filter(function (r) {
    var d = new Date(r.scanned_at);
    return r.status === 'saved' && !isNaN(d) && d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) === t;
  }).length;
  if ($('count')) $('count').textContent = 'วันนี้บันทึก ' + savedToday + ' รายการ';
  renderKdLoc();
  // รายการที่ลบแล้วไม่ต้องแสดงในหน้าสแกน (ดูได้ที่หน้าประวัติ → แสดงรายการที่ลบแล้ว)
  var shown = S.recent.filter(function (r) { return r.status !== 'deleted' && r.status !== 'out'; });
  if (!shown.length) { el.innerHTML = '<div class="empty-list muted">ยังไม่มีรายการ</div>'; return; }
  el.innerHTML = shown.slice(0, 60).map(function (r) {
    var extra = '';
    if (r.status === 'duplicate' && r.existing) {
      extra = '<div class="dup">QR นี้บันทึกแล้วที่ <b>' + esc(r.existing.location) + '</b> โดย ' + esc(r.existing.scanned_by) +
        ' (' + esc(r.existing.scanned_at) + ')' +
        (r.existing.location !== r.location ? '<button class="btn small warn" data-move="' + esc(r.scan_id) + '">ย้ายมาที่ ' + esc(r.location) + '</button>' : '') +
        '<button class="btn small" data-dropdup="' + esc(r.scan_id) + '">ยกเลิก</button>' +
        '</div>';
    } else if (r.status === 'error' && r.error) {
      extra = '<div class="dup">' + esc(r.error) + '</div>';
    }
    if (r.pkgWarn && r.pkgWarn.length && r.status !== 'deleted') extra += '<div class="dup">⚠ Package เดียวกันมีอยู่แล้วที่ <b>' + esc(r.pkgWarn.join(', ')) + '</b> — ถ้าเป็นกล่องเดิม ให้ลบรายการใดรายการหนึ่ง</div>';
    if (r.note) extra += '<div class="small muted">📝 ' + esc(r.note) + '</div>';
    var canDelete = r.status !== 'deleted';
    var delLabel = r.status === 'saved' ? 'ลบ' : 'ลบออก';
    return '<div class="row st-' + r.status + '">' +
      '<div class="row-main">' +
        '<div class="row-top">' + partLink(r, r.status === 'saved') + '<span class="tag ' + r.status + '">' + STATUS_TEXT[r.status] + '</span></div>' +
        itemLines(r, qtyChip(r, r.status === 'pending' || r.status === 'saved', 'data-qty'), locChip(r, r.status === 'pending' || r.status === 'saved', 'data-loc-edit')) +
        '<div class="row-sub muted small">' +
          '<span>🕘 ' + hhmm(r.scanned_at) + '</span>' +
          photoChip(r.scan_id, null) +
        '</div>' + extra +
      '</div>' +
      '<div class="row-actions">' +
        (r.status === 'pending' || r.status === 'saved' ? '<button class="btn small" data-cam="' + esc(r.scan_id) + '" aria-label="ถ่ายรูป">📷</button>' : '') +
        (canDelete ? '<button class="btn small danger" data-del="' + esc(r.scan_id) + '">' + delLabel + '</button>' : '') +
      '</div>' +
    '</div>';
  }).join('');
  Array.prototype.forEach.call(el.querySelectorAll('[data-del]'), function (b) {
    b.onclick = function () { deleteRecent(b.getAttribute('data-del')); };
  });
  Array.prototype.forEach.call(el.querySelectorAll('[data-move]'), function (b) {
    b.onclick = function () { moveDuplicate(b.getAttribute('data-move')); };
  });
  Array.prototype.forEach.call(el.querySelectorAll('[data-dropdup]'), function (b) {
    b.onclick = function () { dropLocal(b.getAttribute('data-dropdup')); };
  });
  bindPhotoButtons(el, function () { return null; });
  Array.prototype.forEach.call(el.querySelectorAll('[data-qty]'), function (b) {
    b.onclick = function () { editRecentQty(b.getAttribute('data-qty')); };
  });
  bindTimelineLinks(el);
  Array.prototype.forEach.call(el.querySelectorAll('[data-loc-edit]'), function (b) {
    b.onclick = function () { editRecentLocation(b.getAttribute('data-loc-edit')); };
  });
}

function refreshScanParts() { if (S.view === 'scan' || S.view === 'manual') { renderSync(); renderRecent(); } else refreshHeader(); }

// ---------- รับค่าสแกน ----------
// สแกนสินค้า → ขึ้นเป็น "รอบันทึก" (draft) ยังไม่บันทึก
// สแกนใหม่อีกครั้ง → แทนที่ draft เดิม (ครั้งแรกไม่ถูกบันทึก) / เลือก Location แล้วกดปุ่ม "บันทึก"
function handleScan(raw) {
  var chk = checkScan(raw);
  var text = chk.text;
  if (!text) return;

  var loc = asLocation(text);
  if (loc) {
    setLocation(loc);
    beep(true);
    setMsg('ok', '📍 Location: <b>' + esc(loc) + '</b>' + (S.draft ? ' — กด <b>บันทึก</b> เพื่อยืนยัน' : ''));
    return;
  }
  if (S.view !== 'scan') return;
  if (S.outMode) { outLookup(text, chk); return; }

  if (chk.error) {
    beep(false);
    setDraft(null);
    setMsg('err', '❌ ' + esc(chk.error) + '<br><span class="small">ค่าที่อ่านได้: ' + esc(text.slice(0, 120)) + '</span>');
    return;
  }

  var p = parseQr(text);
  var replaced = S.draft && S.draft.qr_raw !== p.qr_raw ? S.draft : null;
  setDraft({
    qr_raw: p.qr_raw, part_code: p.part_code, lot_no: p.lot_no, qty: p.qty, unit: p.unit, pkg_ref: p.pkg_ref,
    scanned_at: new Date().toISOString(), dupChecked: false, dup: null
  });
  checkDraftDup();
  var dup = draftDup(S.draft);
  if (dup) { beep(false); setMsg('err', dupMsg(dup)); return; }
  if (draftSamePkg(S.draft).length) { beep(false); setMsg('err', pkgDupMsg(draftSamePkg(S.draft))); return; }
  beep(true);
  setMsg('warn', (chk.fixed ? 'อ่านค่าซ้ำ 2 รอบในครั้งเดียว ระบบตัดให้เหลือ 1 แล้ว · ' : '') +
    (replaced ? 'แทนที่รายการก่อนหน้า (' + esc(replaced.part_code) + ') · ' : '') +
    (S.location ? 'ตรวจสอบแล้วกด <b>บันทึก</b>' : 'เลือก Location แล้วกด <b>บันทึก</b>'));
}

// โหมดสแกนต่อเนื่อง (กล้องเปิดค้าง): สแกน Location → ตั้งช่อง · สแกนกล่อง → บันทึกเข้าช่องปัจจุบันทันที (ไม่ต้องกดบันทึก)
// คืน { cls: ok | warn | err | loc, html } เพื่อแสดงในรายการใต้กล้อง
function camContinuous(raw) {
  var chk = checkScan(raw), text = chk.text;
  if (!text) return null;
  var loc = asLocation(text);
  if (loc) {
    setLocation(loc); beep(true);
    setMsg('ok', '📍 Location: <b>' + esc(loc) + '</b>');
    return { cls: 'loc', html: '📍 ตั้ง Location เป็น <b>' + esc(loc) + '</b>' };
  }
  if (chk.error) { beep(false); return { cls: 'err', html: '❌ ' + esc(chk.error) }; }
  if (!S.user) { beep(false); return { cls: 'err', html: '❌ ยังไม่ได้ใส่ชื่อผู้สแกน — ปิดกล้องแล้วใส่ชื่อก่อน' }; }
  if (!S.location) { beep(false); return { cls: 'err', html: '❌ ยังไม่ได้เลือก Location — <b>สแกน QR ของ Location ก่อน</b>' }; }
  var p = parseQr(text);
  var d = { qr_raw: p.qr_raw, part_code: p.part_code, lot_no: p.lot_no, qty: p.qty, unit: p.unit, pkg_ref: p.pkg_ref,
            scanned_at: new Date().toISOString(), dupChecked: false, dup: null };
  var dup = draftDup(d);
  if (dup) {
    beep(false);
    return { cls: 'err', html: '⚠ <b>' + esc(p.part_code || p.qr_raw) + '</b> ซ้ำ — บันทึกแล้วที่ <b>' + esc(dup.location) + '</b> ไม่ได้บันทึกซ้ำ' };
  }
  var sp = localSamePkg(d);
  if (sp.length) {
    beep(false);
    return { cls: 'err', html: '⚠ <b>' + esc(p.part_code) + '</b> Package ' + esc(p.pkg_ref) + ' มีอยู่แล้วที่ <b>' + sp.map(function (r) { return esc(r.location); }).join(', ') +
      '</b> — ไม่ได้บันทึก · ปิดกล้องแล้วสแกนแบบปกติเพื่อเลือก "แบ่งกล่อง" หรือ "แทนที่"' };
  }
  S.draft = d;
  saveDraft(); // บันทึก + ปี๊บ + ส่งขึ้นเซิร์ฟเวอร์เบื้องหลัง
  // เช็คกับชีตตามหลัง (ข้อมูลจากเครื่องอื่น) → ติดคำเตือนที่รายการ
  var saved = S.recent[0];
  if (PKG_RULE_ON && saved && saved.qr_raw === d.qr_raw && pkgKey(d.pkg_ref) && apiUrl()) {
    api('findSamePkg', d.part_code, d.lot_no, d.pkg_ref, d.qr_raw).then(function (list) {
      list = (list || []).filter(function (r) { return r.scan_id !== saved.scan_id; });
      if (!list.length) return;
      saved.pkgWarn = list.map(function (r) { return r.location; }); saveRecent(); refreshScanParts();
      beep(false); setMsg('err', '⚠ <b>' + esc(d.part_code) + '</b> Package ' + esc(d.pkg_ref) + ' มีอยู่แล้วที่ <b>' + esc(saved.pkgWarn.join(', ')) + '</b> (เครื่องอื่นสแกนไว้) — ตรวจว่าแบ่งกล่องหรือซ้ำ');
    }, function () {});
  }
  var b = bomInfo(p.part_code) || {};
  return { cls: p.qty === '' ? 'warn' : 'ok',
    html: '✔ <b>' + esc(p.part_code || p.qr_raw) + '</b>' + (b.name ? ' <span class="muted">' + esc(b.name) + '</span>' : '') +
      (p.qty !== '' ? ' × ' + esc(fmtQty(p.qty, p.unit)) : ' <span class="warn-text">(ไม่มียอด — แก้ทีหลังได้)</span>') +
      (p.lot_no ? ' · Lot ' + esc(p.lot_no) : '') + ' → <b>' + esc(S.location) + '</b>' };
}

// รหัส + Lot + Package เดียวกัน แต่ QR ต่างกัน (ป้ายใหม่หลังแบ่งกล่อง / สแกนกล่องเดิมซ้ำด้วยป้ายใหม่)
// กติกา Package ซ้ำ (เปิดใช้งาน) — false = ปิด
var PKG_RULE_ON = true;
function pkgKey(v) { return String(v == null ? '' : v).trim().toUpperCase().replace(/^0+(?=\w)/, ''); }
function samePkgOf(a, b) {
  return !!(a && b && pkgKey(a.pkg_ref) && String(a.part_code || '').toUpperCase() === String(b.part_code || '').toUpperCase() &&
    String(a.lot_no || '') === String(b.lot_no || '') && pkgKey(a.pkg_ref) === pkgKey(b.pkg_ref) && a.qr_raw !== b.qr_raw);
}
function localSamePkg(d) {
  if (!PKG_RULE_ON) return [];
  return S.recent.filter(function (r) { return (r.status === 'pending' || r.status === 'saved') && samePkgOf(r, d); });
}
// รวมผลในเครื่อง + ชีต (ไม่ซ้ำ scan_id · ตัดรายการที่ในเครื่องรู้ว่าถูกลบแล้ว)
function draftSamePkg(d) {
  if (!PKG_RULE_ON || !d || !pkgKey(d.pkg_ref)) return [];
  var out = localSamePkg(d), seen = {};
  out.forEach(function (r) { seen[r.scan_id] = 1; });
  (d.pkgDup || []).forEach(function (r) {
    if (seen[r.scan_id]) return;
    var loc = findRecent(r.scan_id); if (loc && (loc.status === 'deleted' || loc.status === 'out')) return;
    seen[r.scan_id] = 1; out.push(r);
  });
  return out;
}
function samePkgLine(r) {
  return '<span class="loc-pill">' + esc(r.location) + '</span> ' + (r.qty !== '' ? esc(fmtQty(r.qty, r.unit)) : '<span class="muted">ไม่มียอด</span>') +
    ' <span class="muted small">' + (r.status === 'pending' ? 'รอส่ง (เครื่องนี้)' : esc(r.scanned_by || '') + ' · ' + esc(String(r.scanned_at || '').replace('T', ' ').slice(0, 16))) + '</span>';
}
function findSavedDuplicate(qr) {
  return S.recent.filter(function (r) { return r.qr_raw === qr && (r.status === 'pending' || r.status === 'saved'); })[0];
}

function setDraft(d) {
  S.draft = d; storeJson('pda_draft', d);
  renderDraft();
}

function renderDraft() {
  var el = $('draft'); if (!el) return;
  var d = S.draft;
  if (!d) { el.innerHTML = ''; return; }
  var dup = draftDup(d), pkgList = dup ? [] : draftSamePkg(d);
  var checking = !d.dupChecked && !!apiUrl() && !dup;
  el.innerHTML = '<section class="draft-card' + (dup || (pkgList.length && !d.pkgChoice) ? ' bad' : '') + '">' +
    '<div class="draft-head"><span>สแกนแล้ว · ยังไม่บันทึก</span><button class="link" id="dCancel">ยกเลิก</button></div>' +
    '<div class="draft-part">' + esc(d.part_code || d.qr_raw) + '</div>' +
    itemLines(d, '<button class="qty-btn" id="dQty">' + (d.qty !== '' ? esc(fmtQty(d.qty, d.unit)) : 'ใส่ยอด') + ' ✏️</button>',
      S.location ? '<span class="loc-pill">' + esc(S.location) + '</span> <span class="muted small">(จะบันทึกที่นี่)</span>' : '<span class="muted">ยังไม่เลือก</span>') +
    (dup
      ? '<div class="dup-box">⚠ QR นี้บันทึกแล้วที่ <b>' + esc(dup.location) + '</b>' +
          '<div class="small">' + (dup.status === 'pending' ? 'รายการรอส่งในเครื่องนี้' : esc(dup.scanned_by || '') + (dup.scanned_at ? ' · ' + esc(String(dup.scanned_at).replace('T', ' ').slice(0, 16)) : '')) + '</div></div>' +
        '<div class="actions dup-actions">' +
          (!S.location ? '<button class="btn warn" id="dPickLoc">📍 เลือก Location เพื่อย้าย</button>'
            : dup.location !== S.location ? '<button class="btn warn" id="dMove">📍 ย้ายมาที่ ' + esc(S.location) + '</button>'
            : '<span class="muted small">อยู่ที่ Location นี้อยู่แล้ว</span>') +
          '<button class="btn" id="dCancel2">ยกเลิก</button>' +
        '</div>'
      : (pkgList.length && !d.pkgChoice)
        ? '<div class="dup-box pkg-box">⚠ <b>Package นี้มีอยู่แล้ว</b> (รหัส + Lot + Package เดียวกัน แต่ป้ายคนละใบ)' +
            '<div class="pkg-list">' + pkgList.map(function (r) { return '<div>' + samePkgLine(r) + '</div>'; }).join('') + '</div>' +
            '<div class="small muted">ป้ายนี้: ' + (d.qty !== '' ? esc(fmtQty(d.qty, d.unit)) : 'ไม่มียอด') + ' · Package ' + esc(d.pkg_ref) + '</div></div>' +
          '<div class="actions pkg-actions">' +
            '<button class="btn" id="dSplit">✂ แบ่งกล่อง / คนละกล่อง — บันทึกเพิ่ม</button>' +
            (pkgList.length === 1 ? '<button class="btn warn" id="dReplace">🔁 กล่องเดิม ป้ายใหม่ — แทนที่รายการที่ ' + esc(pkgList[0].location) + '</button>' : '') +
            '<button class="btn" id="dCancel3">ยกเลิก</button></div>'
      : (S.location
        ? '<button class="btn primary save-btn" id="dSave">💾 บันทึก → ' + esc(S.location) + '</button>'
        : '<button class="btn warn save-btn" id="dPickLoc">📍 เลือก Location ก่อนบันทึก</button>') +
        (checking ? '<div class="muted small center">กำลังตรวจซ้ำกับระบบ…</div>' : '')) +
  '</section>';
  $('dCancel').onclick = function () { setDraft(null); setMsg('idle', 'ยกเลิกแล้ว — สแกนรายการใหม่ได้เลย'); focusScan(); };
  if ($('dCancel2')) $('dCancel2').onclick = $('dCancel').onclick;
  if ($('dMove')) $('dMove').onclick = moveDraftDup;
  if ($('dSave')) $('dSave').onclick = saveDraft;
  if ($('dCancel3')) $('dCancel3').onclick = $('dCancel').onclick;
  if ($('dSplit')) $('dSplit').onclick = function () {
    if (!S.location) { openLocationPicker(); return; }
    S.draft.pkgChoice = 'split'; S.draft.pkgNote = 'คนละกล่อง/แบ่งกล่อง: Package เดียวกันอยู่ที่ ' + pkgList.map(function (r) { return r.location; }).join(', ');
    saveDraft();
  };
  if ($('dReplace')) $('dReplace').onclick = function () { replaceSamePkg(pkgList[0]); };
  $('dQty').onclick = editDraftQty;
  if ($('dPickLoc')) $('dPickLoc').onclick = openLocationPicker;
}

function saveDraft() {
  var d = S.draft; if (!d) return;
  if (!S.user) { beep(false); setMsg('err', 'กรุณาใส่ชื่อผู้สแกนก่อน'); openUserModal(); return; }
  if (!S.location) { beep(false); openLocationPicker(); return; }
  var dup = draftDup(d);
  if (dup) { beep(false); setMsg('err', dupMsg(dup)); return; }
  if (!d.pkgChoice && draftSamePkg(d).length) { beep(false); setMsg('err', pkgDupMsg(draftSamePkg(d))); renderDraft(); return; }
  var item = {
    scan_id: uid(), scanned_at: d.scanned_at || new Date().toISOString(), location: S.location,
    qr_raw: d.qr_raw, part_code: d.part_code, lot_no: d.lot_no, qty: d.qty, unit: d.unit, pkg_ref: d.pkg_ref,
    scanned_by: S.user, device: S.device, status: 'pending', note: d.pkgNote || ''
  };
  S.recent.unshift(item);
  saveRecent();
  setDraft(null);
  beep(true);
  setMsg('ok', '✔ บันทึก <b>' + esc(item.part_code) + '</b>' + (item.qty !== '' ? ' × ' + esc(fmtQty(item.qty, item.unit)) : '') +
    ' → <b>' + esc(item.location) + '</b>', item.scan_id);
  refreshScanParts();
  flush();
  focusScan();
}

// กล่องเดิม ป้ายใหม่: ลบรายการเดิม (เหตุผลระบุชัด) แล้วบันทึกป้ายใหม่เข้าช่องปัจจุบัน
function replaceSamePkg(old) {
  if (!S.user) { openUserModal(); return; }
  if (!S.location) { openLocationPicker(); return; }
  var d = S.draft; if (!d || !old) return;
  var note = 'แทนป้ายเดิมที่ ' + old.location + (old.qty !== '' ? ' (' + fmtQty(old.qty, old.unit) + ')' : '');
  function done() { if (!S.draft) return; S.draft.pkgChoice = 'replace'; S.draft.pkgNote = note; saveDraft(); }
  if (old.status === 'pending') {
    if (S.syncing) { toast('กำลังส่งข้อมูล รอสักครู่แล้วลองใหม่'); return; }
    S.recent = S.recent.filter(function (x) { return x.scan_id !== old.scan_id; }); saveRecent(); done(); return;
  }
  confirmModal('แทนที่รายการเดิม?', 'ลบ <b>' + esc(old.part_code) + '</b> Package ' + esc(old.pkg_ref) + ' ที่ <b>' + esc(old.location) + '</b>' +
    (old.qty !== '' ? ' (' + esc(fmtQty(old.qty, old.unit)) + ')' : '') + '<br>แล้วบันทึกป้ายใหม่ ' + (d.qty !== '' ? esc(fmtQty(d.qty, d.unit)) : '') + ' → <b>' + esc(S.location) + '</b>',
    'แทนที่', function () {
      return api('deleteScan', old.scan_id, S.user, 'ป้ายใหม่แทน (กล่องเดิม) → ' + S.location).then(function () {
        var r = findRecent(old.scan_id); if (r) { r.status = 'deleted'; saveRecent(); }
        done();
      }, function (err) { toast('ลบรายการเดิมไม่ได้: ' + err.message, 3500); });
    });
}

function setLocation(loc) {
  S.location = loc; store('pda_loc', loc);
  renderLoc(); renderDraft(); renderManualLoc();
}

// ---------- ส่งขึ้นเซิร์ฟเวอร์ ----------
function flush(manual) {
  if (S.syncing) return;
  var pending = S.recent.filter(function (r) { return r.status === 'pending'; });
  if (!pending.length) return;
  if (!apiUrl()) { if (manual) toast('ยังไม่ได้ตั้งค่า API URL (กด ⚙)'); return; }
  var batch = pending.slice(-SYNC_BATCH).reverse(); // เก่าสุดก่อน
  S.syncing = true; renderSync();
  var payload = batch.map(function (r) {
    return { scan_id: r.scan_id, scanned_at: r.scanned_at, location: r.location, qr_raw: r.qr_raw, part_code: r.part_code,
      lot_no: r.lot_no, qty: r.qty, unit: r.unit, pkg_ref: r.pkg_ref, scanned_by: r.scanned_by, device: r.device, note: r.note || '' };
  });
  api('saveScans', payload).then(function (results) {
    S.online = true;
    var dupCount = 0;
    results.forEach(function (res) {
      var r = findRecent(res.scan_id); if (!r) return;
      if (res.result === 'saved' || res.result === 'exists') { r.status = 'saved'; delete r.error; }
      else if (res.result === 'duplicate') { r.status = 'duplicate'; r.existing = res.existing; dupCount++; }
      else { r.status = 'error'; r.error = res.error || 'บันทึกไม่ได้'; dupCount++; }
    });
    if (dupCount) {
      beep(false);
      setMsg('err', '⚠ มี ' + dupCount + ' รายการที่บันทึกไม่ได้ (QR ซ้ำในระบบ) — ดูในรายการด้านล่าง');
    }
    S.syncing = false; saveRecent(); refreshScanParts();
    if (S.recent.some(function (r) { return r.status === 'pending'; })) setTimeout(flush, 200);
    else flushPhotos();
  }, function (err) {
    S.syncing = false;
    if (err.network) S.online = false;
    else setMsg('err', 'ส่งข้อมูลไม่สำเร็จ: ' + esc(err.message));
    if (manual) toast(err.message);
    refreshScanParts();
  });
}

function findRecent(id) { return S.recent.filter(function (r) { return r.scan_id === id; })[0]; }

// ---------- แก้ยอด ----------
// ก่อนบันทึก (draft / รอส่ง) แก้ในเครื่องได้เลย · หลังบันทึก ส่งไปเซิร์ฟเวอร์พร้อมเหตุผล (เก็บยอดเดิมไว้ตรวจสอบ)
var QTY_REASONS = ['นับจริงไม่ตรงป้าย', 'ป้ายพิมพ์ยอดผิด', 'เบิก/แบ่งออกไปบางส่วน', 'อื่นๆ'];

function qtyChip(r, editable, attr) {
  var label = r.qty !== '' && r.qty != null ? esc(fmtQty(r.qty, r.unit)) : (editable ? '+ ใส่ยอด' : '');
  var edited = r.edited_by && r.qty_original !== '' && r.qty_original != null
    ? '<span class="muted small">(เดิม ' + esc(fmtQty(r.qty_original, r.unit)) + ')</span>' : '';
  if (!label) return edited;
  return (editable ? '<button class="qty-btn small" ' + attr + '="' + esc(r.scan_id) + '">' + label + ' ✏️</button>' : '<span>' + label + '</span>') + edited;
}

function parseQtyInput(v) {
  var s = String(v || '').replace(/,/g, '').trim();
  if (s === '' || isNaN(Number(s)) || Number(s) < 0) return null;
  return Number(s);
}

// opts: { rec, needReason, onSave(qty, note) → Promise|void }
function openQtyModal(opts) {
  var rec = opts.rec;
  var cur = rec.qty !== '' && rec.qty != null ? String(rec.qty) : '';
  openModal('<h3>แก้ยอด</h3>' +
    '<div class="card-lite"><b>' + esc(rec.part_code || rec.qr_raw) + '</b>' +
      (rec.lot_no ? '<br>Lot ' + esc(rec.lot_no) : '') +
      (rec.location ? '<br>Location <b>' + esc(rec.location) + '</b>' : '') +
      (cur !== '' ? '<br><span class="muted">ยอดปัจจุบัน ' + esc(fmtQty(rec.qty, rec.unit)) + '</span>' : '') + '</div>' +
    '<label>ยอดใหม่' + (rec.unit ? ' (' + esc(rec.unit) + ')' : '') + '</label>' +
    '<div class="qty-edit"><button class="btn" id="qMinus">−</button>' +
      '<input id="qIn" class="field big" inputmode="decimal" autocomplete="off" value="' + esc(cur) + '">' +
      '<button class="btn" id="qPlus">+</button></div>' +
    (opts.needReason
      ? '<label>เหตุผล</label><div class="reasons">' +
        QTY_REASONS.map(function (x, i) { return '<label class="radio"><input type="radio" name="qreason" value="' + esc(x) + '"' + (i === 0 ? ' checked' : '') + '> ' + esc(x) + '</label>'; }).join('') +
        '</div><input id="qOther" class="field hidden" placeholder="ระบุเหตุผล">' +
        '<p class="muted small">ระบบเก็บยอดเดิม ผู้แก้ไข และเวลาไว้ในชีตเพื่อตรวจสอบย้อนหลัง</p>'
      : '') +
    '<div class="actions"><button class="btn" id="mCancel">ยกเลิก</button><button class="btn primary" id="mOk">บันทึกยอด</button></div>');
  var inp = $('qIn');
  setTimeout(function () { inp.focus(); inp.select(); }, 50);
  function step(d) { var n = parseQtyInput(inp.value) || 0; inp.value = String(Math.max(0, Math.round((n + d) * 1000) / 1000)); }
  $('qMinus').onclick = function () { step(-1); };
  $('qPlus').onclick = function () { step(1); };
  inp.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); $('mOk').click(); } });
  Array.prototype.forEach.call(document.querySelectorAll('input[name=qreason]'), function (x) {
    x.onchange = function () { $('qOther').classList.toggle('hidden', x.value !== 'อื่นๆ' || !x.checked); };
  });
  $('mCancel').onclick = closeModal;
  $('mOk').onclick = function () {
    var q = parseQtyInput(inp.value);
    if (q === null) { toast('กรุณาใส่ยอดเป็นตัวเลข'); inp.focus(); return; }
    var note = '';
    if (opts.needReason) {
      note = document.querySelector('input[name=qreason]:checked').value;
      if (note === 'อื่นๆ') { note = $('qOther').value.trim(); if (!note) { toast('กรุณาระบุเหตุผล'); return; } }
    }
    if (cur !== '' && q === Number(cur)) { closeModal(); return; }
    var btn = $('mOk');
    var p = opts.onSave(q, note);
    if (!p || !p.then) { closeModal(); return; }
    btn.disabled = true; btn.textContent = 'กำลังบันทึก…';
    p.then(function () { closeModal(); toast('แก้ยอดแล้ว'); },
      function (err) { btn.disabled = false; btn.textContent = 'บันทึกยอด'; toast(err.message, 3500); });
  };
}

function unitFor(q, u) { return u || (Math.floor(q) === q ? 'EA' : 'kg'); }

function editDraftQty() {
  var d = S.draft; if (!d) return;
  openQtyModal({ rec: d, onSave: function (q) {
    d.qty = q; d.unit = unitFor(q, d.unit); setDraft(d);
    setMsg('warn', 'แก้ยอดเป็น <b>' + esc(fmtQty(q, d.unit)) + '</b> แล้ว — กด <b>บันทึก</b> เพื่อยืนยัน');
  } });
}

function applyServerQty(rec) {
  var r = findRecent(rec.scan_id);
  if (r) { r.qty = rec.qty; r.unit = rec.unit; r.qty_original = rec.qty_original; r.edited_by = rec.edited_by; r.edited_at = rec.edited_at; saveRecent(); }
  var rows = S.hist.data && S.hist.data.rows;
  if (rows) rows.forEach(function (x) { if (x.scan_id === rec.scan_id) Object.assign(x, rec, { photos: x.photos }); });
}

function editRecentQty(id) {
  var r = findRecent(id); if (!r) return;
  if (r.status === 'pending') {
    if (S.syncing) { toast('กำลังส่งข้อมูล รอสักครู่แล้วลองใหม่'); return; }
    openQtyModal({ rec: r, onSave: function (q) {
      if (r.status !== 'pending') { toast('รายการนี้ส่งไปแล้ว กรุณาแก้อีกครั้ง'); return; }
      r.qty = q; r.unit = unitFor(q, r.unit); saveRecent(); refreshScanParts();
    } });
    return;
  }
  if (r.status !== 'saved') return;
  if (!S.user) { openUserModal(); return; }
  openQtyModal({ rec: r, needReason: true, onSave: function (q, note) {
    return api('updateQty', r.scan_id, q, S.user, note).then(function (rec) { applyServerQty(rec); refreshScanParts(); });
  } });
}

function editHistoryQty(row) {
  if (!row || row.status === 'deleted' || row.status === 'out') return;
  if (!S.user) { openUserModal(); return; }
  openQtyModal({ rec: row, needReason: true, onSave: function (q, note) {
    return api('updateQty', row.scan_id, q, S.user, note).then(function (rec) { applyServerQty(rec); renderHistoryList(); });
  } });
}

// ---------- ย้าย Location หลังบันทึก ----------
// ยังไม่ส่ง (รอส่ง) → เปลี่ยนในเครื่องได้เลย · บันทึกแล้ว → ส่งไปเซิร์ฟเวอร์พร้อมเหตุผล (เก็บ Location แรกไว้ตรวจสอบ)
var LOC_REASONS = ['สแกนผิด Location', 'ย้ายของไปที่ใหม่', 'อื่นๆ'];

function locChip(r, editable, attr) {
  var moved = r.location_original && r.location_original !== r.location
    ? '<span class="muted small">(เดิม ' + esc(r.location_original) + ')</span>' : '';
  if (!editable) return '<span class="loc-pill">' + esc(r.location) + '</span>' + moved;
  return '<button class="loc-pill loc-edit" ' + attr + '="' + esc(r.scan_id) + '">' + esc(r.location) + ' ✏️</button>' + moved;
}

function confirmMoveModal(rec, newLoc, onSave) {
  openModal('<h3>ย้าย Location</h3>' +
    '<div class="card-lite"><b>' + esc(rec.part_code || rec.qr_raw) + '</b>' + (rec.qty !== '' ? ' · ' + esc(fmtQty(rec.qty, rec.unit)) : '') +
      '<div class="move-line"><span class="loc-pill">' + esc(rec.location) + '</span> → <span class="loc-pill new">' + esc(newLoc) + '</span></div></div>' +
    '<label>เหตุผล</label><div class="reasons">' +
      LOC_REASONS.map(function (x, i) { return '<label class="radio"><input type="radio" name="lreason" value="' + esc(x) + '"' + (i === 0 ? ' checked' : '') + '> ' + esc(x) + '</label>'; }).join('') +
    '</div><input id="lOther" class="field hidden" placeholder="ระบุเหตุผล">' +
    '<p class="muted small">ระบบเก็บ Location เดิม ผู้แก้ไข และเวลาไว้ในชีตเพื่อตรวจสอบย้อนหลัง</p>' +
    '<div class="actions"><button class="btn" id="mCancel">ยกเลิก</button><button class="btn primary" id="mOk">ยืนยันย้าย</button></div>');
  Array.prototype.forEach.call(document.querySelectorAll('input[name=lreason]'), function (x) {
    x.onchange = function () { $('lOther').classList.toggle('hidden', x.value !== 'อื่นๆ' || !x.checked); };
  });
  $('mCancel').onclick = closeModal;
  $('mOk').onclick = function () {
    var note = document.querySelector('input[name=lreason]:checked').value;
    if (note === 'อื่นๆ') { note = $('lOther').value.trim(); if (!note) { toast('กรุณาระบุเหตุผล'); return; } }
    var btn = $('mOk'); btn.disabled = true; btn.textContent = 'กำลังบันทึก…';
    onSave(note).then(function () { closeModal(); toast('ย้าย Location แล้ว'); },
      function (err) { btn.disabled = false; btn.textContent = 'ยืนยันย้าย'; toast(err.message, 3500); });
  };
}

function applyServerLocation(rec) {
  var r = findRecent(rec.scan_id);
  if (r) { r.location = rec.location; r.location_original = rec.location_original; r.edited_by = rec.edited_by; r.edited_at = rec.edited_at; saveRecent(); }
  var rows = S.hist.data && S.hist.data.rows;
  if (rows) rows.forEach(function (x) { if (x.scan_id === rec.scan_id) Object.assign(x, rec, { photos: x.photos }); });
}

function pickNewLocation(rec, then) {
  openLocationPicker({ current: rec.location, title: 'ย้าย ' + (rec.part_code || '') + ' ไป Location ใหม่', onPick: function (code) {
    if (code === rec.location) { toast('เป็น Location เดิม'); return; }
    then(code);
  } });
}

function editRecentLocation(id) {
  var r = findRecent(id); if (!r) return;
  if (r.status === 'pending') {
    if (S.syncing) { toast('กำลังส่งข้อมูล รอสักครู่แล้วลองใหม่'); return; }
    pickNewLocation(r, function (code) {
      if (r.status !== 'pending') { toast('รายการนี้ส่งไปแล้ว กรุณาแก้อีกครั้ง'); return; }
      r.location = code; saveRecent(); refreshScanParts(); toast('เปลี่ยนเป็น ' + code + ' แล้ว');
    });
    return;
  }
  if (r.status !== 'saved') return;
  if (!S.user) { openUserModal(); return; }
  pickNewLocation(r, function (code) {
    confirmMoveModal(r, code, function (note) {
      return api('updateLocation', r.scan_id, code, S.user, note).then(function (rec) { applyServerLocation(rec); refreshScanParts(); });
    });
  });
}

function editHistoryLocation(row) {
  if (!row || row.status === 'deleted' || row.status === 'out') return;
  if (!S.user) { openUserModal(); return; }
  pickNewLocation(row, function (code) {
    confirmMoveModal(row, code, function (note) {
      return api('updateLocation', row.scan_id, code, S.user, note).then(function (rec) { applyServerLocation(rec); renderHistoryList(); });
    });
  });
}

// ---------- ตรวจซ้ำกับ cloud + ซิงก์รายการในเครื่อง ----------
// หน้าสแกนเก็บรายการล่าสุดไว้ในเครื่อง แต่สถานะจริงอยู่ในชีต: เครื่องอื่นอาจลบ/ย้าย/แก้ยอดไปแล้ว
// → ตรวจ QR กับชีตทันทีหลังสแกน และดึงสถานะล่าสุดของรายการในเครื่องเป็นระยะ

// รายการซ้ำของ draft: รายการ "รอส่ง" ในเครื่องมาก่อน (ยังไม่ถึงชีต) → ผลจากชีต → (ยังไม่ได้เช็ค) รายการในเครื่อง
function draftDup(d) {
  if (!d) return null;
  var localPending = S.recent.filter(function (r) { return r.qr_raw === d.qr_raw && r.status === 'pending'; })[0];
  if (localPending) return localPending;
  if (d.dupChecked) return d.dup || null;
  return findSavedDuplicate(d.qr_raw) || null;
}

function pkgDupMsg(list) {
  return '⚠ Package นี้ (รหัส + Lot + Package เดียวกัน) มีอยู่แล้วที่ <b>' + list.map(function (r) { return esc(r.location); }).join(', ') +
    '</b> — แบ่งกล่อง หรือ สแกนกล่องเดิมซ้ำ? เลือกด้านล่าง';
}
function dupMsg(dup) {
  return '⚠ QR นี้บันทึกแล้วที่ <b>' + esc(dup.location) + '</b>' +
    (dup.scanned_by ? ' โดย ' + esc(dup.scanned_by) : '') +
    (S.location && dup.location !== S.location ? ' — กด <b>ย้ายมาที่ ' + esc(S.location) + '</b> หรือ <b>ยกเลิก</b>' : ' — กด <b>ยกเลิก</b>');
}

var SYNC_FIELDS = ['location', 'location_original', 'qty', 'unit', 'qty_original', 'part_code', 'lot_no', 'pkg_ref',
                   'edited_by', 'edited_at', 'deleted_by', 'deleted_at', 'delete_reason', 'out_by', 'out_at', 'out_reason', 'out_qty'];

// อัปเดตรายการในเครื่องจากข้อมูลในชีต — คืน true ถ้ามีอะไรเปลี่ยน
function upsertRecent(rec, addIfMissing) {
  if (!rec || !rec.scan_id) return false;
  var st = rec.status === 'deleted' || rec.status === 'out' ? rec.status : 'saved';
  var r = findRecent(rec.scan_id);
  if (!r) {
    if (!addIfMissing) return false;
    var item = { status: st, photos: (rec.photos || []).slice() };
    ['scan_id', 'scanned_at', 'qr_raw', 'scanned_by', 'device'].concat(SYNC_FIELDS).forEach(function (k) { item[k] = rec[k] == null ? '' : rec[k]; });
    S.recent.unshift(item);
    return true;
  }
  if (r.status !== 'saved' && r.status !== 'deleted' && r.status !== 'out') return false; // รอส่ง/ซ้ำ/ผิดพลาด = สถานะของเครื่อง
  var changed = r.status !== st;
  r.status = st;
  SYNC_FIELDS.forEach(function (k) {
    if (rec[k] === undefined) return;
    if (String(r[k] == null ? '' : r[k]) !== String(rec[k])) { r[k] = rec[k]; changed = true; }
  });
  return changed;
}

function syncRecent() {
  if (S.recentSyncing || !apiUrl()) return;
  var ids = S.recent.filter(function (r) { return r.status === 'saved'; }).map(function (r) { return r.scan_id; }).slice(0, 300);
  if (!ids.length) return;
  S.recentSyncing = true;
  api('getScans', ids).then(function (list) {
    S.online = true; S.recentSyncing = false;
    var changed = false;
    list.forEach(function (rec) { if (upsertRecent(rec, false)) changed = true; });
    if (changed) { saveRecent(); refreshScanParts(); renderDraft(); }
  }, function (err) { S.recentSyncing = false; if (err.network) S.online = false; });
}

function checkDraftDup() {
  var d = S.draft; if (!d || !apiUrl()) return;
  var qr = d.qr_raw;
  if (PKG_RULE_ON && pkgKey(d.pkg_ref)) {
    var before = draftSamePkg(d).length;
    api('findSamePkg', d.part_code, d.lot_no, d.pkg_ref, qr).then(function (list) {
      if (!S.draft || S.draft.qr_raw !== qr) return;
      S.draft.pkgDup = list || []; S.draft.pkgChecked = true; storeJson('pda_draft', S.draft);
      renderDraft();
      var now = draftSamePkg(S.draft);
      if (now.length > before && !draftDup(S.draft) && !S.draft.pkgChoice) { beep(false); setMsg('err', pkgDupMsg(now)); }
    }, function () {});
  }
  api('findByQr', qr).then(function (rec) {
    S.online = true;
    var shown = S.draft && S.draft.qr_raw === qr ? draftDup(S.draft) : null;
    var shownLoc = shown ? shown.location : null; // ค่าที่แสดงไปก่อนเช็ค (ก่อนอัปเดตข้อมูลในเครื่อง)
    if (rec && upsertRecent(rec, false)) saveRecent();
    // รายการในเครื่องที่ชีตบอกว่าไม่ได้ใช้งานแล้ว (ถูกลบ/แทนที่) → ซิงก์ใหม่
    if (S.recent.some(function (r) { return r.qr_raw === qr && r.status === 'saved' && (!rec || r.scan_id !== rec.scan_id); })) syncRecent();
    if (!S.draft || S.draft.qr_raw !== qr) return;
    S.draft.dupChecked = true; S.draft.dup = rec || null; storeJson('pda_draft', S.draft);
    var after = draftDup(S.draft);
    renderDraft(); refreshScanParts();
    if (after && after.location !== shownLoc) { beep(false); setMsg('err', dupMsg(after)); }
    else if (!after && shownLoc) { beep(true); setMsg('warn', 'ตรวจกับระบบแล้ว ไม่ซ้ำ — กด <b>บันทึก</b>'); }
  }, function (err) { if (err.network) S.online = false; });
}

// ย้ายรายการเดิม (ที่ซ้ำ) มาที่ Location ปัจจุบัน — แก้ Location ของรายการเดิม ไม่สร้างรายการใหม่
function moveDraftDup() {
  var d = S.draft, dup = draftDup(d), target = S.location;
  if (!d || !dup || !target) return;
  if (!S.user) { openUserModal(); return; }
  if (dup.status === 'pending') {
    if (S.syncing) { toast('กำลังส่งข้อมูล รอสักครู่แล้วลองใหม่'); return; }
    dup.location = target; saveRecent(); setDraft(null);
    setMsg('ok', '✔ ย้าย <b>' + esc(dup.part_code) + '</b> → <b>' + esc(target) + '</b>');
    refreshScanParts(); focusScan();
    return;
  }
  confirmMoveModal(dup, target, function (note) {
    return api('updateLocation', dup.scan_id, target, S.user, note).then(function (rec) {
      upsertRecent(rec, true); applyServerLocation(rec); saveRecent();
      setDraft(null);
      beep(true);
      setMsg('ok', '✔ ย้าย <b>' + esc(rec.part_code) + '</b> จาก ' + esc(dup.location) + ' → <b>' + esc(rec.location) + '</b>', rec.scan_id);
      refreshScanParts();
    });
  });
}

// รายการที่เซิร์ฟเวอร์ตอบว่าซ้ำหลังส่ง (เช่น ส่งตอนออฟไลน์) → ย้ายรายการเดิม / ยกเลิก
function moveDuplicate(id) {
  var r = findRecent(id); if (!r || !r.existing) return;
  if (!S.user) { openUserModal(); return; }
  confirmMoveModal(r.existing, r.location, function (note) {
    return api('updateLocation', r.existing.scan_id, r.location, S.user, note).then(function (rec) {
      upsertRecent(rec, true); applyServerLocation(rec);
      var keep = findRecent(rec.scan_id);
      // ย้ายรูปที่แนบกับรายการซ้ำไปไว้กับรายการเดิม
      (r.photos || []).forEach(function (pid) { if (keep && keep.photos.indexOf(pid) < 0) keep.photos.push(pid); });
      S.photoQueue.forEach(function (q) { if (q.scan_id === r.scan_id) q.scan_id = rec.scan_id; });
      storeJson('pda_photo_queue', S.photoQueue);
      S.recent = S.recent.filter(function (x) { return x.scan_id !== r.scan_id; });
      saveRecent(); refreshScanParts(); flushPhotos();
    });
  });
}

function dropLocal(id) {
  S.recent = S.recent.filter(function (x) { return x.scan_id !== id; });
  S.photoQueue.filter(function (q) { return q.scan_id === id; }).forEach(function (q) { PhotoStore.del(q.photo_id); });
  S.photoQueue = S.photoQueue.filter(function (q) { return q.scan_id !== id; });
  storeJson('pda_photo_queue', S.photoQueue);
  saveRecent(); refreshScanParts(); toast('ยกเลิกแล้ว');
}

// ---------- ลบ ----------
// ======================= เอาออกจาก Location =======================
// ต่างจาก "ลบ" (บันทึกผิด): เอาออก = ของออกจากช่องจริง (เบิกไปผลิต / ย้ายไปคลังอื่น) · เอาออกบางส่วนได้ (ลดยอด กล่องยังอยู่)
var OUT_REASONS = ['เบิกไปผลิต', 'ย้ายไปคลังอื่น', 'ส่งคืน Supplier', 'ของเสีย / Scrap', 'อื่นๆ'];

function outLookup(text, chk) {
  if (chk && chk.error) { beep(false); setMsg('err', '❌ ' + esc(chk.error)); return; }
  var p = parseQr(text);
  var pend = S.recent.filter(function (r) { return r.status === 'pending' && r.qr_raw === p.qr_raw; })[0];
  if (pend) { beep(false); setMsg('err', 'กล่องนี้ยัง "รอส่ง" อยู่ในเครื่อง — รอให้ส่งขึ้นระบบก่อน แล้วสแกนเอาออกอีกครั้ง'); return; }
  setMsg('idle', '🔎 กำลังหากล่อง ' + esc(p.part_code || p.qr_raw) + '…');
  api('findByQr', p.qr_raw).then(function (rec) {
    if (!rec) { beep(false); setMsg('err', '❌ ไม่พบกล่องนี้ใน Location ใดเลย (ยังไม่ได้เก็บเข้า หรือเอาออก/ลบไปแล้ว)<br><span class="small">' + esc(p.part_code || p.qr_raw) + (p.lot_no ? ' · Lot ' + esc(p.lot_no) : '') + '</span>'); return; }
    beep(true);
    setMsg('warn', 'พบที่ <b>' + esc(rec.location) + '</b> — ยืนยันการเอาออก');
    openOutModal(rec, function (res) {
      setMsg('ok', (res.partial ? '📤 เอาออกบางส่วนแล้ว · เหลือ <b>' + esc(fmtQty(res.qty, res.unit)) + '</b>' : '📤 เอาออกแล้ว') + ' — ' + esc(res.part_code) + ' จาก <b>' + esc(res.location) + '</b>');
    });
  }, function (err) { beep(false); setMsg('err', 'ค้นหาไม่ได้: ' + esc(err.message)); });
}

function openOutModal(rec, onDone) {
  if (!S.user) { openUserModal(); return; }
  var hasQty = rec.qty !== '' && rec.qty != null;
  openModal('<h3>📤 เอาออกจาก <span class="loc-pill">' + esc(rec.location) + '</span></h3>' +
    '<div class="card-lite"><b>' + esc(rec.part_code || rec.qr_raw) + '</b>' + itemLines(rec) + '</div>' +
    (hasQty ? '<label>จำนวนที่เอาออก <span class="muted small">(ในกล่องมี ' + esc(fmtQty(rec.qty, rec.unit)) + ')</span></label>' +
      '<div class="out-qty"><input id="oQty" class="field big" type="number" inputmode="decimal" min="0" step="any" value="' + esc(rec.qty) + '">' +
      '<button type="button" class="btn" id="oAll">ทั้งหมด</button></div>' +
      '<p class="muted small" id="oHint">เอาออกทั้งกล่อง — กล่องจะหายจาก Location นี้</p>' : '<p class="muted small">กล่องนี้ไม่มียอด — เอาออกทั้งกล่อง</p>') +
    '<label>เหตุผล</label>' + OUT_REASONS.map(function (x, i) {
      return '<label class="radio"><input type="radio" name="oWhy" value="' + esc(x) + '"' + (i === 0 ? ' checked' : '') + '> ' + esc(x) + '</label>';
    }).join('') +
    '<input id="oNote" class="field" placeholder="รายละเอียด เช่น เลข MO / ปลายทาง (ถ้ามี)">' +
    '<div class="actions"><button class="btn" id="mCancel">ยกเลิก</button><button class="btn warn" id="mOk">📤 ยืนยันเอาออก</button></div>');
  $('mCancel').onclick = closeModal;
  function readQty() {
    if (!hasQty) return { full: true, q: '' };
    var q = parseQtyInput($('oQty').value);
    return { q: q, full: q != null && q >= Number(rec.qty) - 1e-9 };
  }
  if (hasQty) {
    var hint = function () {
      var r = readQty();
      $('oHint').textContent = r.q == null || r.q <= 0 ? 'ใส่จำนวนที่เอาออก' : r.q > Number(rec.qty) + 1e-9 ? 'เกินยอดในกล่อง (' + fmtQty(rec.qty, rec.unit) + ')'
        : r.full ? 'เอาออกทั้งกล่อง — กล่องจะหายจาก Location นี้' : 'เอาออกบางส่วน — กล่องยังอยู่ เหลือ ' + fmtQty(Math.round((Number(rec.qty) - r.q) * 1000) / 1000, rec.unit);
    };
    $('oQty').addEventListener('input', hint);
    $('oAll').onclick = function () { $('oQty').value = rec.qty; hint(); };
  }
  $('mOk').onclick = function () {
    var r = readQty();
    if (hasQty && (r.q == null || r.q <= 0 || r.q > Number(rec.qty) + 1e-9)) { toast('จำนวนไม่ถูกต้อง'); $('oQty').focus(); return; }
    var c = document.querySelector('input[name="oWhy"]:checked');
    var why = [c ? c.value : '', $('oNote').value.trim()].filter(String).join(': ');
    var btn = $('mOk'); btn.disabled = true; btn.textContent = 'กำลังบันทึก…';
    api('outScan', rec.scan_id, S.user, { qty: r.full ? '' : r.q, reason: why }).then(function (res) {
      beep(true);
      upsertRecent(res, false); saveRecent();
      MAP.data = null; // ผังต้องโหลดใหม่
      closeModal();
      toast(res.partial ? '📤 เอาออก ' + fmtQty(r.q, rec.unit) + ' · เหลือ ' + fmtQty(res.qty, res.unit) : '📤 เอาออกจาก ' + res.location + ' แล้ว', 3000);
      if (onDone) onDone(res);
      refreshScanParts();
    }, function (err) { beep(false); btn.disabled = false; btn.textContent = '📤 ยืนยันเอาออก'; toast(err.message, 3500); });
  };
}

function deleteRecent(id) {
  var r = findRecent(id); if (!r) return;
  if (r.status === 'saved') {
    openDeleteModal(r, function () { r.status = 'deleted'; saveRecent(); refreshScanParts(); });
    return;
  }
  if (r.status === 'pending' && S.syncing) { toast('กำลังส่งข้อมูล รอสักครู่แล้วลองใหม่'); return; }
  // รายการที่ยังไม่ถึงเซิร์ฟเวอร์ (รอส่ง / ซ้ำ / ผิดพลาด) — ลบจากเครื่องได้เลย
  confirmModal('ลบรายการนี้ออกจากเครื่อง?', esc(r.part_code || r.qr_raw) + ' @ ' + esc(r.location) +
    '<br><span class="muted">รายการนี้ยังไม่ได้บันทึกในระบบ</span>', 'ลบออก', function () {
    S.recent = S.recent.filter(function (x) { return x.scan_id !== id; });
    S.photoQueue.filter(function (q) { return q.scan_id === id; }).forEach(function (q) { PhotoStore.del(q.photo_id); });
    S.photoQueue = S.photoQueue.filter(function (q) { return q.scan_id !== id; });
    storeJson('pda_photo_queue', S.photoQueue);
    saveRecent(); refreshScanParts(); toast('ลบออกแล้ว');
  });
}

var DELETE_REASONS = ['สแกนผิด Location', 'สแกนซ้ำ', 'สแกนผิดสินค้า', 'อื่นๆ'];

function openDeleteModal(rec, onDone) {
  if (!S.user) { openUserModal(); return; }
  openModal(
    '<h3>ลบรายการที่บันทึกแล้ว</h3>' +
    '<div class="card-lite"><b>' + esc(rec.part_code || rec.qr_raw) + '</b><br>' +
      'Location <b>' + esc(rec.location) + '</b>' + (rec.qty !== '' ? ' · ' + esc(fmtQty(rec.qty, rec.unit)) : '') +
      '<br><span class="muted">' + esc(rec.scanned_by) + ' · ' + esc(rec.scanned_at.replace('T', ' ').slice(0, 19)) + '</span></div>' +
    '<label>เหตุผล</label><div class="reasons">' +
      DELETE_REASONS.map(function (x, i) { return '<label class="radio"><input type="radio" name="reason" value="' + esc(x) + '"' + (i === 0 ? ' checked' : '') + '> ' + esc(x) + '</label>'; }).join('') +
    '</div>' +
    '<input id="reasonOther" class="field hidden" placeholder="ระบุเหตุผล">' +
    '<p class="muted small">ข้อมูลจะถูกทำเครื่องหมาย "ลบ" ในชีต (ไม่หายจริง) เพื่อตรวจสอบย้อนหลังได้</p>' +
    '<div class="actions"><button class="btn" id="mCancel">ยกเลิก</button><button class="btn danger" id="mOk">ยืนยันลบ</button></div>');
  Array.prototype.forEach.call(document.querySelectorAll('input[name=reason]'), function (x) {
    x.onchange = function () { $('reasonOther').classList.toggle('hidden', x.value !== 'อื่นๆ' || !x.checked); };
  });
  $('mCancel').onclick = closeModal;
  $('mOk').onclick = function () {
    var reason = document.querySelector('input[name=reason]:checked').value;
    if (reason === 'อื่นๆ') { reason = $('reasonOther').value.trim(); if (!reason) { toast('กรุณาระบุเหตุผล'); return; } }
    var btn = $('mOk'); btn.disabled = true; btn.textContent = 'กำลังลบ…';
    api('deleteScan', rec.scan_id, S.user, reason).then(function () {
      closeModal(); toast('ลบแล้ว'); onDone && onDone();
    }, function (err) { btn.disabled = false; btn.textContent = 'ยืนยันลบ'; toast(err.message, 3500); });
  };
}

// ======================= หน้าประวัติ =======================
function renderHistory() {
  // ยังไม่ได้เลือกตัวกรองเอง → ใช้วันทำงานและกะปัจจุบัน (อัปเดตทุกครั้งที่เข้าหน้านี้ เผื่อข้ามกะ)
  if (S.hist.auto) {
    var wd = workDay(), cs = currentShift(), cf = S.hist.filter;
    if (cf.dateFrom !== wd || cf.dateTo !== wd || cf.shift !== cs) { cf.dateFrom = cf.dateTo = wd; cf.shift = cs; S.hist.data = null; }
  }
  var f = S.hist.filter;
  $('main').innerHTML =
    '<section class="filters">' +
      '<label class="flabel">จากวันที่<input type="date" id="fFrom" class="field" value="' + esc(f.dateFrom) + '"></label>' +
      '<label class="flabel">ถึงวันที่<input type="date" id="fTo" class="field" value="' + esc(f.dateTo) + '"></label>' +
      '<div class="seg shift-seg">' + [['', 'ทุกกะ'], ['day', '☀️ กะเช้า'], ['night', '🌙 กะดึก']].map(function (o) {
        return '<button type="button" data-shift="' + o[0] + '" class="' + (f.shift === o[0] ? 'active' : '') + '">' + o[1] + '</button>';
      }).join('') + '</div>' +
      '<div class="seg quick-seg">' + [['today', 'วันนี้'], ['yesterday', 'เมื่อวาน'], ['7', '7 วัน'], ['all', 'ทั้งหมด']].map(function (o) {
        return '<button type="button" data-quick="' + o[0] + '" class="' + (histQuickOf(f) === o[0] ? 'active' : '') + '">' + o[1] + '</button>';
      }).join('') + '</div>' +
      '<p class="muted small span2">วันทำงานตัดรอบ 08:00 – 07:59 ของอีกวัน · กะเช้า 08:00–19:59 · กะดึก 20:00–07:59 (สแกนตี 3 ของวันที่ 16 = วันที่ 15 กะดึก)</p>' +
      '<input id="fLoc" class="field" placeholder="Location (เช่น CO-01)" value="' + esc(f.location) + '">' +
      '<select id="fUser" class="field">' + userOptions(f.user) + '</select>' +
      '<div class="ac-wrap"><input id="fQ" class="field" placeholder="ค้นหา รหัส / ชื่อ / Spec / Lot (พิมพ์บางส่วนได้)" autocomplete="off" value="' + esc(f.q) + '">' +
        '<div id="fQSug" class="ac-list hidden"></div></div>' +
      '<label class="radio"><input type="checkbox" id="fDel"' + (f.includeDeleted ? ' checked' : '') + '> แสดงที่ลบ / เอาออกแล้ว</label>' +
      '<button class="btn primary" id="fGo">ค้นหา</button>' +
      '<button class="btn export-btn" id="fXlsx">⬇️ Export Excel (ตามตัวกรอง)</button>' +
    '</section>' +
    '<div id="histOut"></div>';
  $('fGo').onclick = function () {
    S.hist.filter = readHistFilter(); S.hist.auto = false;
    var qk = histQuickOf(S.hist.filter);
    Array.prototype.forEach.call(document.querySelectorAll('[data-quick]'), function (x) { x.classList.toggle('active', x.getAttribute('data-quick') === qk); });
    loadHistory();
  };
  $('fXlsx').onclick = exportExcel;
  Array.prototype.forEach.call(document.querySelectorAll('[data-shift]'), function (b) {
    b.onclick = function () {
      Array.prototype.forEach.call(document.querySelectorAll('[data-shift]'), function (x) { x.classList.toggle('active', x === b); });
      $('fGo').click();
    };
  });
  Array.prototype.forEach.call(document.querySelectorAll('[data-quick]'), function (b) {
    b.onclick = function () {
      var q = b.getAttribute('data-quick'), t = workDay(), d = new Date(t + 'T12:00:00');
      function ymd(x) { return x.getFullYear() + '-' + pad(x.getMonth() + 1) + '-' + pad(x.getDate()); }
      if (q === 'today') { $('fFrom').value = $('fTo').value = t; }
      else if (q === 'yesterday') { d.setDate(d.getDate() - 1); $('fFrom').value = $('fTo').value = ymd(d); }
      else if (q === '7') { d.setDate(d.getDate() - 6); $('fFrom').value = ymd(d); $('fTo').value = t; }
      else {
        // ทั้งหมด = ทุกวัน + ทุกกะ
        $('fFrom').value = $('fTo').value = '';
        Array.prototype.forEach.call(document.querySelectorAll('[data-shift]'), function (x) { x.classList.toggle('active', x.getAttribute('data-shift') === ''); });
      }
      $('fGo').click();
    };
  });
  $('fUser').onchange = function () { $('fGo').click(); };
  $('fLoc').addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); $('fGo').click(); } });
  bindHistSuggest();
  if (S.hist.data) renderHistoryList(); else loadHistory();
}

// ปุ่มลัดช่วงวันที่ที่ตรงกับตัวกรองปัจจุบัน
function histQuickOf(f) {
  var t = workDay(), d = new Date(t + 'T12:00:00');
  function ymd(x) { return x.getFullYear() + '-' + pad(x.getMonth() + 1) + '-' + pad(x.getDate()); }
  if (!f.dateFrom && !f.dateTo) return f.shift ? '' : 'all';
  if (f.dateFrom === t && f.dateTo === t) return 'today';
  d.setDate(d.getDate() - 1); if (f.dateFrom === ymd(d) && f.dateTo === ymd(d)) return 'yesterday';
  d.setDate(d.getDate() - 5); if (f.dateFrom === ymd(d) && f.dateTo === t) return '7';
  return '';
}

// ช่องค้นหา: แนะนำ Lot ที่มีในระบบ (พิมพ์บางส่วนได้) + รหัสสินค้าจาก BOM
function histLotList() {
  var seen = {}, out = [];
  S.recent.forEach(function (r) { if (r.lot_no && r.status !== 'deleted' && !seen[r.lot_no]) { seen[r.lot_no] = 1; out.push([String(r.lot_no), r.part_code, 0]); } });
  S.hist.lots.forEach(function (l) { if (!seen[l[0]]) { seen[l[0]] = 1; out.push(l); } else out.forEach(function (o) { if (o[0] === l[0]) o[2] = l[2]; }); });
  return out;
}
function histSuggestList(q) {
  q = String(q || '').trim().toUpperCase(); if (!q) return [];
  var pre = [], mid = [];
  histLotList().forEach(function (l) {
    var i = l[0].toUpperCase().indexOf(q);
    if (i === 0) pre.push(l); else if (i > 0) mid.push(l);
  });
  var lots = pre.concat(mid).slice(0, 8).map(function (l) { return { kind: 'lot', value: l[0], part: l[1], n: l[2] }; });
  var parts = q.length >= 2 ? suggestParts(q, lots.length >= 6 ? 3 : 6).map(function (c) { return { kind: 'part', value: c }; }) : [];
  return lots.concat(parts);
}
function bindHistSuggest() {
  var inp = $('fQ'), box = $('fQSug'); if (!inp || !box) return;
  function hide() { box.classList.add('hidden'); box.innerHTML = ''; }
  function pick(v) { inp.value = v; hide(); $('fGo').click(); }
  function show() {
    var q = inp.value, list = histSuggestList(q);
    if (!list.length || (list.length === 1 && list[0].value.toUpperCase() === q.trim().toUpperCase())) { hide(); return; }
    box.innerHTML = list.map(function (it, i) {
      var b = it.kind === 'part' ? (window.BOM[it.value] || ['', '']) : (bomInfo(it.part) || {});
      return '<button type="button" class="ac-item' + (i === 0 ? ' active' : '') + '" data-v="' + esc(it.value) + '">' +
        (it.kind === 'lot'
          ? '<span class="ac-code"><span class="ac-kind">Lot</span> ' + markQ(it.value, q) + '</span>' +
            '<span class="ac-name">' + esc(it.part || '') + (b.name ? ' · ' + esc(b.name) : '') + (it.n ? ' · ' + it.n + ' กล่อง' : '') + '</span>'
          : '<span class="ac-code"><span class="ac-kind part">รหัส</span> ' + markQ(it.value, q) + '</span>' +
            (b[0] ? '<span class="ac-name">' + markQ(b[0], q) + '</span>' : '') + (b[1] ? '<span class="ac-spec">' + markQ(b[1], q) + '</span>' : '')) +
        '</button>';
    }).join('');
    box.classList.remove('hidden');
    Array.prototype.forEach.call(box.querySelectorAll('.ac-item'), function (b) {
      b.onmousedown = function (e) { e.preventDefault(); };
      b.onclick = function () { pick(b.getAttribute('data-v')); };
    });
  }
  function move(d) {
    var items = Array.prototype.slice.call(box.querySelectorAll('.ac-item')); if (!items.length) return false;
    var i = items.findIndex(function (x) { return x.classList.contains('active'); });
    i = (i + d + items.length) % items.length;
    items.forEach(function (x, k) { x.classList.toggle('active', k === i); });
    items[i].scrollIntoView({ block: 'nearest' });
    return true;
  }
  inp.addEventListener('input', show);
  inp.addEventListener('focus', function () { if (inp.value.trim()) show(); });
  inp.addEventListener('blur', function () { setTimeout(hide, 150); });
  inp.addEventListener('keydown', function (e) {
    var open = !box.classList.contains('hidden');
    if (e.key === 'ArrowDown' && open) { e.preventDefault(); move(1); }
    else if (e.key === 'ArrowUp' && open) { e.preventDefault(); move(-1); }
    else if (e.key === 'Escape') hide();
    else if (e.key === 'Enter') {
      e.preventDefault();
      var a = open && box.querySelector('.ac-item.active');
      // Enter = ค้นหาตามที่พิมพ์ (บางส่วนก็ได้) · เลือกรายการด้วยลูกศรแล้ว Enter = ใช้รายการนั้น
      if (a && move.used) pick(a.getAttribute('data-v')); else { hide(); $('fGo').click(); }
      move.used = false;
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') move.used = true;
  });
}

// dropdown ผู้บันทึก: ทุกคน + ชื่อจากประวัติ (ล่าสุดก่อน) — ชื่อที่เลือกอยู่แต่ไม่อยู่ในรายการก็ยังแสดง
function userOptions(sel) {
  var names = S.hist.users.slice();
  if (sel && names.indexOf(sel) < 0) names.unshift(sel);
  return '<option value="">👤 ผู้บันทึก: ทุกคน</option>' + names.map(function (n) {
    return '<option value="' + esc(n) + '"' + (n === sel ? ' selected' : '') + '>' + esc(n) + '</option>';
  }).join('');
}

function readHistFilter() {
  var sh = document.querySelector('[data-shift].active');
  var from = $('fFrom').value, to = $('fTo').value;
  if (from && to && from > to) { var t = from; from = to; to = t; $('fFrom').value = from; $('fTo').value = to; }
  var qv = $('fQ').value.trim();
  return { qParts: bomSearch(qv), dateFrom: from, dateTo: to, shift: sh ? sh.getAttribute('data-shift') : '', location: $('fLoc').value.trim().toUpperCase(), user: $('fUser').value, userExact: true,
    q: $('fQ').value.trim(), includeDeleted: $('fDel').checked };
}

// ---------- Export Excel ----------
// ดึงทุกรายการตามตัวกรอง (ไม่จำกัด 300 แถวเหมือนหน้าจอ) แล้วสร้างไฟล์ .xlsx ในเบราว์เซอร์ด้วย SheetJS
var XLSX_URL = 'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js';
var XLSX_COLS = [
  ['scanned_at', 'วันเวลาสแกน', 19], ['work_date', 'วันทำงาน', 11], ['shift', 'กะ', 6], ['location', 'Location', 12], ['part_code', 'รหัสสินค้า', 16], ['bom_name', 'Child Item Name', 32], ['bom_spec', 'Specification', 16], ['bom_org', 'Issuing Organization', 40], ['bom_wh', 'Default Issuing Warehouse', 40], ['lot_no', 'Lot', 13],
  ['qty', 'จำนวน', 9], ['unit', 'หน่วย', 7], ['pkg_ref', 'Package', 10], ['scanned_by', 'ผู้สแกน', 14], ['device', 'เครื่อง', 10],
  ['status', 'สถานะ', 9], ['photos', 'จำนวนรูป', 8], ['location_original', 'Location เดิม', 12], ['qty_original', 'ยอดเดิม', 9],
  ['edited_by', 'แก้ไขล่าสุดโดย', 14], ['edited_at', 'แก้ไขล่าสุดเมื่อ', 19], ['edit_note', 'เหตุผลแก้ไข', 20], ['note', 'หมายเหตุ', 24],
  ['deleted_by', 'ลบโดย', 12], ['deleted_at', 'ลบเมื่อ', 19], ['delete_reason', 'เหตุผลลบ', 16],
  ['out_by', 'เอาออกโดย', 12], ['out_at', 'เอาออกเมื่อ', 19], ['out_reason', 'เหตุผลเอาออก', 20], ['out_qty', 'จำนวนที่เอาออก', 10], ['qr_raw', 'QR', 40], ['scan_id', 'scan_id', 38]
];

// ชื่อผู้บันทึกที่เป็นการทดสอบ (ทดสอบระบบ, test, Test01 …) — ไม่นำไปใน Excel
var TEST_USER_RE = /test|ทดสอบ/i;
function isTestUser(name) { return TEST_USER_RE.test(String(name || '')); }

function exportExcel() {
  var f = readHistFilter();
  var btn = $('fXlsx'); btn.disabled = true; btn.textContent = 'กำลังเตรียมไฟล์…';
  function done() { btn.disabled = false; btn.textContent = '⬇️ Export Excel (ตามตัวกรอง)'; }
  Promise.all([loadScriptOnce(XLSX_URL), api('listScans', Object.assign({}, f, { limit: 20000, export: true }))]).then(function (res) {
    var d = res[1];
    // ไม่ส่งออกข้อมูลทดสอบ (ผู้บันทึกชื่อมีคำว่า ทดสอบ / test)
    var all = d.rows.length;
    d.rows = d.rows.filter(function (r) { return !isTestUser(r.scanned_by); });
    var skipped = all - d.rows.length;
    if (!d.rows.length) { done(); toast(skipped ? 'มีแต่ข้อมูลทดสอบ (' + skipped + ' รายการ) — ไม่ได้ส่งออก' : 'ไม่มีข้อมูลตามตัวกรอง', 3000); return; }
    var rows = d.rows.slice().reverse().map(function (r) { // เก่า → ใหม่
      var o = {};
      XLSX_COLS.forEach(function (c) {
        var k = c[0], v = r[k];
        if (k === 'status') v = r.status === 'deleted' ? 'ลบแล้ว' : r.status === 'out' ? 'เอาออกแล้ว' : 'ใช้งาน';
        if (k === 'photos') v = (r.photos || []).length;
        if (k === 'work_date') v = shiftOf(r.scanned_at).date;
        if (k.indexOf('bom_') === 0) { var bi = bomInfo(r.part_code) || {}; v = bi[k.slice(4)] || ''; }
        if (k === 'shift') v = SHIFT_TEXT[shiftOf(r.scanned_at).shift] || '';
        if (k === 'location_original' && v === r.location) v = '';
        o[c[1]] = v === undefined || v === null ? '' : v;
      });
      return o;
    });
    var wb = XLSX.utils.book_new();
    var ws = XLSX.utils.json_to_sheet(rows, { header: XLSX_COLS.map(function (c) { return c[1]; }) });
    ws['!cols'] = XLSX_COLS.map(function (c) { return { wch: c[2] }; });
    ws['!autofilter'] = { ref: ws['!ref'] };
    XLSX.utils.book_append_sheet(wb, ws, 'รายการ');

    // สรุปตามพาร์ท (เฉพาะรายการที่ใช้งาน)
    var sum = {};
    d.rows.forEach(function (r) {
      if (r.status === 'deleted' || r.status === 'out') return;
      var key = r.part_code + '|' + r.unit;
      var s = sum[key] || (sum[key] = { part: r.part_code, unit: r.unit, n: 0, qty: 0, locs: {} });
      s.n++; if (typeof r.qty === 'number') s.qty += r.qty; s.locs[r.location] = 1;
    });
    var srows = Object.keys(sum).sort().map(function (k) {
      var s = sum[k];
      var bi = bomInfo(s.part) || {};
      return { 'รหัสสินค้า': s.part, 'Child Item Name': bi.name || '', 'Specification': bi.spec || '', 'Issuing Organization': bi.org || '', 'Default Issuing Warehouse': bi.wh || '', 'จำนวนกล่อง': s.n, 'ยอดรวม': Math.round(s.qty * 1000) / 1000, 'หน่วย': s.unit,
               'จำนวน Location': Object.keys(s.locs).length, 'Location': Object.keys(s.locs).sort().join(', ') };
    });
    var ws2 = XLSX.utils.json_to_sheet(srows.length ? srows : [{ 'รหัสสินค้า': '(ไม่มีรายการที่ใช้งาน)' }]);
    ws2['!cols'] = [{ wch: 16 }, { wch: 32 }, { wch: 16 }, { wch: 40 }, { wch: 40 }, { wch: 11 }, { wch: 10 }, { wch: 7 }, { wch: 14 }, { wch: 60 }];
    XLSX.utils.book_append_sheet(wb, ws2, 'สรุปตามพาร์ท');

    var now = new Date();
    var range = f.dateFrom || f.dateTo ? (f.dateFrom || '…').replace(/-/g, '') + (f.dateTo && f.dateTo !== f.dateFrom ? '-' + f.dateTo.replace(/-/g, '') : '') : 'ทั้งหมด';
    var name = 'PDA-Scan_' + range + (f.shift ? '_กะ' + SHIFT_TEXT[f.shift] : '') + (f.location ? '_' + f.location : '') +
      '_' + now.getFullYear() + pad(now.getMonth() + 1) + pad(now.getDate()) + '-' + pad(now.getHours()) + pad(now.getMinutes()) + '.xlsx';
    XLSX.writeFile(wb, name);
    done();
    toast('ดาวน์โหลด ' + d.rows.length + ' รายการ' + (skipped ? ' · ไม่รวมข้อมูลทดสอบ ' + skipped + ' รายการ' : '') + (all < d.total ? ' (ตัดที่ 20,000 แถว)' : ''), 3500);
  }, function (err) { done(); toast(err.message === 'load failed' ? 'โหลดตัวสร้าง Excel ไม่ได้ (ต้องต่ออินเทอร์เน็ต)' : err.message, 3500); });
}

function loadHistory() {
  S.hist.loading = true; S.hist.error = ''; renderHistoryList();
  api('listScans', Object.assign({ limit: 300 }, S.hist.filter)).then(function (d) {
    S.online = true; S.hist.data = d; S.hist.loading = false;
    if (d.lots) { S.hist.lots = d.lots; storeJson('pda_lots', d.lots); }
    if (d.users && d.users.join('|') !== S.hist.users.join('|')) {
      S.hist.users = d.users; storeJson('pda_users', d.users);
      if ($('fUser')) $('fUser').innerHTML = userOptions($('fUser').value);
    }
    renderHistoryList(); refreshHeader();
  }, function (err) {
    if (err.network) S.online = false;
    S.hist.loading = false; S.hist.error = err.message; renderHistoryList(); refreshHeader();
  });
}

function renderHistoryList() {
  var el = $('histOut'); if (!el) return;
  if (S.hist.loading) { el.innerHTML = '<div class="center muted pad">กำลังโหลด…</div>'; return; }
  if (S.hist.error) { el.innerHTML = '<div class="msg err">' + esc(S.hist.error) + '</div>'; return; }
  var d = S.hist.data; if (!d) { el.innerHTML = ''; return; }
  var head = '<div class="stats"><div><b>' + d.total + '</b><span>รายการ</span></div><div><b>' + d.partCount + '</b><span>รหัสสินค้า</span></div>' +
    '<div><b>' + d.locationCount + '</b><span>Location</span></div></div>';
  if (!d.rows.length) { el.innerHTML = head + '<div class="empty-list muted">ไม่พบรายการ</div>'; return; }
  el.innerHTML = head + (d.rows.length < d.total ? '<p class="muted small">แสดง ' + d.rows.length + ' รายการล่าสุด</p>' : '') +
    d.rows.map(function (r) {
      var isOut = r.status === 'out', del = r.status === 'deleted' || isOut;
      return '<div class="row ' + (isOut ? 'st-out' : del ? 'st-deleted' : '') + '">' +
        '<div class="row-main">' +
          '<div class="row-top">' + partLink(r, true) + (isOut ? '<span class="tag out">เอาออกแล้ว</span>' : del ? '<span class="tag deleted">ลบแล้ว</span>' : '') + '</div>' +
          itemLines(r, qtyChip(r, !del, 'data-hqty'), locChip(r, !del, 'data-hloc')) +
          '<div class="row-sub muted small"><span>👤 ' + esc(r.scanned_by) + '</span><span>' + esc(r.scanned_at) + '</span>' + photoChip(r.scan_id, r) +
            (shiftOf(r.scanned_at).shift ? '<span class="shift-tag ' + shiftOf(r.scanned_at).shift + '">กะ' + SHIFT_TEXT[shiftOf(r.scanned_at).shift] + '</span>' : '') + '</div>' +
          (isOut ? '<div class="row-sub small out-text">📤 เอาออกโดย ' + esc(r.out_by) + ' · ' + esc(r.out_at) + ' · ' + esc(r.out_reason) +
              (r.out_qty !== '' ? ' · ' + esc(fmtQty(r.out_qty, r.unit)) : '') + '</div>'
            : del ? '<div class="row-sub muted small">ลบโดย ' + esc(r.deleted_by) + ' · ' + esc(r.deleted_at) + ' · ' + esc(r.delete_reason) + '</div>' : '') +
        '</div>' +
        (del ? '' : '<div class="row-actions"><button class="btn small" data-cam="' + esc(r.scan_id) + '" aria-label="ถ่ายรูป">📷</button>' +
          '<button class="btn small warn" data-hout="' + esc(r.scan_id) + '">ออก</button>' +
          '<button class="btn small danger" data-hdel="' + esc(r.scan_id) + '">ลบ</button></div>') +
      '</div>';
    }).join('');
  bindPhotoButtons(el, function (id) { return d.rows.filter(function (x) { return x.scan_id === id; })[0] || null; });
  bindTimelineLinks(el);
  Array.prototype.forEach.call(el.querySelectorAll('[data-hloc]'), function (b) {
    b.onclick = function () { editHistoryLocation(d.rows.filter(function (x) { return x.scan_id === b.getAttribute('data-hloc'); })[0]); };
  });
  Array.prototype.forEach.call(el.querySelectorAll('[data-hqty]'), function (b) {
    b.onclick = function () { editHistoryQty(d.rows.filter(function (x) { return x.scan_id === b.getAttribute('data-hqty'); })[0]); };
  });
  Array.prototype.forEach.call(el.querySelectorAll('[data-hout]'), function (b) {
    b.onclick = function () { openOutModal(d.rows.filter(function (x) { return x.scan_id === b.getAttribute('data-hout'); })[0], function () { loadHistory(); }); };
  });
  Array.prototype.forEach.call(el.querySelectorAll('[data-hdel]'), function (b) {
    b.onclick = function () {
      var id = b.getAttribute('data-hdel');
      var rec = d.rows.filter(function (x) { return x.scan_id === id; })[0];
      openDeleteModal(rec, function () {
        var local = findRecent(id); if (local) { local.status = 'deleted'; saveRecent(); }
        loadHistory();
      });
    };
  });
}

// ======================= Modals =======================
// locked = ปิดด้วยการแตะพื้นหลังไม่ได้ (ใช้กับหน้ากรอกชื่อที่บังคับ)
function openModal(html, locked) {
  var m = $('modal');
  m.innerHTML = '<div class="sheet">' + html + '</div>';
  m.classList.remove('hidden');
  m.onclick = function (e) { if (e.target === m && !locked) closeModal(); };
}
function closeModal() {
  var m = $('modal'); m.classList.add('hidden'); m.innerHTML = '';
  setTimeout(focusScan, 50);
}

function confirmModal(title, body, okText, onOk) {
  openModal('<h3>' + title + '</h3><p>' + body + '</p>' +
    '<div class="actions"><button class="btn" id="mCancel">ยกเลิก</button><button class="btn danger" id="mOk">' + esc(okText) + '</button></div>');
  $('mCancel').onclick = closeModal;
  $('mOk').onclick = function () { closeModal(); onOk(); };
}

// ถ้ายังไม่มีชื่อ = บังคับกรอก: ไม่มีปุ่มยกเลิก ปิดไม่ได้จนกว่าจะใส่ชื่อ
// ชื่อที่ใช้ไม่ได้: ว่าง, สั้นกว่า 2 ตัว, หรือมีแต่ 0 / - / . / _ / ช่องว่าง (เช่น "0" ที่ใช้ปิดชื่อหลังเลิกงาน)
function validName(v) {
  v = String(v || '').trim();
  return v.length >= 2 && !/^[0\-._\s]+$/.test(v);
}

// ถ้ายังไม่มีชื่อ = บังคับกรอก: ไม่มีปุ่มยกเลิก ปิดไม่ได้จนกว่าจะใส่ชื่อ
function openUserModal() {
  var required = !S.user;
  openModal('<h3>' + (required ? 'กรุณากรอกชื่อก่อนเริ่มใช้งาน' : 'ชื่อผู้สแกน') + '</h3>' +
    '<p class="muted small">ใช้บันทึกว่าใครเป็นคนสแกน / แก้ยอด / ลบ (จำไว้ในเครื่องนี้)</p>' +
    '<input id="uName" class="field big" placeholder="ชื่อ หรือ รหัสพนักงาน" autocomplete="off" value="' + esc(S.user) + '">' +
    '<div class="actions">' + (required ? '' : '<button class="btn" id="mCancel">ยกเลิก</button>') +
    '<button class="btn primary" id="mOk">' + (required ? 'เริ่มใช้งาน' : 'บันทึก') + '</button></div>' +
    (required ? '' : '<hr class="sep"><button class="btn danger logout-btn" id="uLogout">🚪 จบงาน (ออกจากระบบ)</button>' +
      '<p class="muted small center">คนถัดไปต้องกรอกชื่อของตัวเองก่อนสแกน</p>'), required);
  var inp = $('uName'); setTimeout(function () { inp.focus(); }, 50);
  inp.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); $('mOk').click(); } });
  if ($('mCancel')) $('mCancel').onclick = closeModal;
  if ($('uLogout')) $('uLogout').onclick = logout;
  $('mOk').onclick = function () {
    var v = inp.value.trim();
    if (!validName(v)) { toast('กรุณาใส่ชื่อหรือรหัสพนักงานของตัวเอง (อย่างน้อย 2 ตัว ห้ามใช้ 0)', 3000); inp.focus(); return; }
    S.user = v; store('pda_user', v); closeModal(); render();
  };
}

// จบงาน: ล้างชื่อ + รายการที่ยังไม่ได้กดบันทึก → คนถัดไปต้องกรอกชื่อใหม่ (รายการรอส่งยังส่งต่อด้วยชื่อคนเดิม)
function logout() {
  var who = S.user;
  S.user = ''; store('pda_user', null);
  setDraft(null);
  S.msg = null;
  closeModal();
  render();
  openUserModal();
  toast('จบงานแล้ว (' + who + ')');
}

function appLink() { return location.origin + location.pathname; }

function loadScriptOnce(src) {
  loadScriptOnce.cache = loadScriptOnce.cache || {};
  if (!loadScriptOnce.cache[src]) loadScriptOnce.cache[src] = new Promise(function (res, rej) {
    var sc = document.createElement('script'); sc.src = src; sc.onload = res;
    sc.onerror = function () { delete loadScriptOnce.cache[src]; rej(new Error('load failed')); };
    document.head.appendChild(sc);
  });
  return loadScriptOnce.cache[src];
}

function renderLinkQr(el) {
  var url = appLink();
  loadScriptOnce('https://cdnjs.cloudflare.com/ajax/libs/qrcode-generator/1.4.4/qrcode.min.js').then(function () {
    var qr = window.qrcode(0, 'M'); qr.addData(url); qr.make();
    el.innerHTML = qr.createSvgTag({ cellSize: 6, margin: 2, scalable: true });
  }, function () { el.textContent = 'สร้าง QR ไม่ได้ (ต้องต่ออินเทอร์เน็ต) — ใช้ลิงก์ด้านล่างแทน'; });
}

function openSettings() {
  openModal('<h3>ตั้งค่า</h3>' +
    '<label>ลิงก์เว็บ — ให้เครื่องอื่นสแกน QR นี้เพื่อเปิดใช้งาน</label>' +
    '<div id="sQr" class="qr-box muted small">กำลังสร้าง QR…</div>' +
    '<div class="qr-url"><code>' + esc(appLink()) + '</code><button class="btn small" id="sCopy">คัดลอก</button></div>' +
    '<label>ชื่อเครื่อง (เช่น TN28-01)</label><input id="sDev" class="field" value="' + esc(S.device) + '">' +
    '<label>API URL (Apps Script /exec)</label><input id="sUrl" class="field" placeholder="https://script.google.com/macros/s/.../exec" value="' + esc(store('pda_api_url') || '') + '">' +
    '<p class="muted small">เว้นว่าง = ใช้ค่าใน js/config.js' + (window.PDA_CONFIG.API_URL ? '' : ' (ยังไม่ได้ตั้ง)') + '</p>' +
    '<div class="actions wrap"><button class="btn" id="sTest">ทดสอบเชื่อมต่อ</button><button class="btn" id="sClear">ล้างรายการที่ส่งแล้ว</button></div>' +
    '<div id="sOut" class="muted small"></div>' +
    '<div class="actions"><button class="btn" id="mCancel">ปิด</button><button class="btn primary" id="mOk">บันทึก</button></div>');
  function apply() {
    S.device = $('sDev').value.trim(); store('pda_device', S.device || null);
    store('pda_api_url', $('sUrl').value.trim() || null);
  }
  $('sTest').onclick = function () {
    apply(); $('sOut').textContent = 'กำลังทดสอบ…';
    api('ping').then(function (d) { S.online = true; $('sOut').textContent = '✔ เชื่อมต่อได้ เวลาเซิร์ฟเวอร์ ' + d.time; refreshHeader(); flush(); },
      function (err) { $('sOut').textContent = '✖ ' + err.message; });
  };
  $('sClear').onclick = function () {
    S.recent = S.recent.filter(function (r) { return r.status === 'pending'; });
    saveRecent(); refreshScanParts(); $('sOut').textContent = 'ล้างแล้ว (คงรายการรอส่งไว้)';
  };
  renderLinkQr($('sQr'));
  $('sCopy').onclick = function () {
    var url = appLink();
    var done = function () { toast('คัดลอกลิงก์แล้ว'); };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(url).then(done, function () { prompt('คัดลอกลิงก์', url); });
    else prompt('คัดลอกลิงก์', url);
  };
  $('mCancel').onclick = closeModal;
  $('mOk').onclick = function () { apply(); closeModal(); toast('บันทึกแล้ว'); flush(); };
}

// ---------- เลือก Location ----------
var LOC_TREE = (function () {
  var tree = {};
  (window.LOCATIONS || []).forEach(function (code) {
    var m = code.match(/^([A-Z0-9]+)-(\d+)-(.+)$/);
    var zone = m ? m[1] : 'อื่นๆ', rack = m ? m[2] : '-';
    tree[zone] = tree[zone] || {};
    (tree[zone][rack] = tree[zone][rack] || []).push(code);
  });
  return tree;
})();

// opts (ไม่บังคับ): { current, title, onPick(code) } — ไม่ส่ง = เปลี่ยน Location ปัจจุบันของเครื่อง
function openLocationPicker(opts) {
  opts = opts && typeof opts.onPick === 'function' ? opts : null;
  var curLoc = opts ? (opts.current || '') : S.location;
  var cur = (curLoc || '').match(/^([A-Z0-9]+)-(\d+)-/);
  var zones = Object.keys(LOC_TREE);
  var st = { zone: cur ? cur[1] : zones[0], rack: cur ? cur[2] : null, q: '' };
  openModal('<h3>' + esc(opts && opts.title || 'เลือก Location') + '</h3>' +
    '<input id="locQ" class="field" placeholder="พิมพ์ค้นหา เช่น CO-01-05" autocomplete="off">' +
    '<div id="locBody"></div>' +
    '<div class="actions"><button class="btn" id="mCancel">ปิด</button></div>');
  $('mCancel').onclick = closeModal;
  $('locQ').addEventListener('input', function () { st.q = this.value.trim().toUpperCase(); draw(); });
  $('locQ').addEventListener('keydown', function (e) {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    var exact = asLocation(this.value);
    if (exact) choose(exact);
  });

  function choose(code) {
    if (opts) { closeModal(); opts.onPick(code); return; }
    setLocation(code); closeModal(); beep(true); setMsg('ok', '📍 Location: <b>' + esc(code) + '</b>');
  }

  function draw() {
    var body = $('locBody'); var html = '';
    if (st.q) {
      var hits = (window.LOCATIONS || []).filter(function (c) { return c.indexOf(st.q) >= 0; }).slice(0, 80);
      html = hits.length ? '<div class="grid">' + hits.map(function (c) { return btn(c, c); }).join('') + '</div>' : '<div class="muted pad">ไม่พบ</div>';
    } else {
      html += '<div class="seg">' + zones.map(function (z) { return '<button data-zone="' + z + '" class="' + (z === st.zone ? 'active' : '') + '">' + z + '</button>'; }).join('') + '</div>';
      var racks = Object.keys(LOC_TREE[st.zone] || {});
      html += '<div class="seg">' + racks.map(function (r) { return '<button data-rack="' + r + '" class="' + (r === st.rack ? 'active' : '') + '">' + st.zone + '-' + r + '</button>'; }).join('') + '</div>';
      if (st.rack && LOC_TREE[st.zone][st.rack]) {
        html += '<div class="grid">' + LOC_TREE[st.zone][st.rack].map(function (c) { return btn(c, c.split('-').slice(2).join('-')); }).join('') + '</div>';
      } else html += '<div class="muted pad center">เลือกแถว (Rack)</div>';
    }
    body.innerHTML = html;
    Array.prototype.forEach.call(body.querySelectorAll('[data-zone]'), function (b) { b.onclick = function () { st.zone = b.getAttribute('data-zone'); st.rack = null; draw(); }; });
    Array.prototype.forEach.call(body.querySelectorAll('[data-rack]'), function (b) { b.onclick = function () { st.rack = b.getAttribute('data-rack'); draw(); }; });
    Array.prototype.forEach.call(body.querySelectorAll('[data-loc]'), function (b) { b.onclick = function () { choose(b.getAttribute('data-loc')); }; });
  }
  function btn(code, label) { return '<button data-loc="' + esc(code) + '" class="' + (code === curLoc ? 'active' : '') + '">' + esc(label) + '</button>'; }
  draw();
}

// ======================= สแกนด้วยกล้อง (โทรศัพท์) =======================
// ลำดับตัวอ่าน: 1) ตัวอ่านในเบราว์เซอร์ (Android Chrome / iPhone ที่เปิด Shape Detection API) → 2) zxing (WebAssembly) → 3) jsQR
// อ่านภาพต่อเนื่องทุกเฟรม · ขอภาพ 1920×1080 · อ่านเฉพาะกรอบกลางจอแบบเต็มความละเอียด · ซูม/โฟกัส/ไฟฉาย ถ้าเครื่องรองรับ
var ZXING_URL = 'https://cdn.jsdelivr.net/npm/barcode-detector@2.2.2/dist/es/pure.min.js';
var JSQR_URL = 'js/vendor/jsqr.js?v=2'; // jsQR ในเครื่อง (เปิดส่วนภายในให้ตัวกู้ QR ใช้)
var PARTIALQR_URL = 'js/partialqr.js?v=3';
var SCAN_FORMATS = ['qr_code', 'code_128', 'code_39', 'ean_13', 'data_matrix'];
var CROP_RATIO = 0.7; // ขนาดกรอบกลางจอ (สัดส่วนของด้านสั้น)
var IS_IOS = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

function firstValue(r) { return r && r.length ? r[0].rawValue : null; }

// ตัวอ่านแต่ละตัว: { name, label, src: 'video' | 'full' | 'crop', detect(src) → Promise<text|null> }
function makeNativeEngine() {
  if (!(window.BarcodeDetector && window.BarcodeDetector.getSupportedFormats)) return Promise.reject(new Error('no native'));
  return window.BarcodeDetector.getSupportedFormats().then(function (f) {
    if (f.indexOf('qr_code') < 0) throw new Error('no qr');
    var d = new window.BarcodeDetector({ formats: SCAN_FORMATS.filter(function (x) { return f.indexOf(x) >= 0; }) });
    // iPhone (ฟีเจอร์ทดลอง): ส่งเป็นภาพนิ่ง (canvas) เผื่ออ่านจาก video ไม่ได้
    return { name: 'native', label: IS_IOS ? 'Apple' : 'เบราว์เซอร์', src: IS_IOS ? 'full' : 'video',
             detect: function (src) { return d.detect(src).then(firstValue); } };
  });
}
function makeZxingEngine() {
  return import(ZXING_URL).then(function (m) {
    var d = new m.BarcodeDetector({ formats: SCAN_FORMATS });
    return { name: 'zxing', label: 'zxing', src: 'crop', detect: function (src) { return d.detect(src).then(firstValue); } };
  });
}
function makeJsqrEngine() {
  return loadScriptOnce(JSQR_URL).then(function () {
    return { name: 'jsqr', label: 'jsQR', src: 'crop', detect: function (src) {
      var g = src.getContext('2d', { willReadFrequently: true });
      var r = window.jsQR(g.getImageData(0, 0, src.width, src.height).data, src.width, src.height, { inversionAttempts: 'attemptBoth' });
      return Promise.resolve(r && r.data ? r.data : null);
    } };
  });
}

// ตัวกู้ QR มุมขาด (ป้ายพิมพ์ตกขอบ): หาสี่เหลี่ยมมุมที่เหลือ 2 มุม → คำนวณมุมที่หาย → ให้ Error Correction ของ QR กู้ข้อมูล
// ใช้ CPU มากกว่า → เว้นระยะตามเวลาที่ใช้จริง (อย่างน้อย 250 ms) และย่อภาพไม่เกิน 480 px
function makePartialEngine() {
  return loadScriptOnce(JSQR_URL).then(function () { return loadScriptOnce(PARTIALQR_URL); }).then(function () {
    if (!window.jsQR || !window.jsQR._i || !window.decodePartialQR) throw new Error('no partial');
    var last = 0, gap = 250, cv = document.createElement('canvas');
    return { name: 'partial', label: 'กู้ QR', src: 'crop', detect: function (src) {
      var now = Date.now(); if (now - last < gap) return Promise.resolve(null); last = now;
      var k = Math.min(1, 480 / Math.max(src.width, src.height)), w = Math.round(src.width * k), h = Math.round(src.height * k);
      cv.width = w; cv.height = h;
      var g = cv.getContext('2d', { willReadFrequently: true }); g.drawImage(src, 0, 0, w, h);
      var r = window.decodePartialQR(window.jsQR, g.getImageData(0, 0, w, h).data, w, h);
      gap = Math.max(250, (Date.now() - now) * 3); // เครื่องช้า → เว้นนานขึ้น กล้องไม่หน่วง
      return Promise.resolve(r && r.data ? r.data : null);
    } };
  });
}

// Android ที่มีตัวอ่านในเบราว์เซอร์ → ใช้ตัวนั้นตัวเดียว
// iPhone / อื่นๆ → zxing (สำรอง jsQR) และถ้ามีตัวอ่าน Apple ให้สลับใช้คู่กันทุกเฟรม (ตัวทดลองอาจอ่านไม่ได้)
function getDetectors() {
  if (getDetectors.p) return getDetectors.p;
  getDetectors.p = makeNativeEngine().catch(function () { return null; }).then(function (nat) {
    var part = makePartialEngine().catch(function () { return null; });
    if (nat && !IS_IOS) return part.then(function (p) { return [nat, p].filter(Boolean); });
    return Promise.all([makeZxingEngine().catch(function () { return makeJsqrEngine(); }).catch(function () { return null; }), part]).then(function (zz) {
      var z = zz[0], list = [nat, z, zz[1]].filter(Boolean);
      if (!list.length) throw new Error('โหลดตัวอ่าน QR ไม่ได้ (ต้องต่ออินเทอร์เน็ต)');
      return list;
    });
  });
  getDetectors.p.catch(function () { getDetectors.p = null; });
  return getDetectors.p;
}

var camCanvas = null;
var camCropSide = 0; // ด้านของกรอบเล็งในหน่วยพิกเซลของภาพกล้อง (คำนวณจากกรอบที่เห็นบนจอ)
var camLuma = -1;    // ความสว่างเฉลี่ยในกรอบ (0–255) — ใช้เตือนแสงน้อย
// แต่ละเฟรมสลับวิธีเตรียมภาพ เพื่อให้อ่านได้ทั้งตอนภาพชัด / เบลอ / แสงน้อย:
// 0 = กรอบกลางเต็มความละเอียด · 1 = กรอบกลางย่อครึ่ง (ภาพเบลอ/สั่น ย่อแล้วขอบ QR คมขึ้น)
// 2 = ย่อครึ่ง + เร่งความต่างสี (แสงน้อย ภาพหม่น) · 3 = ทั้งภาพ (เผื่อ QR อยู่นอกกรอบ)
function grabVariant(src, v) {
  if (v === 3) return grabFrame(src, true);
  var c = grabFrame(src, false, v === 0 ? 1 : 0.5);
  if (c && v === 2) stretchContrast(c);
  return c;
}
// ยืดช่วงความสว่าง (ตัด 2% มืดสุด/สว่างสุด) → ขาวดำชัดขึ้นตอนแสงน้อย + วัดความสว่างเฉลี่ย
function stretchContrast(c) {
  var g = c.getContext('2d', { willReadFrequently: true }), img = g.getImageData(0, 0, c.width, c.height), d = img.data;
  var hist = new Uint32Array(256), n = d.length / 4, sum = 0, i, y;
  for (i = 0; i < d.length; i += 4) { y = (d[i] * 77 + d[i + 1] * 150 + d[i + 2] * 29) >> 8; d[i] = y; hist[y]++; sum += y; }
  camLuma = sum / n;
  var lo = 0, hi = 255, acc = 0, cut = n * 0.02;
  while (lo < 255 && (acc += hist[lo]) < cut) lo++;
  acc = 0; while (hi > 0 && (acc += hist[hi]) < cut) hi--;
  if (hi - lo < 8) return;
  var lut = new Uint8ClampedArray(256), k = 255 / (hi - lo);
  for (i = 0; i < 256; i++) lut[i] = (i - lo) * k;
  for (i = 0; i < d.length; i += 4) { y = lut[d[i]]; d[i] = d[i + 1] = d[i + 2] = y; }
  g.putImageData(img, 0, 0);
}
// ตัดกรอบกลางภาพ (scale = อัตราย่อ) · full = ทั้งภาพ ย่อไม่เกิน 1280
function grabFrame(src, full, scale) {
  var w = src.videoWidth || src.width, h = src.videoHeight || src.height;
  if (!w || !h) return null;
  var sx = 0, sy = 0, sw = w, sh = h, ow, oh;
  if (full) { var k = Math.min(1, 1280 / Math.max(w, h)); ow = Math.round(w * k); oh = Math.round(h * k); }
  else {
    var side = camCropSide || Math.round(Math.min(w, h) * CROP_RATIO);
    sx = Math.round((w - side) / 2); sy = Math.round((h - side) / 2); sw = sh = side;
    ow = oh = Math.round(Math.min(side, 1000) * (scale || 1));
  }
  camCanvas = camCanvas || document.createElement('canvas');
  camCanvas.width = ow; camCanvas.height = oh;
  camCanvas.getContext('2d', { willReadFrequently: true }).drawImage(src, sx, sy, sw, sh, 0, 0, ow, oh);
  return camCanvas;
}

function openCameraScanner(onResult, opts) {
  opts = opts || {};
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    toast('เบราว์เซอร์นี้เปิดกล้องไม่ได้ (ต้องเปิดผ่าน https)', 3500); return;
  }
  var canCont = !!opts.onEach;
  openModal('<h3>สแกนด้วยกล้อง</h3>' +
    (canCont ? '<div class="cam-mode"><label class="cam-switch"><input type="checkbox" id="camCont"' + (store('pda_cam_cont') === '1' ? ' checked' : '') + '>' +
      '<span class="cam-switch-ui"></span>🔁 สแกนต่อเนื่อง</label><span class="small">Location: <span class="loc-pill" id="camLoc"></span></span></div>' : '') +
    '<div class="cam-wrap" id="camWrap"><video id="camV" playsinline muted autoplay></video><div class="cam-frame" id="camFrame"></div>' +
      '<div class="cam-flash" id="camFlash"></div><div class="cam-count hidden" id="camCount"></div></div>' +
    '<div class="cam-tools" id="camTools"></div>' +
    '<p class="center small" id="camHint">กำลังเปิดกล้อง…</p>' +
    (canCont ? '<div class="cam-log" id="camLog"></div>' : '') +
    '<p class="muted small center" id="camInfo"></p>' +
    '<div class="actions"><button class="btn" id="camClose">ปิด</button></div>', true);
  var video = $('camV'), stream = null, done = false, track = null;
  var log = [], saved = 0, lastText = '', lastAt = 0, ready = false;
  function stop() { done = true; if (stream) stream.getTracks().forEach(function (t) { t.stop(); }); }
  function cont() { return canCont && $('camCont') && $('camCont').checked; }
  $('camClose').onclick = function () {
    stop(); closeModal();
    if (saved) toast('บันทึกจากกล้อง ' + saved + ' รายการ', 2500);
  };
  function hint() {
    var el = $('camHint'); if (!el || !ready) return;
    el.innerHTML = cont()
      ? '<b>โหมดต่อเนื่อง:</b> สแกน QR Location ก่อน แล้วสแกนกล่องต่อกันได้เลย — <b>บันทึกอัตโนมัติ</b> ไม่ต้องกดบันทึก'
      : 'เล็ง QR ให้อยู่ในกรอบ' + (IS_IOS ? ' · <b>ถือห่างประมาณ 20–30 ซม.</b>' : '');
  }
  function renderCont() {
    if (!canCont) return;
    var on = cont();
    $('camWrap').classList.toggle('cont', on);
    if ($('camLoc')) { $('camLoc').textContent = S.location || 'ยังไม่เลือก'; $('camLoc').classList.toggle('none', !S.location); }
    var c = $('camCount'); if (c) { c.textContent = '✔ ' + saved; c.classList.toggle('hidden', !on || !saved); }
    var el = $('camLog');
    if (el) el.innerHTML = on ? (log.length ? log.slice(0, 6).map(function (r, i) {
      return '<div class="cam-log-row ' + r.cls + (i === 0 ? ' new' : '') + '">' + r.html + '</div>';
    }).join('') : '<div class="muted small center">ยังไม่มีรายการ</div>') : '';
    $('camClose').textContent = on && saved ? 'เสร็จ (บันทึก ' + saved + ' รายการ)' : 'ปิด';
    hint();
  }
  if (canCont) $('camCont').onchange = function () { store('pda_cam_cont', this.checked ? '1' : '0'); renderCont(); };
  renderCont();
  function flash(cls) {
    var f = $('camFlash'); if (!f) return;
    f.className = 'cam-flash ' + cls; void f.offsetWidth; f.classList.add('on');
  }

  var cam = navigator.mediaDevices.getUserMedia({
    video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false
  });
  Promise.all([cam, getDetectors()]).then(function (res) {
    stream = res[0];
    var engines = res[1].map(function (e) { e.frames = 0; e.hits = 0; e.errors = 0; e.fails = 0; e.lastErr = ''; return e; });
    if (done) { stop(); return; }
    track = stream.getVideoTracks()[0];
    video.srcObject = stream;
    return video.play().then(function () {
      sizeFrame();
      setupCamTools(track);
      ready = true; hint();
      var all = engines.slice(), n = 0, lastInfo = 0;
      // ข้อมูลวินิจฉัย: ตัวอ่าน · จำนวนเฟรมที่อ่าน · ข้อผิดพลาด
      function info(force) {
        var now = Date.now(); if (!force && now - lastInfo < 500) return; lastInfo = now;
        var el = $('camInfo'); if (!el) return;
        el.innerHTML = video.videoWidth + '×' + video.videoHeight + ' · ' + all.map(function (e) {
          var off = engines.indexOf(e) < 0;
          return '<span class="' + (off ? 'eng-off' : '') + '">' + esc(e.label) + ' ' + e.frames + ' เฟรม' +
            (e.errors ? ' · ผิดพลาด ' + e.errors + (e.lastErr ? ' (' + esc(String(e.lastErr).slice(0, 60)) + ')' : '') : '') +
            (off ? ' · ปิดแล้ว' : '') + '</span>';
        }).join(' | ');
      }
      info(true);
      // อ่านไม่ได้นานเกิน 4 วินาที → แนะนำวิธีแก้ (แสงน้อย = เปิดไฟฉาย)
      var startAt = Date.now(), tipShown = '';
      function lowLightTip() {
        var el = $('camHint'); if (!el || cont()) return;
        var dark = camLuma >= 0 && camLuma < 80, slow = Date.now() - startAt > 4000, torch = $('camTorch');
        var tip = dark && torch ? 'dark' : slow ? 'slow' : '';
        if (tip === tipShown) return; tipShown = tip;
        if (torch) torch.classList.toggle('pulse', tip === 'dark' && !torch.classList.contains('active'));
        if (tip === 'dark') el.innerHTML = '🌙 <b>แสงน้อย</b> — กด <b>🔦 ไฟฉาย</b> แล้วถือให้นิ่ง';
        else if (tip === 'slow') el.innerHTML = 'ยังอ่านไม่ได้: <b>ถือให้นิ่ง</b> · ถอยออกเล็กน้อยให้ภาพชัด' + (torch ? ' · ที่มืดให้เปิด <b>🔦 ไฟฉาย</b>' : '') + ' · ให้ QR อยู่กลางกรอบ';
        else hint();
      }
      function next() {
        if (done) return;
        if (video.requestVideoFrameCallback) video.requestVideoFrameCallback(function () { tick(); });
        else requestAnimationFrame(tick);
      }
      function tick() {
        if (done) return;
        var e = engines[n++ % engines.length];
        var src = e.src === 'video' ? video : e.src === 'full' ? grabFrame(video, true) : grabVariant(video, e.frames % 4);
        if (!src) { next(); return; }
        e.frames++;
        e.detect(src).then(function (text) {
          e.fails = 0;
          if (done) return;
          if (text) {
            e.hits++;
            if (cont()) { onCont(text); return; }
            stop(); closeModal(); onResult(text); return;
          }
          info(); lowLightTip(); next();
        }, function (err) {
          e.errors++; e.fails++; e.lastErr = (err && (err.message || err.name)) || String(err);
          // ผิดพลาดติดกัน 5 ครั้ง → เลิกใช้ตัวนี้ (ถ้ายังมีตัวอื่นเหลือ)
          if (e.fails >= 5 && engines.length > 1) engines.splice(engines.indexOf(e), 1);
          info(true); setTimeout(next, 50);
        });
      }
      // โหมดต่อเนื่อง: QR เดิมที่ยังอยู่หน้ากล้องไม่นับซ้ำ (ต้องหายไปจากกล้องอย่างน้อย 2.5 วินาที) · พักสั้นๆ หลังอ่านได้
      function onCont(text) {
        var now = Date.now();
        if (text === lastText && now - lastAt < 2500) { lastAt = now; setTimeout(next, 120); return; }
        lastText = text; lastAt = now;
        var r = opts.onEach(text);
        if (r) {
          log.unshift(r); if (log.length > 30) log.pop();
          if (r.cls === 'ok' || r.cls === 'warn') saved++;
          flash(r.cls === 'err' ? 'err' : r.cls === 'loc' ? 'loc' : 'ok');
          renderCont();
        }
        setTimeout(next, 700);
      }
      next();
    });
  }).catch(function (err) {
    cam.then(function (s) { s.getTracks().forEach(function (t) { t.stop(); }); }, function () {});
    stop();
    var name = err && err.name;
    var msg = name === 'NotAllowedError' ? 'ไม่ได้รับอนุญาตให้ใช้กล้อง — กดอนุญาตกล้องที่แถบที่อยู่ของเบราว์เซอร์แล้วลองใหม่'
      : name === 'NotFoundError' ? 'ไม่พบกล้องในเครื่องนี้'
      : 'เปิดกล้องไม่ได้: ' + ((err && (err.message || err.name)) || err);
    if ($('camHint')) $('camHint').textContent = msg; else toast(msg, 4000);
  });

  // กรอบเล็งกลางกล่องกล้อง + แปลงขนาดกรอบเป็นพิกเซลของภาพกล้อง (video ใช้ object-fit: cover → ภาพถูกขยายเท่ากันรอบจุดกลาง)
  function sizeFrame() {
    var f = $('camFrame'), wrap = video.parentNode; if (!f || !wrap) return;
    var W = wrap.clientWidth, H = wrap.clientHeight, vw = video.videoWidth, vh = video.videoHeight;
    var side = Math.round(Math.min(W, H) * CROP_RATIO);
    f.style.width = f.style.height = side + 'px';
    if (vw && vh && W && H) {
      var scale = Math.max(W / vw, H / vh);
      camCropSide = Math.min(Math.round(side / scale), vw, vh);
    }
  }
  camCropSide = 0; camLuma = -1;
  video.addEventListener('loadedmetadata', sizeFrame);
  video.addEventListener('resize', sizeFrame);
  window.addEventListener('resize', function onR() { if (done) { window.removeEventListener('resize', onR); return; } sizeFrame(); });
}

// ซูม / โฟกัสต่อเนื่อง / ไฟฉาย — แสดงเฉพาะที่เครื่องและเบราว์เซอร์รองรับ
function setupCamTools(track) {
  var box = $('camTools'); if (!box || !track || !track.getCapabilities) return;
  var caps = {};
  try { caps = track.getCapabilities() || {}; } catch (e) { return; }
  if (caps.focusMode && caps.focusMode.indexOf('continuous') >= 0) {
    track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] }).catch(function () {});
  }
  var html = '';
  var zooms = [];
  if (caps.zoom && caps.zoom.max > caps.zoom.min) {
    zooms = [1, 1.5, 2, 3].filter(function (z) { return z >= caps.zoom.min && z <= caps.zoom.max; });
    if (zooms.length > 1) html += zooms.map(function (z) { return '<button class="btn small" data-zoom="' + z + '">' + z + 'x</button>'; }).join('');
  }
  if (caps.torch) html += '<button class="btn small" id="camTorch">🔦 ไฟฉาย</button>';
  box.innerHTML = html;
  function setZoom(z) {
    track.applyConstraints({ advanced: [{ zoom: z }] }).then(function () {
      store('pda_cam_zoom', String(z));
      Array.prototype.forEach.call(box.querySelectorAll('[data-zoom]'), function (b) { b.classList.toggle('active', Number(b.getAttribute('data-zoom')) === z); });
    }, function () {});
  }
  if (zooms.length > 1) {
    Array.prototype.forEach.call(box.querySelectorAll('[data-zoom]'), function (b) { b.onclick = function () { setZoom(Number(b.getAttribute('data-zoom'))); }; });
    var saved = Number(store('pda_cam_zoom'));
    setZoom(zooms.indexOf(saved) >= 0 ? saved : (zooms.indexOf(1.5) >= 0 ? 1.5 : zooms[0]));
  }
  var torchOn = false;
  if ($('camTorch')) $('camTorch').onclick = function () {
    torchOn = !torchOn;
    track.applyConstraints({ advanced: [{ torch: torchOn }] }).catch(function () {});
    $('camTorch').classList.toggle('active', torchOn);
    if (torchOn) $('camTorch').classList.remove('pulse');
  };
}

// ======================= หน้ากรอกเอง =======================
var manualSrc = null; // QR ที่ใช้เติมฟอร์ม (ถ้ารหัส/Lot/Pkg ไม่ถูกแก้ จะใช้ QR เดิมเพื่อกันบันทึกซ้ำ)
var UNITS = ['EA', 'kg', 'm', 'roll', 'box', 'set'];
var NOTE_PRESETS = ['ไม่มี QR code', 'ไม่รู้จำนวน', 'งานตัวอย่าง'];
var NOTE_NOQTY = 'ไม่รู้จำนวน';
function manualNotePicks() {
  return Array.prototype.filter.call(document.querySelectorAll('#mfNoteList input:checked'), function (c) { return true; }).map(function (c) { return c.value; });
}
function manualNoteText() {
  var t = $('mfNote') ? $('mfNote').value.trim() : '';
  return manualNotePicks().concat(t ? [t] : []).join(', ');
}
function renderNoteSel() {
  var el = $('mfNoteSel'); if (!el) return;
  var p = manualNotePicks();
  el.className = p.length ? '' : 'muted';
  el.innerHTML = p.length ? p.map(function (n) { return '<span class="note-chip">' + esc(n) + '</span>'; }).join('') : 'เลือกหมายเหตุ (ได้หลายข้อ)';
  if ($('mfQty')) $('mfQty').placeholder = p.indexOf(NOTE_NOQTY) >= 0 ? 'เว้นว่างได้' : '';
}
function bindManualNote() {
  var dd = $('mfNoteDd'), list = $('mfNoteList');
  dd.onclick = function (e) { e.stopPropagation(); list.classList.toggle('hidden'); dd.classList.toggle('open', !list.classList.contains('hidden')); };
  list.addEventListener('click', function (e) { e.stopPropagation(); });
  list.addEventListener('change', renderNoteSel);
  document.addEventListener('click', function close() {
    if (!document.body.contains(list)) { document.removeEventListener('click', close); return; }
    list.classList.add('hidden'); dd.classList.remove('open');
  });
  renderNoteSel();
}

function renderManual() {
  $('main').innerHTML =
    '<section class="card-form">' +
      '<div class="sec-title"><span>กรอกข้อมูลเอง</span><button class="btn small" id="mfCam">📸 สแกนเติมข้อมูล</button></div>' +
      '<label>Location *</label><button class="btn loc-pick" id="mfLoc"></button>' +
      '<label>รหัสสินค้า *</label>' +
      '<div class="ac-wrap"><input id="mfPart" class="field" autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="พิมพ์รหัส / ชื่อ / Spec หรือสแกนป้าย">' +
        '<div id="mfSug" class="ac-list hidden" role="listbox"></div></div>' +
      '<div id="mfPartInfo" class="ac-info"></div>' +
      '<div class="grid2">' +
        '<div><label>Lot</label><input id="mfLot" class="field" autocomplete="off" spellcheck="false"></div>' +
        '<div><label>Package</label><input id="mfPkg" class="field" autocomplete="off" spellcheck="false"></div>' +
      '</div>' +
      '<div class="grid2">' +
        '<div><label>จำนวน *</label><input id="mfQty" class="field big-num" inputmode="decimal" autocomplete="off"></div>' +
        '<div><label>หน่วย</label><select id="mfUnit" class="field">' + UNITS.map(function (u) { return '<option>' + u + '</option>'; }).join('') + '</select></div>' +
      '</div>' +
      '<label>หมายเหตุ</label>' +
      '<div class="note-wrap"><button type="button" class="field note-dd" id="mfNoteDd" aria-haspopup="listbox"><span id="mfNoteSel" class="muted">เลือกหมายเหตุ (ได้หลายข้อ)</span><span class="note-caret">▾</span></button>' +
        '<div id="mfNoteList" class="note-list hidden" role="listbox" aria-multiselectable="true">' + NOTE_PRESETS.map(function (n) {
          return '<label class="note-opt"><input type="checkbox" value="' + esc(n) + '"> ' + esc(n) + '</label>';
        }).join('') + '</div></div>' +
      '<input id="mfNote" class="field" autocomplete="off" maxlength="150" placeholder="พิมพ์หมายเหตุเพิ่มเติม (ถ้ามี)">' +
      '<div class="actions"><button class="btn" id="mfClear">ล้าง</button><button class="btn primary save-btn" id="mfSave">💾 บันทึก</button></div>' +
    '</section>' +
    '<div id="msg"></div>' +
    '<div id="sync"></div>' +
    '<section><div class="sec-title"><span>รายการล่าสุด (เครื่องนี้)</span><span id="count" class="muted"></span></div>' +
    '<div id="recent"></div></section>';
  S.msg = null;
  renderManualLoc();
  $('mfLoc').onclick = openLocationPicker;
  $('mfCam').onclick = function () { openCameraScanner(fillManualFromScan); };
  var part = $('mfPart');
  part.addEventListener('keydown', function (e) {
    var sug = $('mfSug'), open = sug && !sug.classList.contains('hidden');
    if (open && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) { e.preventDefault(); moveSuggest(e.key === 'ArrowDown' ? 1 : -1); return; }
    if (e.key === 'Escape') { hideSuggest(); return; }
    if (e.key !== 'Enter') return;
    e.preventDefault();
    if (looksLikeScan(part.value)) { hideSuggest(); fillManualFromScan(part.value); return; }
    var act = open && sug.querySelector('.ac-item.active');
    if (act) { pickSuggest(act.getAttribute('data-code')); return; }
    hideSuggest(); $('mfQty').focus();
  });
  part.addEventListener('input', function () { showSuggest(part.value); updatePartInfo(); });
  part.addEventListener('focus', function () { if (part.value.trim().length >= 2) showSuggest(part.value); });
  part.addEventListener('blur', function () { setTimeout(hideSuggest, 200); });
  part.addEventListener('change', function () { if (looksLikeScan(part.value)) { hideSuggest(); fillManualFromScan(part.value); } updatePartInfo(); });
  $('mfQty').addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); saveManual(); } });
  $('mfClear').onclick = function () { clearManual(); part.focus(); };
  $('mfSave').onclick = saveManual;
  bindManualNote();
  renderMsg(); renderSync(); renderRecent();
}

function looksLikeScan(v) { v = String(v || ''); return v.indexOf('*') >= 0 || v.charAt(0) === '{' || /:\s*\S+\|/.test(v) || !!asLocation(v); }

function renderManualLoc() {
  var el = $('mfLoc'); if (!el) return;
  el.innerHTML = S.location ? '📍 <b>' + esc(S.location) + '</b> <span class="muted small">แตะเพื่อเปลี่ยน</span>' : '📍 เลือก Location';
  el.classList.toggle('warn', !S.location);
}

function setUnit(u) {
  var sel = $('mfUnit'); if (!sel || !u) return;
  if (!Array.prototype.some.call(sel.options, function (o) { return o.value === u; })) sel.appendChild(new Option(u, u));
  sel.value = u;
}

function fillManualFromScan(raw) {
  var chk = checkScan(raw);
  if (!chk.text) return;
  if (chk.error) { beep(false); setMsg('err', '❌ ' + esc(chk.error)); return; }
  var loc = asLocation(chk.text);
  if (loc) {
    setLocation(loc); beep(true);
    if (asLocation($('mfPart').value)) $('mfPart').value = '';
    setMsg('ok', '📍 Location: <b>' + esc(loc) + '</b>');
    return;
  }
  var p = parseQr(chk.text);
  $('mfPart').value = p.part_code; $('mfLot').value = p.lot_no; $('mfPkg').value = p.pkg_ref; updatePartInfo();
  $('mfQty').value = p.qty === '' ? '' : String(p.qty);
  setUnit(p.unit);
  manualSrc = { qr_raw: p.qr_raw, part_code: p.part_code, lot_no: p.lot_no, pkg_ref: p.pkg_ref };
  beep(true);
  setMsg('warn', 'เติมข้อมูลจาก QR แล้ว — ตรวจสอบ/แก้ไข แล้วกด <b>บันทึก</b>');
  var q = $('mfQty'); q.focus(); q.select();
}

function clearManual() {
  ['mfPart', 'mfLot', 'mfPkg', 'mfQty', 'mfNote'].forEach(function (id) { if ($(id)) $(id).value = ''; });
  Array.prototype.forEach.call(document.querySelectorAll('#mfNoteList input'), function (c) { c.checked = false; });
  renderNoteSel();
  manualSrc = null;
  hideSuggest(); updatePartInfo();
}

// ---------- เดารหัสสินค้าจาก BOM (หน้ากรอกเอง) ----------
// ลำดับ: รหัสที่เพิ่งใช้ในเครื่องนี้ → รหัสขึ้นต้นด้วยคำที่พิมพ์ → รหัสมีคำนั้น → ชื่อ / Spec มีคำนั้น
function suggestParts(q, max) {
  q = String(q || '').trim().toUpperCase(); if (q.length < 2 || !window.BOM) return [];
  var recent = [], seen = {};
  S.recent.forEach(function (r) { if (r.part_code && !seen[r.part_code]) { seen[r.part_code] = 1; recent.push(r.part_code); } });
  var tiers = [[], [], [], []];
  function score(code) {
    var b = window.BOM[code] || ['', ''], c = code.toUpperCase();
    if (c.indexOf(q) === 0) return 1;
    if (c.indexOf(q) > 0) return 2;
    if ((b[0] + ' ' + b[1]).toUpperCase().indexOf(q) >= 0) return 3;
    return 0;
  }
  recent.forEach(function (code) { if (window.BOM[code] && score(code)) tiers[0].push(code); });
  for (var code in window.BOM) {
    if (seen[code]) continue;
    var sc = score(code); if (sc) tiers[sc].push(code);
    if (tiers[1].length >= max * 6) break;
  }
  return tiers[0].concat(tiers[1].sort(), tiers[2].sort(), tiers[3]).slice(0, max);
}

function markQ(text, q) {
  var t = String(text || ''), i = t.toUpperCase().indexOf(String(q).trim().toUpperCase());
  if (!q || i < 0) return esc(t);
  return esc(t.slice(0, i)) + '<mark>' + esc(t.slice(i, i + q.trim().length)) + '</mark>' + esc(t.slice(i + q.trim().length));
}

function showSuggest(q) {
  var box = $('mfSug'); if (!box) return;
  if (looksLikeScan(q)) { hideSuggest(); return; }
  var list = suggestParts(q, 8);
  if (!list.length || (list.length === 1 && list[0] === q.trim().toUpperCase())) { hideSuggest(); return; }
  var used = {}; S.recent.forEach(function (r) { used[r.part_code] = 1; });
  box.innerHTML = list.map(function (code, i) {
    var b = window.BOM[code] || ['', ''];
    return '<button type="button" class="ac-item' + (i === 0 ? ' active' : '') + '" data-code="' + esc(code) + '">' +
      '<span class="ac-code">' + markQ(code, q) + (used[code] ? ' <span class="ac-recent">ใช้ล่าสุด</span>' : '') + '</span>' +
      (b[0] ? '<span class="ac-name">' + markQ(b[0], q) + '</span>' : '') +
      (b[1] ? '<span class="ac-spec">' + markQ(b[1], q) + '</span>' : '') + '</button>';
  }).join('');
  box.classList.remove('hidden');
  Array.prototype.forEach.call(box.querySelectorAll('.ac-item'), function (b) {
    b.onmousedown = function (e) { e.preventDefault(); }; // กันช่องหลุดโฟกัสก่อนกด
    b.onclick = function () { pickSuggest(b.getAttribute('data-code')); };
  });
}
function hideSuggest() { var box = $('mfSug'); if (box) { box.classList.add('hidden'); box.innerHTML = ''; } }
function moveSuggest(d) {
  var items = Array.prototype.slice.call(document.querySelectorAll('#mfSug .ac-item')); if (!items.length) return;
  var i = items.findIndex(function (x) { return x.classList.contains('active'); });
  i = (i + d + items.length) % items.length;
  items.forEach(function (x, k) { x.classList.toggle('active', k === i); });
  items[i].scrollIntoView({ block: 'nearest' });
}
function pickSuggest(code) {
  $('mfPart').value = code; hideSuggest(); updatePartInfo();
  ($('mfLot').value ? $('mfQty') : $('mfLot')).focus();
}
// ใต้ช่องรหัส: แสดงชื่อ / Spec ของรหัสที่กรอก หรือเตือนถ้าไม่พบใน BOM
function updatePartInfo() {
  var el = $('mfPartInfo'), inp = $('mfPart'); if (!el || !inp) return;
  var v = inp.value.trim().toUpperCase(), b = bomInfo(v);
  if (!v || looksLikeScan(v)) { el.innerHTML = ''; return; }
  el.innerHTML = b ? '<span class="ok">✓ ' + esc(b.name || '') + '</span>' + (b.spec ? ' <span class="bom-spec">' + esc(b.spec) + '</span>' : '')
    : (v.length >= 6 ? '<span class="warn-text">⚠ ไม่พบรหัสนี้ใน BOM — ตรวจสอบอีกครั้ง (บันทึกได้)</span>' : '');
}

function manualDirty() { return ['mfPart', 'mfLot', 'mfPkg', 'mfQty'].some(function (id) { return $(id) && $(id).value.trim(); }); }

function saveManual() {
  if (!S.user) { openUserModal(); return; }
  if (!S.location) { beep(false); toast('กรุณาเลือก Location'); openLocationPicker(); return; }
  var part = $('mfPart').value.trim().toUpperCase(), lot = $('mfLot').value.trim(), pkg = $('mfPkg').value.trim();
  var qty = parseQtyInput($('mfQty').value), unit = $('mfUnit').value;
  if (!part) { beep(false); toast('กรุณากรอกรหัสสินค้า'); $('mfPart').focus(); return; }
  var note = manualNoteText(), noQty = manualNotePicks().indexOf(NOTE_NOQTY) >= 0;
  if (qty === null && noQty && !$('mfQty').value.trim()) qty = '';
  if (qty === null) { beep(false); toast(noQty ? 'จำนวนต้องเป็นตัวเลข หรือเว้นว่าง' : 'กรุณากรอกจำนวนเป็นตัวเลข (ถ้าไม่รู้ ให้เลือกหมายเหตุ "ไม่รู้จำนวน")'); $('mfQty').focus(); return; }
  var id = uid();
  var fromQr = manualSrc && manualSrc.part_code.toUpperCase() === part && manualSrc.lot_no === lot && manualSrc.pkg_ref === pkg;
  var qr = fromQr ? manualSrc.qr_raw : ['MANUAL', part, lot, qty, pkg, id.slice(0, 8)].join('|');
  var dup = findSavedDuplicate(qr);
  if (dup) { beep(false); setMsg('err', '⚠ QR นี้บันทึกแล้วที่ <b>' + esc(dup.location) + '</b>'); return; }
  var item = {
    scan_id: id, scanned_at: new Date().toISOString(), location: S.location,
    qr_raw: qr, part_code: part, lot_no: lot, qty: qty, unit: unit, pkg_ref: pkg,
    scanned_by: S.user, device: S.device, status: 'pending', note: note
  };
  S.recent.unshift(item);
  saveRecent();
  clearManual();
  beep(true);
  setMsg('ok', '✔ บันทึก <b>' + esc(part) + '</b> × ' + esc(qty === '' ? 'ไม่รู้จำนวน' : fmtQty(qty, unit)) + ' → <b>' + esc(item.location) + '</b>', item.scan_id);
  refreshScanParts();
  flush();
  $('mfPart').focus();
}

// ======================= ผัง Location =======================
// แสดงทุก Location ตามแถวชั้นวาง (โซน → แถว → ช่อง 01–16 × ชั้น A/B) ว่าช่องไหนสแกนของเข้าไปแล้ว
var MAP = { data: null, loading: false, zone: store('pda_map_zone') || '', mode: 'all', err: '', more: false, trail: store('pda_map_trail') !== '0',
  from: store('pda_map_from') || '', to: store('pda_map_to') || '' };
MAP.items = storeJson('pda_map_items') || []; MAP.itemsSig = MAP.items.length ? (store('pda_map_sig') || '') : '';
MAP.q = ''; MAP.findAll = false;
var TRAIL_N = 10;
MAP.live = store('pda_map_live') !== '0'; MAP.loadedAt = 0; MAP.fresh = {};
var MAP_LIVE_MS = 30000;
var MAP_EV = { create: '🟢 บันทึก', qty: '🔵 แก้ยอด', move: '🟠 ย้าย', move_out: '🟠 ย้ายออก', delete: '🔴 ลบ', out: '📤 เอาออก', out_part: '📤 เอาออกบางส่วน', photo_add: '🖼 แนบรูป', photo_delete: '🗑 ลบรูป' };
var RECENT_MIN = 60; // เคลื่อนไหวภายในกี่นาที = ติดจุดส้มในผัง

// เวลาจากชีต (เวลาไทย 'yyyy-MM-dd HH:mm:ss') → ms
function bkkMs(at) { var t = Date.parse(String(at).replace(' ', 'T') + '+07:00'); return isNaN(t) ? 0 : t; }
function agoText(at) {
  var t = bkkMs(at); if (!t) return '';
  var m = Math.round((Date.now() - t) / 60000);
  if (m < 1) return 'เมื่อสักครู่';
  if (m < 60) return m + ' นาทีที่แล้ว';
  if (m < 24 * 60) return Math.floor(m / 60) + ' ชม. ที่แล้ว';
  return fmtWhen(at);
}

function mapLayout() {
  // { CO: { '01': { '01': ['A','B'], ... } } }
  if (mapLayout.v) return mapLayout.v;
  var z = {};
  (window.LOCATIONS || []).forEach(function (code) {
    var m = String(code).match(/^([A-Z]+)-(\d+)-(\d+)([A-Z])$/); if (!m) return;
    var rack = ((z[m[1]] = z[m[1]] || {})[m[2]] = z[m[1]][m[2]] || {});
    (rack[m[3]] = rack[m[3]] || []).push(m[4]);
  });
  mapLayout.v = z;
  return z;
}

// จอคอม: แสดง CO (ซ้าย) คู่กับ CQ (ขวา) ในหน้าเดียว
var MAP_PAIR = ['CO', 'CQ'];
var MAP_WIDE_MQ = window.matchMedia ? window.matchMedia('(min-width: 1000px)') : null;
function mapWide() { return !!(MAP_WIDE_MQ && MAP_WIDE_MQ.matches); }
function mapPairOn() { var l = mapLayout(); return mapWide() && MAP_PAIR.every(function (z) { return l[z]; }); }
function mapShown() { return mapPairOn() && MAP_PAIR.indexOf(MAP.zone) >= 0 ? MAP_PAIR : [MAP.zone]; }
function mapZoneShown(z) { return mapShown().indexOf(z) >= 0; }
if (MAP_WIDE_MQ) {
  var onWideChange = function () { if (isMapView()) renderMap(); };
  if (MAP_WIDE_MQ.addEventListener) MAP_WIDE_MQ.addEventListener('change', onWideChange); else if (MAP_WIDE_MQ.addListener) MAP_WIDE_MQ.addListener(onWideChange);
}

function renderMap() {
  var zones = Object.keys(mapLayout()).sort(); // เรียงโซนตามตัวอักษร (CA … CJ, CO, CP, CQ)
  if (!MAP.zone || zones.indexOf(MAP.zone) < 0) MAP.zone = (S.location && zones.indexOf(S.location.split('-')[0]) >= 0) ? S.location.split('-')[0] : zones[0];
  store('pda_map_zone', MAP.zone);
  var KDV = S.view === 'kd';
  $('main').innerHTML =
    '<section class="map-top">' +
      '<div id="mapSum" class="map-sum muted small">กำลังโหลด…</div>' +
      '<div class="map-bar">' +
        '<div class="seg">' + zones.filter(function (z) { return !(mapPairOn() && z === MAP_PAIR[1]); }).map(function (z) {
          var pair = mapPairOn() && z === MAP_PAIR[0];
          var act = pair ? MAP_PAIR.indexOf(MAP.zone) >= 0 : z === MAP.zone;
          return '<button data-zone="' + z + '" class="' + (act ? 'active' : '') + '">' + (pair ? MAP_PAIR.join(' | ') : z) + '</button>';
        }).join('') + '</div>' +
        (KDV ? '' : '<div class="seg">' +
          MAP_MODES.map(function (o) { return '<button data-mode="' + o[0] + '" class="' + (MAP.mode === o[0] ? 'active' : '') + '">' + o[1] + '</button>'; }).join('') +
        '</div>') +
        (!KDV && MAP.mode === 'custom' ? '<div class="kdm-dates map-dates"><label>ตั้งแต่ <input type="date" id="mapFrom" class="field" value="' + esc(MAP.from) + '" max="' + workDay() + '"></label>' +
          '<label>ถึง <input type="date" id="mapTo" class="field" value="' + esc(MAP.to) + '" max="' + workDay() + '"></label></div>' : '') +
        '<button class="btn small live-btn' + (MAP.live ? ' active' : '') + '" id="mapLive" title="โหลดผังใหม่เองทุก 30 วินาที (เฉพาะตอนเปิดหน้าผังอยู่)">' +
          '<i class="live-dot"></i>อัปเดตอัตโนมัติ</button><span id="mapAge" class="muted small map-age"></span>' +
        (KDV ? '' : '<button class="btn small' + (MAP.trail ? ' active' : '') + '" id="mapTrail" title="แสดงลูกศร 10 Action ล่าสุด (บันทึก / ย้าย / แก้ยอด / ลบ)">➜ ' + TRAIL_N + ' Action ล่าสุด</button>') +
        '<button class="btn small" id="mapReload">🔄</button>' +
      '</div>' +
      (KDV ? kdTopHtml() :
      '<div class="map-legend small"><span><i class="lg empty"></i>ว่าง</span><span><i class="lg used"></i>มีของ</span>' +
        '<span><i class="lg today"></i>สแกน/แก้ ' + esc(mapRangeLabel()) + '</span><span><i class="lg cur"></i>Location ปัจจุบัน</span>' +
        '<span><i class="lg hot"></i>เคลื่อนไหวใน 1 ชม.</span><span><i class="lg latest"></i>ล่าสุด</span>' +
        (MAP.trail ? '<span><i class="lg-trail"></i><i class="trail-badge">1</i>' + TRAIL_N + ' Action ล่าสุด เรียงตามเวลา (1 = ล่าสุด, จาง = เก่ากว่า)</span><span><i class="lg-move"></i>ย้ายของ: ต้นทาง → ปลายทาง</span>' : '') + '</div>' +
      '<div class="map-search ac-wrap"><input id="mapQ" class="field" placeholder="🔍 ค้นหาของ: Lot / รหัส / ชื่อ / Location (พิมพ์บางส่วนได้)" autocomplete="off" value="' + esc(MAP.q) + '">' +
        '<button type="button" id="mapQx" class="map-qx' + (MAP.q ? '' : ' hidden') + '" title="ล้างการค้นหา">✕</button>' +
        '<div id="mapQSug" class="ac-list hidden"></div></div>' +
      '<div id="mapFind"></div>' +
      '<div id="rpPanel"></div>') +
    '</section>' +
    (KDV ? '<div id="mapOut"></div>' : '<div id="mapRecent"></div><div id="mapOut"></div><div id="rpDock" class="rp-dock"></div>');
  Array.prototype.forEach.call(document.querySelectorAll('[data-zone]'), function (b) {
    b.onclick = function () { MAP.zone = b.getAttribute('data-zone'); renderMap(); };
  });
  Array.prototype.forEach.call(document.querySelectorAll('[data-mode]'), function (b) {
    b.onclick = function () {
      MAP.mode = b.getAttribute('data-mode');
      if (MAP.mode === 'custom' && !MAP.from) { MAP.from = MAP.to = workDay(); }
      renderMap();
    };
  });
  ['mapFrom', 'mapTo'].forEach(function (id) {
    var e = $(id); if (!e) return;
    e.onchange = function () {
      if (!this.value) return;
      if (id === 'mapFrom') { MAP.from = this.value; if (!MAP.to || MAP.to < MAP.from) MAP.to = MAP.from; }
      else { MAP.to = this.value; if (!MAP.from || MAP.from > MAP.to) MAP.from = MAP.to; }
      store('pda_map_from', MAP.from); store('pda_map_to', MAP.to); renderMap();
    };
  });
  $('mapReload').onclick = function () { loadMap(true); if (KDV) { loadKd(true); loadCount(); } };
  $('mapLive').onclick = function () {
    MAP.live = !MAP.live; store('pda_map_live', MAP.live ? '1' : '0');
    this.classList.toggle('active', MAP.live); mapAgeTick();
    if (MAP.live && Date.now() - MAP.loadedAt > MAP_LIVE_MS) loadMap();
    toast(MAP.live ? 'เปิดอัปเดตอัตโนมัติ (ทุก 30 วินาที)' : 'ปิดอัปเดตอัตโนมัติ');
  };
  if ($('mapTrail')) $('mapTrail').onclick = function () { MAP.trail = !MAP.trail; store('pda_map_trail', MAP.trail ? '1' : '0'); renderMap(); };
  if (KDV) { bindKdTop(); kdCheck(); loadCount(); }
  bindMapSearch();
  renderRpPanel();
  if (MAP.data) renderMapGrid();
  loadMap();
}

function loadMap(manual) {
  if (MAP.loading) return;
  if (!apiUrl()) { MAP.err = 'ยังไม่ได้ตั้งค่า API URL (กด ⚙)'; renderMapGrid(); return; }
  MAP.loading = true;
  if ($('mapReload')) $('mapReload').disabled = true;
  api('getLocationMap', { sig: MAP.itemsSig }).then(function (d) {
    if (d.items) { MAP.items = d.items; MAP.itemsSig = d.sig || ''; storeJson('pda_map_items', d.items); store('pda_map_sig', MAP.itemsSig); }
    // ช่องที่มีความเคลื่อนไหวใหม่ตั้งแต่โหลดครั้งก่อน → กระพริบให้เห็น
    var old = MAP.data && MAP.data.map, fresh = {};
    if (old) Object.keys(d.map || {}).forEach(function (code) {
      var a = old[code], b = d.map[code];
      if (b && b.last && (!a || a.last !== b.last || a.n !== b.n)) fresh[code] = 1;
    });
    MAP.fresh = fresh;
    MAP.loading = false; MAP.data = d; MAP.err = ''; S.online = true; MAP.loadedAt = Date.now();
    if (isMapView()) {
      renderMapGrid(); MAP.fresh = {};
      var nf = Object.keys(fresh).length;
      if (manual) toast('อัปเดตผังแล้ว'); else if (nf) toast('มีความเคลื่อนไหวใหม่ ' + nf + ' ช่อง', 2000);
    }
    mapAgeTick();
  }, function (err) {
    MAP.loading = false; MAP.err = err.message;
    if (err.network) S.online = false;
    if (isMapView()) renderMapGrid();
  });
}

// อัปเดตอัตโนมัติ: ทุก 30 วินาที เฉพาะตอนอยู่หน้าผัง + หน้าจอไม่ได้ซ่อน + ไม่ได้เล่นย้อนหลัง
function mapLiveDue() {
  return MAP.live && isMapView() && document.visibilityState !== 'hidden' && !RP.open && !MAP.loading &&
    $('modal').classList.contains('hidden') && Date.now() - MAP.loadedAt >= MAP_LIVE_MS;
}
function mapAgeTick() {
  var el = $('mapAge'); if (!el) return;
  if (!MAP.loadedAt) { el.textContent = ''; return; }
  var sec = Math.round((Date.now() - MAP.loadedAt) / 1000);
  el.textContent = 'อัปเดต ' + (sec < 5 ? 'เมื่อสักครู่' : sec < 60 ? sec + ' วิ.ที่แล้ว' : Math.floor(sec / 60) + ' นาทีที่แล้ว') +
    (MAP.live && RP.open ? ' · หยุดระหว่างเล่นย้อนหลัง' : '');
}
setInterval(function () {
  if (!isMapView()) return;
  mapAgeTick();
  if (mapLiveDue()) { loadMap(); if (S.view === 'kd') loadCount(); }
}, 5000);
// กลับมาเปิดหน้าจอ (ปลดล็อกมือถือ / สลับแท็บกลับมา) → โหลดทันทีถ้าข้อมูลเก่าเกิน 30 วินาที
document.addEventListener('visibilitychange', function () { if (mapLiveDue()) loadMap(); });

// ===== ค้นหาบนผัง: "ของอยู่ไหน" + FIFO (ของเข้าก่อน = ลำดับ 1) =====
// ค้นจากรายการกล่องที่โหลดมากับผัง (อัปเดตทุกรอบ 30 วินาที) + รายการรอส่งในเครื่อง → ผลขึ้นทันที
// เวลา ISO (ในเครื่อง) → 'yyyy-MM-dd HH:mm' เวลาไทย เหมือนในชีต
function bkkMin(at) {
  at = String(at || '');
  if (at.indexOf('T') < 0) return at.slice(0, 16);
  var t = Date.parse(at); if (isNaN(t)) return '';
  var d = new Date(t + 7 * 3600000);
  return d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate()) + ' ' + pad(d.getUTCHours()) + ':' + pad(d.getUTCMinutes());
}
function mapAllItems() {
  var seen = {};
  var out = MAP.items.map(function (r) {
    seen[r[0] + '|' + r[1] + '|' + r[2] + '|' + r[3]] = 1;
    return { loc: r[0], part: String(r[1] || ''), lot: String(r[2] || ''), at: r[3], qty: r[4], unit: r[5], by: String(r[6] || ''), ed: String(r[7] || '') };
  });
  // รายการรอส่ง + ที่เครื่องนี้เพิ่งส่งขึ้นไปแต่ผังยังไม่ได้โหลดใหม่
  S.recent.forEach(function (r) {
    if (!r.location || (r.status !== 'pending' && r.status !== 'saved')) return;
    var part = String(r.part_code || r.qr_raw || ''), lot = String(r.lot_no || ''), at = bkkMin(r.scanned_at);
    if (r.status === 'saved' && seen[r.location + '|' + part + '|' + lot + '|' + at]) return;
    if (r.status === 'saved' && !MAP.items.length) return;
    out.push({ loc: r.location, part: part, lot: lot, at: at, qty: r.qty, unit: r.unit, by: String(r.scanned_by || ''), pending: r.status === 'pending' });
  });
  return out;
}
function mapIsLocQ(q) { return /^[A-Z]{2}-?\d/.test(q) || /^[A-Z]{2}-/.test(q); }
function mapFind() {
  var q = String(MAP.q || '').trim().toUpperCase(); if (!q) return null;
  var hits = [];
  if (mapIsLocQ(q)) {
    // CO1 / CO-1 → CO-01 · CO12 → CO-12 (ชั้นวางเป็นเลข 2 หลัก)
    var qq = q.replace(/^([A-Z]{2})-?(\d)(?!\d)/, '$1-0$2').replace(/^([A-Z]{2})(\d)/, '$1-$2');
    var codes = (window.LOCATIONS || []).filter(function (c) { return c.indexOf(qq) === 0; });
    var set = {}; codes.forEach(function (c) { set[c] = 1; });
    hits = mapAllItems().filter(function (it) { return set[it.loc]; });
    var res = mapFindGroup(hits);
    codes.forEach(function (c) { if (!res.cells[c]) res.cells[c] = { n: 0, rank: 99, items: [] }; });
    res.locMode = true; res.locCount = codes.length;
    return res;
  }
  hits = mapAllItems().filter(function (it) {
    if (it.lot.toUpperCase().indexOf(q) >= 0 || it.part.toUpperCase().indexOf(q) >= 0) return true;
    var b = bomInfo(it.part);
    return !!(b && ((b.name || '').toUpperCase().indexOf(q) >= 0 || (b.spec || '').toUpperCase().indexOf(q) >= 0));
  });
  return mapFindGroup(hits);
}
// รวมผลตามช่อง · เรียงช่องตามกล่องที่เข้าเก่าสุดก่อน (FIFO)
function mapFindGroup(hits) {
  var cells = {}, list = [];
  hits.forEach(function (it) {
    var c = cells[it.loc];
    if (!c) { c = cells[it.loc] = { loc: it.loc, n: 0, items: [], oldest: it.at || '9' }; list.push(c); }
    c.n++; c.items.push(it);
    if ((it.at || '9') < c.oldest) c.oldest = it.at || '9';
  });
  list.sort(function (a, b) { return a.oldest < b.oldest ? -1 : a.oldest > b.oldest ? 1 : a.loc < b.loc ? -1 : 1; });
  list.forEach(function (c, i) {
    c.rank = i + 1;
    c.items.sort(function (a, b) { return (a.at || '9') < (b.at || '9') ? -1 : 1; });
  });
  var zones = {};
  list.forEach(function (c) { var z = c.loc.split('-')[0]; zones[z] = (zones[z] || 0) + c.n; });
  return { cells: cells, list: list, total: hits.length, zones: zones };
}
function renderMapFind(find) {
  var el = $('mapFind'); if (!el) return;
  var top = document.querySelector('.map-top'); if (top) top.classList.toggle('tall', !!find);
  if ($('mapQx')) $('mapQx').classList.toggle('hidden', !MAP.q);
  if (!find) { el.innerHTML = ''; return; }
  var q = MAP.q.trim();
  if (!find.list.length) {
    el.innerHTML = '<div class="find-box"><div class="find-sum">' + (find.locMode
      ? 'Location <b>' + esc(q.toUpperCase()) + '</b>: ' + (find.locCount ? find.locCount + ' ช่อง · ว่างทั้งหมด' : 'ไม่พบ Location นี้')
      : 'ไม่พบ "<b>' + esc(q) + '</b>" ในคลัง') + '</div></div>';
    return;
  }
  var zs = Object.keys(find.zones).sort();
  var shownCells = MAP.findAll ? find.list : find.list.slice(0, 8);
  el._html = null; el.innerHTML = '<div class="find-box">' +
    '<div class="find-sum">พบ <b>' + find.total + '</b> กล่อง ใน <b>' + find.list.length + '</b> ช่อง' +
      (zs.length > 1 || !mapZoneShown(zs[0]) ? ' · ' + zs.map(function (z) {
        return '<button type="button" class="find-zone' + (mapZoneShown(z) ? ' on' : '') + '" data-fz="' + z + '">' + esc(z) + ' ' + find.zones[z] + '</button>';
      }).join('') : '') + '</div>' +
    (find.locMode ? '' : '<div class="muted small">เรียงตาม FIFO: <i class="fifo-badge first inline">1</i> = ของเข้าก่อน ควรหยิบก่อน</div>') +
    '<div class="find-list">' + shownCells.map(function (c) {
      var it = c.items[0], b = bomInfo(it.part) || {}, lots = {};
      c.items.forEach(function (x) { if (x.lot) lots[x.lot] = 1; });
      var lotList = Object.keys(lots);
      return '<button type="button" class="find-item" data-fc="' + esc(c.loc) + '">' +
        (find.locMode ? '' : '<i class="fifo-badge' + (c.rank === 1 ? ' first' : '') + ' inline">' + c.rank + '</i>') +
        '<span class="find-main"><span class="find-top"><span class="loc-pill">' + esc(c.loc) + '</span> <b>' + c.n + '</b> กล่อง' +
          (c.items.some(function (x) { return x.pending; }) ? ' <span class="tag pending">รอส่ง</span>' : '') + '</span>' +
        '<span class="find-sub">' + markQ(it.part, q) + (b.name ? ' · ' + markQ(b.name, q) : '') +
          (lotList.length ? ' · Lot ' + lotList.slice(0, 2).map(function (l) { return markQ(l, q); }).join(', ') + (lotList.length > 2 ? ' +' + (lotList.length - 2) : '') : '') + '</span>' +
        '<span class="find-sub muted">เข้า ' + esc(fmtWhen(it.at)) + '</span></span></button>';
    }).join('') + '</div>' +
    (find.list.length > 8 ? '<button type="button" class="btn small" id="findMore">' + (MAP.findAll ? 'ย่อ' : 'ดูทั้งหมด ' + find.list.length + ' ช่อง') + '</button>' : '') +
  '</div>';
  Array.prototype.forEach.call(el.querySelectorAll('[data-fz]'), function (b) {
    b.onclick = function () { MAP.zone = b.getAttribute('data-fz'); renderMap(); };
  });
  Array.prototype.forEach.call(el.querySelectorAll('[data-fc]'), function (b) {
    b.onclick = function () { mapGotoCell(b.getAttribute('data-fc')); };
  });
  if ($('findMore')) $('findMore').onclick = function () { MAP.findAll = !MAP.findAll; renderMapGrid(); };
}
function mapGotoCell(code) {
  var z = code.split('-')[0];
  if (!mapZoneShown(z)) { MAP.zone = z; renderMap(); }
  setTimeout(function () {
    var c = document.querySelector('[data-cell="' + code + '"]'); if (!c) return;
    c.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'center' });
    c.classList.remove('fresh'); void c.offsetWidth; c.classList.add('fresh');
  }, 60);
}
// แนะนำตอนพิมพ์: Lot / รหัส ที่มีอยู่ในคลังจริง (พร้อมจำนวนกล่อง) — prefix ก่อน แล้วค่อยที่มีคำอยู่ข้างใน
function mapSuggest(q) {
  q = String(q || '').trim().toUpperCase(); if (!q || mapIsLocQ(q)) return [];
  var lots = {}, parts = {};
  mapAllItems().forEach(function (it) {
    if (it.lot) { var l = lots[it.lot] || (lots[it.lot] = { kind: 'lot', value: it.lot, part: it.part, n: 0 }); l.n++; }
    if (it.part) { var p = parts[it.part] || (parts[it.part] = { kind: 'part', value: it.part, n: 0 }); p.n++; }
  });
  function pick(obj, max, alsoName) {
    var pre = [], mid = [];
    Object.keys(obj).forEach(function (k) {
      var i = k.toUpperCase().indexOf(q);
      if (i === 0) pre.push(obj[k]);
      else if (i > 0) mid.push(obj[k]);
      else if (alsoName) { var b = bomInfo(k); if (b && ((b.name || '').toUpperCase().indexOf(q) >= 0 || (b.spec || '').toUpperCase().indexOf(q) >= 0)) mid.push(obj[k]); }
    });
    return pre.concat(mid).slice(0, max);
  }
  var L = pick(lots, 6, false), P = pick(parts, L.length >= 4 ? 3 : 6, true);
  return L.concat(P);
}
function bindMapSearch() {
  var inp = $('mapQ'), box = $('mapQSug'), timer = 0; if (!inp) return;
  function hide() { box.classList.add('hidden'); box.innerHTML = ''; }
  function apply(v) {
    MAP.q = v; MAP.findAll = false;
    renderMapGrid();
    // ผลอยู่โซนอื่นทั้งหมด → สลับไปโซนแรกที่เจอ
    var f = mapFind();
    if (f && f.list.length && !f.list.some(function (c) { return mapZoneShown(c.loc.split('-')[0]); })) { MAP.zone = f.list[0].loc.split('-')[0]; renderMap(); }
  }
  function show() {
    var list = mapSuggest(inp.value), q = inp.value.trim();
    if (!list.length || (list.length === 1 && list[0].value.toUpperCase() === q.toUpperCase())) { hide(); return; }
    box.innerHTML = list.map(function (it) {
      var b = bomInfo(it.kind === 'lot' ? it.part : it.value) || {};
      return '<button type="button" class="ac-item" data-v="' + esc(it.value) + '">' +
        '<span class="ac-code"><span class="ac-kind' + (it.kind === 'part' ? ' part' : '') + '">' + (it.kind === 'lot' ? 'Lot' : 'รหัส') + '</span> ' + markQ(it.value, q) + '</span>' +
        '<span class="ac-name">' + (it.kind === 'lot' ? esc(it.part || '') + (b.name ? ' · ' : '') : '') + (b.name ? markQ(b.name, q) : '') + ' · ' + it.n + ' กล่อง</span></button>';
    }).join('');
    box.classList.remove('hidden');
    Array.prototype.forEach.call(box.querySelectorAll('.ac-item'), function (b) {
      b.onmousedown = function (e) { e.preventDefault(); };
      b.onclick = function () { inp.value = b.getAttribute('data-v'); hide(); apply(inp.value); inp.blur(); };
    });
  }
  inp.addEventListener('input', function () {
    show(); clearTimeout(timer);
    timer = setTimeout(function () { apply(inp.value); }, 200);
  });
  inp.addEventListener('focus', function () { if (inp.value.trim()) show(); });
  inp.addEventListener('blur', function () { setTimeout(hide, 150); });
  inp.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') { e.preventDefault(); hide(); clearTimeout(timer); apply(inp.value); inp.blur(); }
    else if (e.key === 'Escape') { hide(); inp.value = ''; apply(''); }
  });
  $('mapQx').onclick = function () { inp.value = ''; hide(); apply(''); };
}

// รายการในเครื่องที่ยังไม่ได้ส่งขึ้นเซิร์ฟเวอร์ → นับรวมในผังด้วย
function mapPendingByLoc() {
  var out = {};
  S.recent.forEach(function (r) { if (r.status === 'pending' && r.location) out[r.location] = (out[r.location] || 0) + 1; });
  return out;
}

// ช่วงวันบนผัง: ทั้งหมด / วันนี้ / เมื่อวาน / 7 วัน / เลือกวัน (วันทำงานตัด 08:00)
var MAP_MODES = [['all', 'ทั้งหมด'], ['today', 'วันนี้'], ['yday', 'เมื่อวาน'], ['7d', '7 วัน'], ['custom', '📅 เลือกวัน']];
function mapRange() {
  var t = workDay(), day = 86400000;
  if (MAP.mode === 'today') return { from: t, to: t };
  if (MAP.mode === 'yday') { var y = workDay(Date.now() - day); return { from: y, to: y }; }
  if (MAP.mode === '7d') return { from: workDay(Date.now() - 6 * day), to: t };
  if (MAP.mode === 'custom' && MAP.from) return { from: MAP.from, to: MAP.to || MAP.from };
  return null;
}
function mapRangeLabel() {
  var r = mapRange();
  if (!r || MAP.mode === 'today') return 'วันนี้';
  if (MAP.mode === 'yday') return 'เมื่อวาน';
  if (MAP.mode === '7d') return '7 วัน';
  return r.from === r.to ? fmtDay(r.from) : fmtDay(r.from) + ' – ' + fmtDay(r.to);
}
function fmtDay(d) { var m = /^(\d{4})-(\d\d)-(\d\d)/.exec(d || ''); return m ? Number(m[3]) + '/' + Number(m[2]) + '/' + String(Number(m[1]) + 543).slice(2) : d; }
// ของที่ยังอยู่ในช่อง ซึ่งสแกน/แก้ล่าสุดในช่วงที่เลือก → { loc: จำนวนกล่อง }
function mapRangeCounts(r) {
  var out = {};
  mapAllItems().forEach(function (it) {
    var at = it.ed && it.ed > String(it.at) ? it.ed : it.at, d = workShiftDate(at);
    if (d && d >= r.from && d <= r.to) out[it.loc] = (out[it.loc] || 0) + 1;
  });
  return out;
}
function renderMapGrid() {
  var out = $('mapOut'); if (!out) return;
  if ($('mapReload')) $('mapReload').disabled = MAP.loading;
  if (!MAP.data) {
    out.innerHTML = MAP.err ? '<div class="msg err">' + esc(MAP.err) + '</div>' : '<div class="center muted pad">กำลังโหลดผัง…</div>';
    if ($('mapSum')) $('mapSum').textContent = '';
    return;
  }
  var map = MAP.data.map || {}, pend = mapPendingByLoc(), lay = mapLayout();
  var rng = S.view === 'kd' ? null : mapRange(), rc = rng && MAP.mode !== 'today' ? mapRangeCounts(rng) : null;
  function info(code) {
    var m = map[code] || { n: 0, today: 0 }, p = pend[code] || 0;
    return { n: m.n + p, today: rc ? (rc[code] || 0) : m.today + p, last: m.last, by: m.by, ev: m.ev };
  }
  renderMapRecent();
  var latestLoc = (MAP.data.recent && MAP.data.recent[0]) ? (MAP.data.recent[0].to || MAP.data.recent[0].from) : '';
  var hotSince = Date.now() - RECENT_MIN * 60000;
  var KDV = S.view === 'kd', kdx = KDV ? kdCompute() : null;
  if (kdx) kdx.moved = kdmLatestSet();
  var find = KDV ? null : mapFind(); // ผลค้นหา (null = ไม่ได้ค้นหา)
  renderMapFind(find);
  // สรุปทั้งคลัง + โซนนี้
  var shown = mapShown();
  var all = 0, used = 0, usedToday = 0, zAll = 0, zUsed = 0, zToday = 0;
  (window.LOCATIONS || []).forEach(function (c) {
    var i = info(c), inZone = mapZoneShown(c.split('-')[0]);
    all++; if (i.n) used++; if (i.today) usedToday++;
    if (inZone) { zAll++; if (i.n) zUsed++; if (i.today) zToday++; }
  });
  if (KDV) renderKdSummary(kdx); else $('mapSum').innerHTML = 'ทั้งคลัง: มีของ <b>' + used + '</b> / ' + all + ' Location · ' + esc(mapRangeLabel()) + ' <b>' + usedToday + '</b>' +
    ' &nbsp;|&nbsp; โซน ' + esc(shown.join(' + ')) + ': <b>' + zUsed + '</b> / ' + zAll + ' · ' + esc(mapRangeLabel()) + ' <b>' + zToday + '</b>' +
    (MAP.err ? ' <span class="err-text">(อัปเดตไม่ได้: ' + esc(MAP.err) + ')</span>' : '');

  function zoneHtml(zone) {
  var racks = lay[zone] || {};
  return Object.keys(racks).sort().map(function (rk) {
    var bays = Object.keys(racks[rk]).sort();
    var levels = [];
    bays.forEach(function (b) { racks[rk][b].forEach(function (l) { if (levels.indexOf(l) < 0) levels.push(l); }); });
    levels.sort();
    var rUsed = 0, rAll = 0;
    var rows = levels.map(function (lv) {
      return '<tr><th class="lv">' + lv + '</th>' + bays.map(function (b) {
        if (racks[rk][b].indexOf(lv) < 0) return '<td></td>';
        var code = zone + '-' + rk + '-' + b + lv, i = info(code);
        rAll++; if (i.n) rUsed++;
        if (KDV) return kdCellHtml(code, kdx);
        var show = rng ? i.today : i.n;
        var cls = !show ? 'empty' : (i.today ? 'today' : 'used');
        if (code === S.location) cls += ' cur';
        if (i.last && bkkMs(i.last) >= hotSince) cls += ' hot';
        if (code === latestLoc) cls += ' latest';
        if (MAP.fresh[code]) cls += ' fresh';
        var fc = find && find.cells[code];
        if (find) cls += fc ? ' hit' : ' dim';
        return '<td><button class="cell ' + cls + '" data-cell="' + code + '" title="' + code + (fc ? ' · พบ ' + fc.n + ' กล่อง · FIFO ลำดับ ' + fc.rank : '') + (i.last ? ' · ล่าสุด ' + esc(i.last) : '') + '">' +
          (fc ? (fc.n > 1 ? fc.n : '') + (fc.rank <= 20 && !find.locMode ? '<i class="fifo-badge' + (fc.rank === 1 ? ' first' : '') + '">' + fc.rank + '</i>' : '') : (show > 1 ? show : '')) + '</button></td>';
      }).join('') + '</tr>';
    }).join('');
    return '<div class="rack"><div class="rack-head"><b>' + esc(zone + '-' + rk) + '</b><span class="muted small">' + rUsed + ' / ' + rAll + '</span></div>' +
      '<div class="rack-scroll"><table class="rack-grid"><thead><tr><th></th>' +
      bays.map(function (b) { return '<th>' + Number(b) + '</th>'; }).join('') + '</tr></thead><tbody>' + rows + '</tbody></table></div></div>';
  }).join('');
  }
  out.classList.toggle('pair', shown.length > 1);
  out.classList.toggle('stack', shown.length === 1 && shown[0] === 'CP'); // CP = ชั้นซ้อนกันขึ้นไป → เรียงแนวตั้งแถวเดียว
  // เก็บตำแหน่งเลื่อนแนวนอนของแต่ละแถว (มือถือ) ไว้ เพื่อไม่ให้เด้งกลับตอนอัปเดตอัตโนมัติ
  var keepScroll = {};
  Array.prototype.forEach.call(out.querySelectorAll('.rack-scroll'), function (el, i) { if (el.scrollLeft) keepScroll[i] = el.scrollLeft; });
  out.innerHTML = (shown.length > 1 ? shown.map(function (z) {
    return '<div class="zone-col"><div class="zone-head">โซน ' + esc(z) + '</div>' + zoneHtml(z) + '</div>';
  }).join('') : zoneHtml(MAP.zone)) + (KDV ? '<p class="muted small center">ตัวเลขในช่อง: ⚪ = จำนวนรายการใน Kingdee · 🟡 = จำนวนรายการที่ไม่ตรง · 🟣 = จำนวนรายการที่เกิน · แตะช่องเพื่อดูตารางเทียบ</p>'
    : '<p class="muted small center">ตัวเลขในช่อง = จำนวนกล่อง (ถ้ามากกว่า 1) · แตะช่องเพื่อดูของในช่องนั้น</p>');
  Array.prototype.forEach.call(out.querySelectorAll('.rack-scroll'), function (el, i) { if (keepScroll[i]) el.scrollLeft = keepScroll[i]; });
  Array.prototype.forEach.call(out.querySelectorAll('[data-cell]'), function (b) {
    b.onclick = function () { (KDV ? openKdCell : openMapCell)(b.getAttribute('data-cell')); };
  });
  rpPaint();
}

// ลูกศร 10 Action ล่าสุด (บันทึก / ย้าย / แก้ยอด / ลบ · นับย้อนหลังไม่จำกัดวัน · แสดงตลอดเมื่อไม่ได้เล่นย้อนหลัง)
// ลูกศรส้มเชื่อมช่องตามลำดับเวลา (เก่า → ใหม่) · เลขกลม 1 = ล่าสุด · การย้าย = ลูกศรประแดงจากช่องต้นทาง
function mapActions() {
  var d = MAP.data || {};
  if (d.actions) return d.actions.slice(0, TRAIL_N);
  var out = []; // เซิร์ฟเวอร์รุ่นเก่า: รวมจาก recent
  (d.recent || []).forEach(function (e) {
    var loc = e.to || e.from, last = out[out.length - 1];
    if (!loc || out.length > TRAIL_N) return;
    if (last && last.loc === loc && e.ev !== 'move' && last.ev !== 'move') { last.n++; last.first = e.at; return; }
    if (out.length < TRAIL_N) out.push({ at: e.at, first: e.at, ev: e.ev, from: e.from, to: e.to, loc: loc, part: e.part, by: e.by, n: 1 });
  });
  return out;
}
function mapTrailPaint() {
  var out = $('mapOut'); if (!out) return;
  var old = $('trailSvg'); if (old) old.parentNode.removeChild(old);
  var KDV = S.view === 'kd';
  if (!(KDV ? KDM.trail : MAP.trail) || !MAP.data || (!KDV && MAP.q) || (RP.open && RP.events && RP.events.length)) return;
  var list = KDV ? kdTrailActions() : mapActions(); if (!list.length) return;
  var box = out.getBoundingClientRect();
  function pt(code) {
    var c = code && out.querySelector('[data-cell="' + code + '"]'); if (!c) return null;
    var r = c.getBoundingClientRect();
    return { x: r.left - box.left + r.width / 2, y: r.top - box.top + r.height / 2, w: r.width, h: r.height };
  }
  var n = list.length;
  function op(rank) { return (1 - (rank - 1) / Math.max(n - 1, 1) * 0.65).toFixed(2); } // rank 1 = ล่าสุด
  function curve(a, b, k) {
    var mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2, dx = b.x - a.x, dy = b.y - a.y;
    return 'M' + a.x.toFixed(1) + ',' + a.y.toFixed(1) + ' Q' + (mx - dy * k).toFixed(1) + ',' + (my + dx * k).toFixed(1) + ' ' + b.x.toFixed(1) + ',' + b.y.toFixed(1);
  }
  function tip(e, rank) {
    return '<title>' + esc('#' + rank + ' ' + (MAP_EV[e.ev] || e.ev) + ' ' + (e.ev === 'move' ? e.from + ' → ' + e.to : e.loc) +
      (e.n > 1 ? ' · ' + e.n + ' รายการ' : ' · ' + e.part) + (e.by ? ' · ' + e.by : '') + ' · ' + agoText(e.at)) + '</title>';
  }
  var lines = '', moves = '', badges = '', seen = {};
  for (var i = n - 1; i >= 0; i--) { // เก่า → ใหม่ (ใหม่วาดทับด้านบน)
    var e = list[i], rank = i + 1, o = op(rank), here = pt(e.loc), prevE = list[i + 1];
    var prev = prevE ? pt(prevE.loc) : null;
    var start = e.ev === 'move' ? pt(e.from) : null;
    // เส้นลำดับเวลา: จากจุดก่อนหน้า → จุดนี้ (ถ้าเป็นการย้าย ต่อไปที่ช่องต้นทางแทน)
    var tgt = start || here;
    if (prev && tgt && (prev.x !== tgt.x || prev.y !== tgt.y)) {
      lines += '<path class="trail-line' + (rank === 1 && !start ? ' trail-new' : '') + '" d="' + curve(prev, tgt, 0.12) + '" opacity="' + o + '" marker-end="url(#trailArrow)">' + tip(e, rank) + '</path>';
    }
    if (start && here) {
      moves += '<circle class="trail-from" cx="' + start.x.toFixed(1) + '" cy="' + start.y.toFixed(1) + '" r="' + (Math.min(start.w, start.h) / 2 - 1).toFixed(1) + '" opacity="' + o + '"/>' +
        '<path class="trail-move' + (rank === 1 ? ' trail-new' : '') + '" d="' + curve(start, here, -0.18) + '" opacity="' + o + '" marker-end="url(#trailMoveArrow)">' + tip(e, rank) + '</path>';
    }
  }
  list.forEach(function (e, i) { // เลขกลม: ช่องละเลขเดียว (ครั้งล่าสุด)
    if (seen[e.loc]) return; seen[e.loc] = 1;
    var c = pt(e.loc); if (!c) return;
    var x = c.x + c.w / 2 - 2, y = c.y - c.h / 2 + 2;
    badges += '<g class="trail-badge-g' + (i === 0 ? ' new' : '') + '" opacity="' + op(i + 1) + '">' + tip(e, i + 1) +
      '<circle cx="' + x.toFixed(1) + '" cy="' + y.toFixed(1) + '" r="8"/><text x="' + x.toFixed(1) + '" y="' + (y + 3.5).toFixed(1) + '">' + (i + 1) + '</text></g>';
  });
  if (!lines && !moves && !badges) return;
  var NS = 'http://www.w3.org/2000/svg', svg = document.createElementNS(NS, 'svg');
  svg.id = 'trailSvg'; svg.setAttribute('class', 'trail-svg');
  svg.setAttribute('width', out.scrollWidth); svg.setAttribute('height', out.scrollHeight);
  svg.innerHTML = '<defs><marker id="trailArrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#d9480f"/></marker>' +
    '<marker id="trailMoveArrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#c62f2f"/></marker></defs>' +
    lines + moves + badges;
  out.appendChild(svg);
}

function renderMapRecent() {
  var el = $('mapRecent'); if (!el || !MAP.data) return;
  var list = MAP.data.recent || [];
  if (!list.length) { el.innerHTML = ''; return; }
  var shown = list.slice(0, MAP.more ? 30 : 5);
  el.innerHTML = '<div class="rack recent-box"><div class="rack-head"><b>⏱ ความเคลื่อนไหวล่าสุด</b>' +
    (list.length > 5 ? '<button class="linkbtn small" id="mapMore">' + (MAP.more ? 'ย่อ' : 'ดูเพิ่ม (' + list.length + ')') + '</button>' : '') + '</div>' +
    shown.map(function (e) {
      var locs = e.ev === 'move' ? '<button class="loc-pill" data-goto="' + esc(e.from) + '">' + esc(e.from) + '</button> → <button class="loc-pill" data-goto="' + esc(e.to) + '">' + esc(e.to) + '</button>'
        : '<button class="loc-pill" data-goto="' + esc(e.to || e.from) + '">' + esc(e.to || e.from) + '</button>';
      return '<div class="ev-row"><span class="ev-when">' + esc(agoText(e.at)) + '</span>' +
        '<span class="ev-what">' + (MAP_EV[e.ev] || esc(e.ev)) + ' ' + locs + '</span>' +
        '<span class="muted small ev-who">' + esc(e.part) + (e.by ? ' · 👤 ' + esc(e.by) : '') + '</span></div>';
    }).join('') + '</div>';
  if ($('mapMore')) $('mapMore').onclick = function () { MAP.more = !MAP.more; renderMapRecent(); };
  Array.prototype.forEach.call(el.querySelectorAll('[data-goto]'), function (b) {
    b.onclick = function () {
      var code = b.getAttribute('data-goto'), z = code.split('-')[0];
      if (!mapZoneShown(z) && mapLayout()[z]) { MAP.zone = z; renderMap(); }
      openMapCell(code);
    };
  });
}

// ---------- ผัง: เล่นย้อนหลังลำดับการบันทึก + เส้นทางเดินของแต่ละคน ----------
var RP = { open: false, date: '', shift: '', user: '', events: null, total: 0, idx: 0, playing: false, speed: 2, timer: null, loading: false, err: '' };
var RP_SPEEDS = [1, 2, 5, 10];
var RP_STEP_MS = 900; // 1x = 0.9 วินาทีต่อรายการ

function rpLocOf(e) { return e.to || e.from; }
function rpZoneOf(loc) { return String(loc || '').split('-')[0]; }

function renderRpPanel() {
  var el = $('rpPanel'); if (!el) return;
  var dock = $('rpDock');
  var top = document.querySelector('.map-top'); if (top) top.classList.toggle('rp-on', RP.open);
  if (dock) dock.innerHTML = '';
  if (!RP.open) {
    el.innerHTML = '<button class="btn rp-open" id="rpOpen">▶ เล่นย้อนหลัง / เส้นทางเดิน</button>';
    $('rpOpen').onclick = function () {
      RP.open = true;
      if (!RP.date) { RP.date = workDay(); RP.shift = currentShift(); }
      renderRpPanel(); rpLoad();
    };
    return;
  }
  var users = S.hist.users.slice();
  if (RP.user && users.indexOf(RP.user) < 0) users.unshift(RP.user);
  var n = RP.events ? RP.events.length : 0;
  el.innerHTML = '<div class="rp-box">' +
    '<div class="rp-head"><b>▶ เล่นย้อนหลัง</b><button class="linkbtn" id="rpClose">✕ ปิด</button></div>' +
    '<div class="rp-filters">' +
      '<input type="date" id="rpDate" class="field" value="' + esc(RP.date) + '">' +
      '<select id="rpUser" class="field"><option value="">👤 ทุกคน</option>' + users.map(function (u) {
        return '<option value="' + esc(u) + '"' + (u === RP.user ? ' selected' : '') + '>' + esc(u) + '</option>';
      }).join('') + '</select>' +
      '<div class="seg">' + [['', 'ทุกกะ'], ['day', '☀️ เช้า'], ['night', '🌙 ดึก']].map(function (o) {
        return '<button data-rpshift="' + o[0] + '" class="' + (RP.shift === o[0] ? 'active' : '') + '">' + o[1] + '</button>';
      }).join('') + '</div>' +
    '</div>' +
    (RP.loading ? '<div class="muted small center">กำลังโหลด…</div>'
      : RP.err ? '<div class="msg err">' + esc(RP.err) + '</div>'
      : !RP.events ? ''
      : !n ? '<div class="muted small center">ไม่มีการเคลื่อนไหวในช่วงนี้</div>'
      : '<div class="rp-sum small" id="rpSum"></div>' +
        (RP.total > n ? '<div class="muted small">แสดง ' + n + ' จาก ' + RP.total + ' รายการแรก</div>' : '') +
        rpLegend()) +
    '</div>';
  if (dock && n && !RP.loading && !RP.err) dock.innerHTML =
        '<div class="rp-player">' +
          '<button class="btn small" id="rpStart" aria-label="เริ่มใหม่">⏮</button>' +
          '<button class="btn small rp-step" id="rpPrev" aria-label="ย้อน 1 รายการ" title="ย้อน 1 รายการ (←)">◀ 1</button>' +
          '<button class="btn small primary" id="rpPlay">' + (RP.playing ? '⏸' : '▶') + '</button>' +
          '<button class="btn small rp-step" id="rpNext" aria-label="ไปต่อ 1 รายการ" title="ไปต่อ 1 รายการ (→)">1 ▶</button>' +
          '<button class="btn small" id="rpEnd" aria-label="ไปท้ายสุด">⏭</button>' +
          '<div class="seg rp-speed">' + RP_SPEEDS.map(function (sp) {
            return '<button data-rpspeed="' + sp + '" class="' + (RP.speed === sp ? 'active' : '') + '">' + sp + 'x</button>';
          }).join('') + '</div>' +
        '</div>' +
        '<input type="range" id="rpSlider" min="0" max="' + n + '" value="' + RP.idx + '" class="rp-slider">' +
        '<div class="rp-cap" id="rpCap"></div>';
  $('rpClose').onclick = function () { rpPause(); RP.open = false; RP.events = null; renderRpPanel(); rpPaint(); };
  $('rpDate').onchange = function () { RP.date = this.value; rpLoad(); };
  $('rpUser').onchange = function () { RP.user = this.value; rpLoad(); };
  Array.prototype.forEach.call(el.querySelectorAll('[data-rpshift]'), function (b) {
    b.onclick = function () { RP.shift = b.getAttribute('data-rpshift'); rpLoad(); };
  });
  if (!n || !dock || !dock.innerHTML) { rpPaint(); return; }
  $('rpPlay').onclick = function () { RP.playing ? rpPause() : rpPlay(); };
  $('rpStart').onclick = function () { rpPause(); rpGo(0); };
  $('rpEnd').onclick = function () { rpPause(); rpGo(n); };
  $('rpPrev').onclick = function () { rpPause(); rpGo(RP.idx - 1); };
  $('rpNext').onclick = function () { rpPause(); rpGo(RP.idx + 1); };
  Array.prototype.forEach.call(dock.querySelectorAll('[data-rpspeed]'), function (b) {
    b.onclick = function () {
      RP.speed = Number(b.getAttribute('data-rpspeed'));
      Array.prototype.forEach.call(dock.querySelectorAll('[data-rpspeed]'), function (x) { x.classList.toggle('active', x === b); });
    };
  });
  $('rpSlider').oninput = function () { rpPause(); rpGo(Number(this.value)); };
  rpSummary();
  rpGo(RP.idx, true);
}

// คำอธิบายสีระหว่างเล่นย้อนหลัง
function rpLegend() {
  var it = [
    ['<i class="lg rp-l-now"></i>', 'รายการที่กำลังเล่น'],
    ['<i class="lg rp-l-t1"></i><i class="lg rp-l-t3"></i>', '3 รายการก่อนหน้า (เข้ม → จาง)'],
    ['<i class="lg rp-l-done"></i>', 'ช่องที่บันทึก/ย้ายของเข้าแล้ว'],
    ['<i class="lg rp-l-out"></i>', 'ช่องที่ของถูกย้ายออกไป'],
    ['<i class="lg rp-l-del"></i>', 'ช่องที่ลบรายการ'],
    ['<i class="lg rp-l-from"></i><i class="rp-l-arrow"></i>', 'ย้ายของ: ช่องต้นทาง → ลูกศรแดงชี้ช่องปลายทาง']
  ];
  if (RP.user) it.push(['<i class="rp-l-path"></i>', 'เส้นทางเดินของ ' + esc(RP.user) + ' ตามลำดับเวลา'],
    ['<i class="lg rp-l-seq">3</i>', 'เลขในช่อง = ลำดับที่ไปช่องนั้น']);
  return '<div class="rp-legend small"><div class="rp-legend-h">คำอธิบาย</div>' +
    it.map(function (x) { return '<span>' + x[0] + x[1] + '</span>'; }).join('') +
    (RP.user ? '' : '<div class="muted">💡 เลือกชื่อคน เพื่อดูเส้นทางเดินและลำดับช่อง</div>') + '</div>';
}

// ประโยคบรรยายรายการที่กำลังเล่น
function rpNarrate(cur, prev) {
  var b = bomInfo(cur.part) || {};
  var who = cur.by ? '<b>' + esc(cur.by) + '</b>' : 'มีคน';
  var part = '<b>' + esc(cur.part) + '</b>' + (b.name ? ' (' + esc(b.name) + ')' : '');
  var q = cur.qt !== '' && cur.qt != null ? ' จำนวน <b>' + esc(fmtQty(cur.qt, cur.unit)) + '</b>' : '';
  var s = cur.ev === 'create' ? who + ' บันทึกกล่องใหม่ ' + part + q + ' ลงช่อง <b>' + esc(rpLocOf(cur)) + '</b>'
    : cur.ev === 'move' ? who + ' ย้าย ' + part + q + ' จากช่อง <b>' + esc(cur.from) + '</b> ไปช่อง <b>' + esc(cur.to) + '</b>'
    : cur.ev === 'qty' ? who + ' แก้ยอด ' + part + ' ที่ช่อง <b>' + esc(rpLocOf(cur)) + '</b> จาก ' + esc(fmtQty(cur.qf, cur.unit)) + ' เป็น <b>' + esc(fmtQty(cur.qt, cur.unit)) + '</b>'
    : cur.ev === 'delete' ? who + ' ลบรายการ ' + part + ' ออกจากช่อง <b>' + esc(rpLocOf(cur)) + '</b>'
    : cur.ev === 'out' ? who + ' เอา ' + part + ' ออกจากช่อง <b>' + esc(rpLocOf(cur)) + '</b>'
    : cur.ev === 'out_part' ? who + ' เอา ' + part + ' ออกบางส่วนที่ช่อง <b>' + esc(rpLocOf(cur)) + '</b> เหลือ <b>' + esc(fmtQty(cur.qt, cur.unit)) + '</b>'
    : who + ' ' + esc(cur.ev) + ' ' + part;
  var notes = [];
  if (prev) {
    var gap = Math.round((bkkMs(cur.at) - bkkMs(prev.at)) / 60000);
    notes.push(gap < 1 ? 'ต่อจากรายการก่อนทันที' : 'ห่างจากรายการก่อน ' + (gap >= 60 ? Math.floor(gap / 60) + ' ชม. ' + (gap % 60) + ' นาที' : gap + ' นาที'));
    var rk = function (e) { return String(rpLocOf(e)).split('-').slice(0, 2).join('-'); };
    if (rk(cur) !== rk(prev)) notes.push('เปลี่ยนไปแถว ' + esc(rk(cur)));
  } else notes.push('รายการแรกของรอบนี้');
  return '<div class="rp-say">' + s + '</div><div class="muted small">' + notes.join(' · ') + '</div>';
}

function rpLoad() {
  rpPause();
  if (!S.hist.users.length) {
    api('listScans', { limit: 1 }).then(function (d) {
      if (d.users && d.users.length) { S.hist.users = d.users; storeJson('pda_users', d.users); if (RP.open && !RP.loading) renderRpPanel(); }
    }, function () {});
  }
  RP.loading = true; RP.err = ''; RP.events = null; RP.idx = 0;
  renderRpPanel(); rpPaint();
  var want = [RP.date, RP.shift, RP.user].join('|');
  api('getLocationEvents', { date: RP.date, shift: RP.shift, user: RP.user }).then(function (d) {
    if (want !== [RP.date, RP.shift, RP.user].join('|')) return; // เปลี่ยนตัวกรองไปแล้ว
    RP.loading = false; RP.events = d.events; RP.total = d.total; RP.idx = 0;
    renderRpPanel();
    if (RP.events.length) rpPlay();
  }, function (err) {
    RP.loading = false; RP.err = err.message; renderRpPanel();
  });
}

function rpPlay() {
  if (!RP.events || !RP.events.length) return;
  if (RP.idx >= RP.events.length) RP.idx = 0;
  RP.playing = true;
  if ($('rpPlay')) $('rpPlay').textContent = '⏸';
  (function tick() {
    if (!RP.playing) return;
    if (RP.idx >= RP.events.length || S.view !== 'map') { rpPause(); return; }
    rpGo(RP.idx + 1);
    RP.timer = setTimeout(tick, RP_STEP_MS / RP.speed);
  })();
}
function rpPause() {
  RP.playing = false; clearTimeout(RP.timer);
  if ($('rpPlay')) $('rpPlay').textContent = '▶';
}

// ไปที่ลำดับ idx (= เล่นไปแล้ว idx รายการ)
function rpGo(idx, noScroll) {
  if (!RP.events) return;
  RP.idx = Math.max(0, Math.min(RP.events.length, idx));
  var cur = RP.events[RP.idx - 1];
  // ข้ามโซนเองตามรายการที่กำลังเล่น
  var z = cur && rpZoneOf(rpLocOf(cur));
  if (z && !mapZoneShown(z) && mapLayout()[z]) {
    MAP.zone = z;
    Array.prototype.forEach.call(document.querySelectorAll('[data-zone]'), function (b) { var bz = b.getAttribute('data-zone'); b.classList.toggle('active', bz === z || (mapPairOn() && bz === MAP_PAIR[0] && MAP_PAIR.indexOf(z) >= 0)); });
    renderMapGrid(); // จะเรียก rpPaint ต่อเอง
  } else rpPaint();
  if ($('rpSlider')) $('rpSlider').value = RP.idx;
  var cap = $('rpCap');
  if (cap) {
    if (!cur) cap.innerHTML = '<span class="muted">กด ▶ เพื่อเริ่ม · ' + RP.events.length + ' รายการ</span>';
    else {
      cap.innerHTML = '<div class="rp-cap-top"><span class="rp-n">' + RP.idx + ' / ' + RP.events.length + '</span>' +
        '<span class="rp-time">' + esc(cur.at.slice(11, 16)) + ' น.</span><span>' + (MAP_EV[cur.ev] || esc(cur.ev)) + '</span></div>' +
        rpNarrate(cur, RP.events[RP.idx - 2]);
    }
  }
  if (!noScroll && RP.playing && cur) {
    var cell = document.querySelector('[data-cell="' + rpLocOf(cur) + '"]');
    if (cell) cell.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }
}

// ระบายสีช่องตามลำดับที่เล่นถึง + วาดเส้นทาง/ลูกศร
function rpPaint() {
  var out = $('mapOut'); if (!out) return;
  var on = RP.open && RP.events && RP.events.length;
  out.classList.toggle('replaying', !!on);
  mapTrailPaint();
  Array.prototype.forEach.call(out.querySelectorAll('.cell'), function (c) {
    c.classList.remove('rp-done', 'rp-out', 'rp-del', 'rp-now', 'rp-t1', 'rp-t2', 'rp-t3', 'rp-from');
    c.removeAttribute('data-seq');
  });
  var svg = $('rpSvg'); if (svg) svg.parentNode.removeChild(svg);
  if (!on) return;
  var state = {}, seq = {}, n = 0, cells = {};
  function cell(code) { if (!(code in cells)) cells[code] = out.querySelector('[data-cell="' + code + '"]'); return cells[code]; }
  for (var i = 0; i < RP.idx; i++) {
    var e = RP.events[i];
    if (e.ev === 'create' || e.ev === 'qty') { state[e.to || e.from] = 'rp-done'; }
    if (e.ev === 'move') { if (e.from) state[e.from] = 'rp-out'; state[e.to] = 'rp-done'; }
    if (e.ev === 'delete') state[e.from || e.to] = 'rp-del';
    if (e.ev === 'create' || e.ev === 'move') { n++; seq[e.to] = n; }
  }
  Object.keys(state).forEach(function (code) { var c = cell(code); if (c) c.classList.add(state[code]); });
  if (RP.user) Object.keys(seq).forEach(function (code) { var c = cell(code); if (c) c.setAttribute('data-seq', seq[code]); });
  // หาง: รายการล่าสุด 4 รายการ
  ['rp-now', 'rp-t1', 'rp-t2', 'rp-t3'].forEach(function (cls, k) {
    var e = RP.events[RP.idx - 1 - k]; if (!e) return;
    var c = cell(rpLocOf(e)); if (c) c.classList.add(cls);
    if (k === 0 && e.ev === 'move' && e.from) { var f = cell(e.from); if (f) f.classList.add('rp-from'); }
  });

  // เส้นทาง (เมื่อเลือกคน) + ลูกศรย้ายของรายการปัจจุบัน
  var box = out.getBoundingClientRect();
  function pt(code) {
    var c = cell(code); if (!c) return null;
    var r = c.getBoundingClientRect();
    return [Math.round(r.left - box.left + r.width / 2), Math.round(r.top - box.top + r.height / 2)];
  }
  var paths = [], segs = [], prev = null;
  if (RP.user) {
    for (var j = 0; j < RP.idx; j++) {
      var ev = RP.events[j];
      if (ev.ev !== 'create' && ev.ev !== 'move') continue;
      var p = pt(ev.to);
      if (p && prev) segs.push(p); else if (p) segs = [p];
      if (!p && segs.length) { paths.push(segs); segs = []; }
      prev = p;
    }
    if (segs.length) paths.push(segs);
  }
  var cur = RP.events[RP.idx - 1], arrow = null;
  if (cur && cur.ev === 'move' && cur.from && cur.to) { var a = pt(cur.from), b = pt(cur.to); if (a && b) arrow = [a, b]; }
  if (!paths.length && !arrow) return;
  var NS = 'http://www.w3.org/2000/svg';
  svg = document.createElementNS(NS, 'svg');
  svg.id = 'rpSvg'; svg.setAttribute('class', 'rp-svg');
  svg.setAttribute('width', out.scrollWidth); svg.setAttribute('height', out.scrollHeight);
  svg.innerHTML = '<defs><marker id="rpArrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">' +
    '<path d="M0,0 L10,5 L0,10 z" fill="#c62f2f"/></marker>' +
    '<marker id="rpDot" viewBox="0 0 10 10" refX="5" refY="5" markerWidth="5" markerHeight="5"><circle cx="5" cy="5" r="4" fill="#7a3db8"/></marker></defs>' +
    paths.map(function (ps) {
      return ps.length > 1 ? '<polyline class="rp-path" points="' + ps.map(function (p) { return p.join(','); }).join(' ') + '" marker-end="url(#rpArrow)"/>' : '';
    }).join('') +
    (arrow ? '<line class="rp-move" x1="' + arrow[0][0] + '" y1="' + arrow[0][1] + '" x2="' + arrow[1][0] + '" y2="' + arrow[1][1] + '" marker-end="url(#rpArrow)"/>' : '');
  out.appendChild(svg);
}

// สรุปของคนที่เลือก (ทั้งรอบ ไม่ขึ้นกับตำแหน่งที่เล่น)
function rpSummary() {
  var el = $('rpSum'); if (!el || !RP.events) return;
  var ev = RP.events, boxes = 0, moves = 0, dels = 0, edits = 0, back = 0, seen = {}, last = '', who = {};
  ev.forEach(function (e) {
    if (e.ev === 'create') boxes++; else if (e.ev === 'move') moves++; else if (e.ev === 'delete') dels++; else if (e.ev === 'qty') edits++;
    if (e.by) who[e.by] = (who[e.by] || 0) + 1;
    if (e.ev !== 'create' && e.ev !== 'move') return;
    var rack = String(e.to).split('-').slice(0, 2).join('-');
    if (rack !== last) { if (seen[rack]) back++; seen[rack] = 1; last = rack; }
  });
  var span = ev.length > 1 ? (bkkMs(ev[ev.length - 1].at) - bkkMs(ev[0].at)) / 60000 : 0;
  var parts = ['🟢 บันทึก <b>' + boxes + '</b>', '🟠 ย้าย <b>' + moves + '</b>', '🔵 แก้ยอด <b>' + edits + '</b>', '🔴 ลบ <b>' + dels + '</b>',
    '⏱ ' + esc(ev[0].at.slice(11, 16)) + '–' + esc(ev[ev.length - 1].at.slice(11, 16))];
  if (RP.user) {
    if (boxes > 1 && span) parts.push('เฉลี่ย <b>' + (Math.round(span / boxes * 10) / 10) + '</b> นาที/กล่อง');
    parts.push('↩ ย้อนกลับแถวเดิม <b>' + back + '</b> ครั้ง');
  } else {
    parts.push('👤 ' + Object.keys(who).sort(function (a, b) { return who[b] - who[a]; }).map(function (u) { return esc(u) + ' ' + who[u]; }).join(', '));
  }
  el.innerHTML = parts.map(function (x) { return '<span>' + x + '</span>'; }).join('');
}

function openMapCell(code) {
  var local = S.recent.filter(function (r) { return r.status === 'pending' && r.location === code; });
  var mi = MAP.data && MAP.data.map && MAP.data.map[code];
  openModal('<h3>Location <span class="loc-pill">' + esc(code) + '</span></h3>' +
    (mi && mi.last ? '<p class="small">เคลื่อนไหวล่าสุด: <b>' + esc(agoText(mi.last)) + '</b> · ' + (MAP_EV[mi.ev] || esc(mi.ev || '')) +
      (mi.part ? ' · ' + esc(mi.part) : '') + (mi.by ? ' · 👤 ' + esc(mi.by) : '') + '</p>' : '') +
    '<div id="cellOut" class="center muted pad">กำลังโหลด…</div>' +
    '<div class="actions"><button class="btn" id="cellUse">📍 ตั้งเป็น Location ปัจจุบัน</button><button class="btn" id="mCancel">ปิด</button></div>');
  $('mCancel').onclick = closeModal;
  $('cellUse').onclick = function () {
    S.location = code; store('pda_loc', code);
    closeModal(); S.view = 'scan'; render(); toast('ตั้ง Location เป็น ' + code);
  };
  api('listScans', { location: code, limit: 200 }).then(function (d) {
    var el = $('cellOut'); if (!el) return;
    var rows = d.rows.filter(function (r) { return r.location === code; });
    var byId = {};
    local.concat(rows).forEach(function (r) { byId[r.scan_id] = r; });
    function thumbs(r) {
      var ids = photosFor(r.scan_id, r);
      return ids.length ? '<div class="cell-photos">' + ids.map(function (id) {
        return '<img class="loading" data-cpid="' + esc(id) + '" data-sid="' + esc(r.scan_id) + '" alt="">';
      }).join('') + '</div>' : '';
    }
    var items = local.map(function (r) {
      return '<div class="row"><div class="row-main"><div class="row-top"><b class="part">' + esc(r.part_code || r.qr_raw) + '</b><span class="tag pending">รอส่ง</span></div>' + itemLines(r) + thumbs(r) + '</div></div>';
    }).concat(rows.map(function (r) {
      return '<div class="row"><div class="row-main"><div class="row-top">' + partLink(r, true) + '</div>' + itemLines(r) + thumbs(r) +
        '<div class="row-sub muted small"><span>' + fmtWhen(r.scanned_at) + '</span><span>👤 ' + esc(r.scanned_by) + '</span></div>' +
        '<div class="row-sub"><button class="btn small warn" data-cout="' + esc(r.scan_id) + '">📤 เอาออก</button></div></div></div>';
    }));
    el.className = '';
    el.innerHTML = items.length ? '<p class="muted small">' + items.length + ' กล่อง</p>' + items.join('') : '<div class="empty-list muted">ยังไม่มีของในช่องนี้</div>';
    bindTimelineLinks(el);
    Array.prototype.forEach.call(el.querySelectorAll('[data-cout]'), function (b) {
      b.onclick = function () {
        openOutModal(byId[b.getAttribute('data-cout')], function () { if (typeof loadMap === 'function' && isMapView()) loadMap(); openMapCell(code); });
      };
    });
    // รูปของแต่ละกล่อง: โหลดทีละรูป · แตะเพื่อดูเต็มจอ/ซูม แล้ว "กลับ" มาหน้าช่องนี้
    Array.prototype.forEach.call(el.querySelectorAll('img[data-cpid]'), function (img) {
      loadPhoto(img.getAttribute('data-cpid')).then(function (data) { img.classList.remove('loading'); if (data) img.src = data; else img.classList.add('fail'); },
        function () { img.classList.remove('loading'); img.classList.add('fail'); });
      img.onclick = function () {
        if (!img.src) return;
        var sid = img.getAttribute('data-sid');
        viewPhoto(img.src, sid, byId[sid], function () { openMapCell(code); });
      };
    });
  }, function (err) {
    var el = $('cellOut'); if (el) { el.className = 'msg err'; el.textContent = err.message; }
  });
}

// ======================= Timeline ประวัติของแต่ละรายการ =======================
var TL_EVENTS = {
  create: { icon: '🟢', cls: 'ev-create', label: 'บันทึก' },
  qty: { icon: '🔵', cls: 'ev-qty', label: 'แก้ยอด' },
  move: { icon: '🟠', cls: 'ev-move', label: 'ย้าย Location' },
  delete: { icon: '🔴', cls: 'ev-delete', label: 'ลบ' },
  out: { icon: '📤', cls: 'ev-out', label: 'เอาออก' },
  out_part: { icon: '📤', cls: 'ev-out', label: 'เอาออกบางส่วน' },
  photo_add: { icon: '🖼', cls: 'ev-photo', label: 'แนบรูป' },
  photo_delete: { icon: '🗑', cls: 'ev-photo', label: 'ลบรูป' }
};

function partLink(r, clickable) {
  var name = esc(r.part_code || r.qr_raw);
  return clickable ? '<button class="part part-link" data-tl="' + esc(r.scan_id) + '">' + name + ' <span class="tl-ico">🕘</span></button>' : '<b class="part">' + name + '</b>';
}

function bindTimelineLinks(el) {
  Array.prototype.forEach.call(el.querySelectorAll('[data-tl]'), function (b) {
    b.onclick = function () { openTimeline(b.getAttribute('data-tl')); };
  });
}

function tlDetail(e) {
  var u = e.unit || '';
  switch (e.event) {
    case 'create': return 'ที่ <b>' + esc(e.location_to) + '</b>' + (e.qty_to !== '' ? ' · ' + esc(fmtQty(e.qty_to, u)) : '');
    case 'qty': return esc(fmtQty(e.qty_from, u)) + ' → <b>' + esc(fmtQty(e.qty_to, u)) + '</b>';
    case 'move': return esc(e.location_from) + ' → <b>' + esc(e.location_to) + '</b>';
    case 'delete': return e.location_from ? 'จาก ' + esc(e.location_from) : '';
    case 'out': return 'จาก <b>' + esc(e.location_from) + '</b>' + (e.qty_from !== '' ? ' · ' + esc(fmtQty(e.qty_from, u)) : '');
    case 'out_part': return 'ที่ <b>' + esc(e.location_from) + '</b> · ' + esc(fmtQty(e.qty_from, u)) + ' → <b>' + esc(fmtQty(e.qty_to, u)) + '</b>';
    default: return '';
  }
}

function fmtWhen(at) {
  if (!at) return 'ไม่ทราบเวลา';
  var m = String(at).match(/^(\d{4})-(\d\d)-(\d\d) (\d\d:\d\d)/);
  if (!m) return esc(at);
  var mon = ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.'][Number(m[2]) - 1];
  return Number(m[3]) + ' ' + mon + ' ' + (Number(m[1]) + 543) % 100 + ' · ' + m[4];
}

function openTimeline(scanId, back) {
  openModal('<h3>ประวัติรายการ</h3><div class="center muted pad">กำลังโหลด…</div>' +
    '<div class="actions"><button class="btn" id="mCancel">ปิด</button></div>');
  $('mCancel').onclick = closeModal;
  api('getTimeline', scanId).then(function (d) {
    if ($('modal').classList.contains('hidden')) return;
    var r = d.record, del = r.status === 'deleted' || r.status === 'out';
    var head = '<div class="tl-head' + (del ? ' deleted' : '') + '">' +
      '<div class="tl-part">' + esc(r.part_code || r.qr_raw) + '</div>' + bomLine(r.part_code) +
      '<div class="row-sub">' + (r.lot_no ? '<span>Lot ' + esc(r.lot_no) + '</span>' : '') + (r.pkg_ref ? '<span>Pkg ' + esc(r.pkg_ref) + '</span>' : '') + '</div>' +
      '<div class="tl-now">' + (del ? (r.status === 'out' ? '<span class="tag out">เอาออกแล้ว</span>' : '<span class="tag deleted">ลบแล้ว</span>')
        : 'ตอนนี้อยู่ <span class="loc-pill">' + esc(r.location) + '</span> · <b>' + esc(fmtQty(r.qty, r.unit) || '-') + '</b>') + '</div></div>';
    var list = d.events.map(function (e) {
      var t = TL_EVENTS[e.event] || { icon: '•', cls: '', label: e.event };
      return '<li class="tl-item ' + t.cls + '"><span class="tl-dot">' + t.icon + '</span>' +
        '<div class="tl-body"><div class="tl-top"><b>' + t.label + '</b><span class="muted small">' + fmtWhen(e.at) + '</span></div>' +
        (tlDetail(e) ? '<div>' + tlDetail(e) + '</div>' : '') +
        '<div class="muted small">' + (e.by ? '👤 ' + esc(e.by) : '') + (e.note ? ' · ' + esc(e.note) : '') + (e.legacy ? ' · <i>ข้อมูลย้อนหลัง</i>' : '') + '</div>' +
        '</div></li>';
    }).join('');
    $('modal').querySelector('.sheet').innerHTML = '<h3>ประวัติรายการ</h3>' + head +
      '<ul class="timeline">' + (list || '<li class="muted">ไม่มีประวัติ</li>') + '</ul>' +
      (d.legacy ? '<p class="muted small">รายการนี้บันทึกก่อนเริ่มเก็บประวัติเต็ม — การแก้ไขระหว่างทางก่อนหน้านั้นอาจไม่ครบ</p>' : '') +
      '<div class="actions wrap">' + (r.part_code ? '<button class="btn" id="tlPart">📦 ดูทุกกล่องของพาร์ทนี้</button>' : '') + '</div>' +
      '<div class="actions">' + (back ? '<button class="btn" id="tlBack">← กลับ</button>' : '') + '<button class="btn" id="mCancel">ปิด</button></div>';
    $('mCancel').onclick = closeModal;
    if ($('tlBack')) $('tlBack').onclick = back;
    if ($('tlPart')) $('tlPart').onclick = function () { openPartPackages(r.part_code, function () { openTimeline(scanId, back); }); };
  }, function (err) {
    var sh = $('modal').querySelector('.sheet');
    if (sh) sh.innerHTML = '<h3>ประวัติรายการ</h3><div class="msg err">' + esc(err.message) + '</div><div class="actions"><button class="btn" id="mCancel">ปิด</button></div>';
    if ($('mCancel')) $('mCancel').onclick = closeModal;
  });
}

function openPartPackages(partCode, back) {
  openModal('<h3>ทุกกล่องของ ' + esc(partCode) + '</h3><div class="center muted pad">กำลังโหลด…</div>' +
    '<div class="actions"><button class="btn" id="mCancel">ปิด</button></div>');
  $('mCancel').onclick = closeModal;
  api('getPartPackages', partCode).then(function (d) {
    if ($('modal').classList.contains('hidden')) return;
    var totals = Object.keys(d.totals).map(function (u) { return esc(fmtQty(d.totals[u], u === '-' ? '' : u)); }).join(' + ') || '-';
    var rows = d.rows.map(function (r) {
      return '<button class="pkg-row" data-pkg="' + esc(r.scan_id) + '">' +
        '<span class="loc-pill">' + esc(r.location) + '</span>' +
        '<span class="pkg-mid">' + (r.lot_no ? 'Lot ' + esc(r.lot_no) : '') + (r.pkg_ref ? ' · Pkg ' + esc(r.pkg_ref) : '') + '</span>' +
        '<b>' + esc(fmtQty(r.qty, r.unit) || '-') + '</b></button>';
    }).join('');
    $('modal').querySelector('.sheet').innerHTML = '<h3>ทุกกล่องของ ' + esc(d.part_code) + '</h3>' +
      '<div class="stats"><div><b>' + d.rows.length + '</b><span>กล่อง</span></div><div><b>' + d.locationCount + '</b><span>Location</span></div>' +
      '<div><b class="small-num">' + totals + '</b><span>ยอดรวม</span></div></div>' +
      (rows ? '<div class="pkg-list">' + rows + '</div><p class="muted small">แตะกล่องเพื่อดูประวัติ</p>' : '<div class="empty-list muted">ไม่มีกล่องที่ใช้งานอยู่</div>') +
      '<div class="actions">' + (back ? '<button class="btn" id="tlBack">← กลับ</button>' : '') + '<button class="btn" id="mCancel">ปิด</button></div>';
    $('mCancel').onclick = closeModal;
    if ($('tlBack')) $('tlBack').onclick = back;
    Array.prototype.forEach.call($('modal').querySelectorAll('[data-pkg]'), function (b) {
      b.onclick = function () { openTimeline(b.getAttribute('data-pkg'), function () { openPartPackages(partCode, back); }); };
    });
  }, function (err) { toast(err.message, 3500); closeModal(); });
}

// ======================= รูปถ่าย =======================
// ถ่ายด้วยกล้องเครื่อง (capture=environment) หรือเลือกจากแกลเลอรี → ย่อเป็น JPEG ≤1280px → เก็บใน IndexedDB → อัปโหลดทีละรูป
var PhotoStore = (function () {
  var dbp = null, mem = {};
  function db() {
    if (!dbp) dbp = new Promise(function (res) {
      try {
        var r = indexedDB.open('pda_photos', 1);
        r.onupgradeneeded = function () { r.result.createObjectStore('p'); };
        r.onsuccess = function () { res(r.result); };
        r.onerror = function () { res(null); };
      } catch (e) { res(null); }
    });
    return dbp;
  }
  function run(mode, fn) {
    return db().then(function (d) {
      if (!d) return null;
      return new Promise(function (res, rej) {
        var t = d.transaction('p', mode), req = fn(t.objectStore('p'));
        t.oncomplete = function () { res(req ? req.result : null); };
        t.onerror = function () { rej(t.error); };
      });
    });
  }
  return {
    put: function (id, v) { mem[id] = v; return run('readwrite', function (s) { return s.put(v, id); }).catch(function () {}); },
    get: function (id) { return mem[id] ? Promise.resolve(mem[id]) : run('readonly', function (s) { return s.get(id); }).then(function (v) { return v || null; }, function () { return null; }); },
    del: function (id) { delete mem[id]; return run('readwrite', function (s) { return s.delete(id); }).catch(function () {}); }
  };
})();

function isPhotoPending(id) { return S.photoQueue.some(function (q) { return q.photo_id === id; }); }

function photosFor(scanId, row) {
  var local = (findRecent(scanId) || {}).photos || [];
  var server = (row && row.photos) || [];
  var seen = {}, out = [];
  local.concat(server).forEach(function (id) { if (!seen[id]) { seen[id] = 1; out.push(id); } });
  return out;
}

function photoChip(scanId, row) {
  var ids = photosFor(scanId, row);
  if (!ids.length) return '';
  var pend = ids.filter(isPhotoPending).length;
  return '<button class="pchip" data-photos="' + esc(scanId) + '">🖼 ' + ids.length + ' รูป' + (pend ? ' · รอส่ง ' + pend : '') + '</button>';
}

function bindPhotoButtons(el, rowOf) {
  Array.prototype.forEach.call(el.querySelectorAll('[data-cam]'), function (b) {
    b.onclick = function (e) { e.stopPropagation(); var id = b.getAttribute('data-cam'); pickPhoto(id, true, rowOf(id)); };
  });
  Array.prototype.forEach.call(el.querySelectorAll('[data-photos]'), function (b) {
    b.onclick = function (e) { e.stopPropagation(); var id = b.getAttribute('data-photos'); openPhotos(id, rowOf(id)); };
  });
}

function pickPhoto(scanId, useCamera, row) {
  var inp = document.createElement('input');
  inp.type = 'file'; inp.accept = 'image/*';
  if (useCamera) inp.setAttribute('capture', 'environment'); else inp.multiple = true;
  inp.style.display = 'none';
  document.body.appendChild(inp);
  inp.onchange = function () {
    var list = Array.prototype.slice.call(inp.files || []);
    if (inp.parentNode) inp.parentNode.removeChild(inp);
    addPhotos(scanId, list, row);
  };
  inp.click();
}

function addPhotos(scanId, files, row) {
  if (files.length) toast('📷 กำลังบันทึกรูป…', 1200);
  return files.reduce(function (p, f) { return p.then(function () { return addPhoto(scanId, f, row); }); }, Promise.resolve())
    .then(function () {
      if (!files.length) return;
      toast('บันทึกรูปแล้ว ' + files.length + ' รูป · อัปโหลดเบื้องหลัง ใช้งานต่อได้เลย', 2500);
      flushPhotos();
      // ถ่ายจากปุ่ม 📷 ในรายการ → เปิดหน้ารูปของรายการนั้นต่อ เพื่อกด "ถ่ายเพิ่ม" ได้ทันที
      if (!openPhotos.current && $('modal').classList.contains('hidden')) openPhotos(scanId, row);
    });
}

function compressImage(file) {
  if (window.createImageBitmap) {
    return createImageBitmap(file, { imageOrientation: 'from-image' }).then(function (bmp) {
      var max = 1280, w = bmp.width, h = bmp.height, k = Math.min(1, max / Math.max(w, h));
      var c = document.createElement('canvas');
      c.width = Math.round(w * k); c.height = Math.round(h * k);
      c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
      if (bmp.close) bmp.close();
      return c.toDataURL('image/jpeg', 0.72);
    }).catch(function () { return compressImageEl(file); });
  }
  return compressImageEl(file);
}
function compressImageEl(file) {
  return new Promise(function (res, rej) {
    var url = URL.createObjectURL(file), img = new Image();
    img.onload = function () {
      var max = 1280, w = img.naturalWidth, h = img.naturalHeight, k = Math.min(1, max / Math.max(w, h));
      var c = document.createElement('canvas');
      c.width = Math.round(w * k); c.height = Math.round(h * k);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url);
      res(c.toDataURL('image/jpeg', 0.72));
    };
    img.onerror = function () { URL.revokeObjectURL(url); rej(new Error('อ่านไฟล์รูปไม่ได้')); };
    img.src = url;
  });
}

function addPhoto(scanId, file, row) {
  return compressImage(file).then(function (dataUrl) {
    var id = uid();
    S.photoCache[id] = dataUrl;
    return PhotoStore.put(id, dataUrl).then(function () {
      S.photoQueue.push({ photo_id: id, scan_id: scanId });
      storeJson('pda_photo_queue', S.photoQueue);
      var r = findRecent(scanId);
      if (r) { r.photos = (r.photos || []).concat(id); saveRecent(); }
      if (row) row.photos = (row.photos || []).concat(id);
      afterPhotoChange(scanId, row);
    });
  }, function (err) { toast(err.message); });
}

function afterPhotoChange(scanId, row) {
  if (S.view === 'scan' || S.view === 'manual') { renderSync(); renderRecent(); } else if (S.view === 'scrap') { renderScrapList(); refreshHeader(); } else { renderHistoryList(); refreshHeader(); }
  if (openPhotos.current && openPhotos.current.scanId === scanId) openPhotos(scanId, row || openPhotos.current.row);
}

function flushPhotos(manual) {
  if (S.photoSyncing || !S.photoQueue.length || !apiUrl()) return;
  var q = S.photoQueue[0];
  // รอให้รายการสแกนขึ้นเซิร์ฟเวอร์ก่อน เพื่อให้ชื่อไฟล์มี Location / รหัสสินค้า
  var rec = findRecent(q.scan_id);
  if (rec && rec.status === 'pending') return;
  S.photoSyncing = true; renderSync();
  PhotoStore.get(q.photo_id).then(function (dataUrl) {
    if (!dataUrl) return { lost: true };
    return api('uploadPhoto', { photo_id: q.photo_id, scan_id: q.scan_id, data: dataUrl.split(',')[1], mime: 'image/jpeg', uploaded_by: S.user });
  }).then(function (res) {
    S.online = true;
    S.photoQueue = S.photoQueue.filter(function (x) { return x.photo_id !== q.photo_id; });
    storeJson('pda_photo_queue', S.photoQueue);
    PhotoStore.del(q.photo_id);
    if (res && res.lost) {
      var r = findRecent(q.scan_id); if (r) { r.photos = (r.photos || []).filter(function (x) { return x !== q.photo_id; }); saveRecent(); }
    }
    S.photoSyncing = false;
    afterPhotoChange(q.scan_id, null);
    if (S.photoQueue.length) setTimeout(flushPhotos, 200);
  }, function (err) {
    S.photoSyncing = false;
    if (err.network) S.online = false;
    else setMsg('err', 'อัปโหลดรูปไม่สำเร็จ: ' + esc(err.message));
    if (manual) toast(err.message);
    refreshScanParts();
  });
}

function loadPhoto(id) {
  if (S.photoCache[id]) return Promise.resolve(S.photoCache[id]);
  var p = isPhotoPending(id) ? PhotoStore.get(id) : api('getPhoto', id).then(function (d) { return d.data; });
  return p.then(function (data) { if (data) S.photoCache[id] = data; return data; });
}

function openPhotos(scanId, row) {
  openPhotos.current = { scanId: scanId, row: row };
  var r = findRecent(scanId) || row || {};
  var ids = photosFor(scanId, row);
  openModal('<h3>รูปถ่าย' + (ids.length ? ' <span class="muted small">(' + ids.length + ' รูป)</span>' : '') + '</h3>' +
    '<div class="muted small">' + esc(r.part_code || r.qr_raw || '') + (r.location ? ' @ ' + esc(r.location) : '') + '</div>' +
    (ids.length ? '<div class="photo-grid">' + ids.map(function (id) {
      return '<div class="photo"><img data-pid="' + esc(id) + '" alt="">' +
        (isPhotoPending(id) ? '<span class="ptag">รอส่ง</span>' : '') +
        '<button class="pdel" data-pdel="' + esc(id) + '" aria-label="ลบรูป">✕</button></div>';
    }).join('') + '</div>' : '<div class="empty-list muted">ยังไม่มีรูป</div>') +
    '<div class="actions wrap"><button class="btn primary" id="pCam">📷 ' + (ids.length ? 'ถ่ายเพิ่ม' : 'ถ่ายรูป') + '</button><button class="btn" id="pGal">🖼 เลือกจากเครื่อง (ได้หลายรูป)</button></div>' +
    '<div class="actions"><button class="btn" id="mCancel">' + (ids.length ? 'เสร็จ' : 'ปิด') + '</button></div>');
  var m = $('modal');
  m.onclick = function (e) { if (e.target === m) closePhotos(); };
  $('mCancel').onclick = closePhotos;
  $('pCam').onclick = function () { pickPhoto(scanId, true, row); };
  $('pGal').onclick = function () { pickPhoto(scanId, false, row); };
  Array.prototype.forEach.call(m.querySelectorAll('img[data-pid]'), function (img) {
    var id = img.getAttribute('data-pid');
    img.classList.add('loading');
    loadPhoto(id).then(function (data) { img.classList.remove('loading'); if (data) img.src = data; },
      function () { img.classList.remove('loading'); img.alt = 'โหลดไม่ได้'; });
    img.onclick = function () { if (img.src) viewPhoto(img.src, scanId, row); };
  });
  Array.prototype.forEach.call(m.querySelectorAll('[data-pdel]'), function (b) {
    b.onclick = function () { deletePhotoUi(b.getAttribute('data-pdel'), scanId, row); };
  });
}

function closePhotos() { openPhotos.current = null; closeModal(); }

function viewPhoto(src, scanId, row, back) {
  openPhotos.current = null;
  openModal('<div class="zoom-box" id="zBox"><img class="zoom-img" id="zImg" src="' + src + '" alt="" draggable="false"></div>' +
    '<div class="zoom-bar"><button class="btn small" id="zOut" aria-label="ซูมออก">➖</button><span id="zPct" class="muted small">100%</span>' +
    '<button class="btn small" id="zIn" aria-label="ซูมเข้า">➕</button><button class="btn small" id="zReset">พอดีจอ</button></div>' +
    '<p class="muted small center">ใช้สองนิ้วถ่าง หรือแตะสองครั้งเพื่อซูม · ลากเพื่อเลื่อนดู</p>' +
    '<div class="actions"><button class="btn" id="mBack">กลับ</button></div>');
  $('mBack').onclick = function () { if (back) back(); else openPhotos(scanId, row); };
  setupZoom($('zBox'), $('zImg'));
}

// ซูมรูป: สองนิ้วถ่าง / แตะสองครั้ง / ปุ่ม +- / ล้อเมาส์ · ลากเลื่อนเมื่อซูมอยู่
function setupZoom(box, img) {
  var z = 1, x = 0, y = 0, MAX = 6, pts = {}, start = null, lastTap = 0;
  function clamp() {
    var w = box.clientWidth, h = box.clientHeight;
    var mx = (w * z - w) / 2, my = (h * z - h) / 2;
    x = Math.max(-mx, Math.min(mx, x)); y = Math.max(-my, Math.min(my, y));
  }
  function apply(anim) {
    if (z <= 1) { z = 1; x = 0; y = 0; }
    clamp();
    img.style.transition = anim ? 'transform .2s' : 'none';
    img.style.transform = 'translate(' + x + 'px,' + y + 'px) scale(' + z + ')';
    box.classList.toggle('zoomed', z > 1);
    if ($('zPct')) $('zPct').textContent = Math.round(z * 100) + '%';
  }
  // ซูมโดยให้จุด (cx, cy) บนจอค้างอยู่ที่เดิม
  function zoomAt(nz, cx, cy, anim) {
    nz = Math.max(1, Math.min(MAX, nz));
    var r = box.getBoundingClientRect();
    var px = cx - r.left - r.width / 2, py = cy - r.top - r.height / 2;
    x = px - (px - x) * nz / z; y = py - (py - y) * nz / z; z = nz;
    apply(anim);
  }
  function center() { var r = box.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; }
  $('zIn').onclick = function () { var c = center(); zoomAt(z * 1.6, c[0], c[1], true); };
  $('zOut').onclick = function () { var c = center(); zoomAt(z / 1.6, c[0], c[1], true); };
  $('zReset').onclick = function () { z = 1; apply(true); };
  box.addEventListener('wheel', function (e) { e.preventDefault(); zoomAt(z * (e.deltaY < 0 ? 1.2 : 1 / 1.2), e.clientX, e.clientY); }, { passive: false });
  box.addEventListener('pointerdown', function (e) {
    box.setPointerCapture(e.pointerId);
    pts[e.pointerId] = [e.clientX, e.clientY];
    var ids = Object.keys(pts);
    if (ids.length === 2) {
      var a = pts[ids[0]], b = pts[ids[1]];
      start = { d: Math.hypot(a[0] - b[0], a[1] - b[1]), z: z, x: x, y: y, cx: (a[0] + b[0]) / 2, cy: (a[1] + b[1]) / 2 };
    } else if (ids.length === 1) {
      start = { px: e.clientX, py: e.clientY, x: x, y: y, moved: false };
    }
  });
  box.addEventListener('pointermove', function (e) {
    if (!pts[e.pointerId] || !start) return;
    pts[e.pointerId] = [e.clientX, e.clientY];
    var ids = Object.keys(pts);
    if (ids.length === 2 && start.d) {
      var a = pts[ids[0]], b = pts[ids[1]];
      var d = Math.hypot(a[0] - b[0], a[1] - b[1]);
      z = start.z; x = start.x; y = start.y;
      zoomAt(start.z * d / start.d, start.cx, start.cy);
      x += (a[0] + b[0]) / 2 - start.cx; y += (a[1] + b[1]) / 2 - start.cy; apply();
    } else if (ids.length === 1 && start.px !== undefined) {
      var dx = e.clientX - start.px, dy = e.clientY - start.py;
      if (Math.abs(dx) + Math.abs(dy) > 6) start.moved = true;
      if (z > 1) { x = start.x + dx; y = start.y + dy; apply(); }
    }
  });
  function up(e) {
    var wasTap = start && start.px !== undefined && !start.moved && Object.keys(pts).length === 1;
    delete pts[e.pointerId];
    if (wasTap && e.type === 'pointerup') {
      var now = Date.now();
      if (now - lastTap < 320) { if (z > 1) { z = 1; apply(true); } else zoomAt(2.5, e.clientX, e.clientY, true); lastTap = 0; }
      else lastTap = now;
    }
    var ids = Object.keys(pts);
    start = ids.length === 1 ? { px: pts[ids[0]][0], py: pts[ids[0]][1], x: x, y: y, moved: true } : null;
  }
  box.addEventListener('pointerup', up);
  box.addEventListener('pointercancel', up);
  apply();
}

function deletePhotoUi(id, scanId, row) {
  if (!confirm('ลบรูปนี้?')) return;
  function drop() {
    var r = findRecent(scanId);
    if (r) { r.photos = (r.photos || []).filter(function (x) { return x !== id; }); saveRecent(); }
    if (row) row.photos = (row.photos || []).filter(function (x) { return x !== id; });
    delete S.photoCache[id];
    afterPhotoChange(scanId, row);
    toast('ลบรูปแล้ว');
  }
  if (isPhotoPending(id)) {
    if (S.photoSyncing && S.photoQueue[0] && S.photoQueue[0].photo_id === id) { toast('กำลังอัปโหลดรูปนี้ รอสักครู่'); return; }
    S.photoQueue = S.photoQueue.filter(function (q) { return q.photo_id !== id; });
    storeJson('pda_photo_queue', S.photoQueue);
    PhotoStore.del(id); drop(); return;
  }
  if (!S.user) { openUserModal(); return; }
  api('deletePhoto', id, S.user).then(drop, function (err) { toast(err.message, 3500); });
}

// ======================= เริ่มต้น =======================
window.addEventListener('resize', function () { if (isMapView()) rpPaint(); });
// เล่นย้อนหลัง: ลูกศรซ้าย/ขวา = ทีละ 1 รายการ · Space = เล่น/หยุด (บนคอม)
document.addEventListener('keydown', function (e) {
  if (S.view !== 'map' || !RP.open || !RP.events || !RP.events.length) return;
  if (!$('modal').classList.contains('hidden')) return;
  var tg = e.target && e.target.tagName; if (tg === 'INPUT' || tg === 'SELECT' || tg === 'TEXTAREA') return;
  if (e.key === 'ArrowLeft') { e.preventDefault(); rpPause(); rpGo(RP.idx - 1); }
  else if (e.key === 'ArrowRight') { e.preventDefault(); rpPause(); rpGo(RP.idx + 1); }
  else if (e.key === ' ') { e.preventDefault(); RP.playing ? rpPause() : rpPlay(); }
});
// เลื่อนแถวชั้นวางแนวนอน (มือถือ) → วาดลูกศรใหม่ให้ตรงช่อง
var trailRaf = 0;
document.addEventListener('scroll', function (e) {
  if (!isMapView() || !e.target.classList || !e.target.classList.contains('rack-scroll')) return;
  cancelAnimationFrame(trailRaf); trailRaf = requestAnimationFrame(rpPaint);
}, true);

// ======================= เทียบ Kingdee (ตรวจนับสต๊อก) =======================
// ยอด Kingdee: ดึงจาก OnHand-Inventory-Planner (ระบบดึงจาก Kingdee ทุก 10 นาที) ไฟล์บีบอัดราว 200 KB · เก็บเฉพาะช่องที่มีในแอป
// ของที่นับได้: รายการในแอปตอนนี้ (ผัง) + รายการรอส่งในเครื่อง · รอบนับ / "นับช่องนี้เสร็จ" เก็บที่เซิร์ฟเวอร์ (ทุกเครื่องเห็นเหมือนกัน)
function isMapView() { return S.view === 'map' || S.view === 'kd'; }
var KD_URL = (window.PDA_CONFIG && window.PDA_CONFIG.KINGDEE_ONHAND_URL) || 'https://somrudeebanthao09.github.io/OnHand-Inventory-Planner/OnHandSeed.js';
var KD_TTL = 10 * 60000;
var KD = {
  rows: storeJson('pda_kd_rows') || [], pub: storeJson('pda_kd_pub') || [], pubOk: !!storeJson('pda_kd_pub'), snapshotAt: store('pda_kd_snap') || '', loadedAt: 0, loading: false, err: '',
  mode: store('pda_kd_mode') === 'part' ? 'part' : 'lot', filter: 'diff', all: false,
  count: storeJson('pda_kd_count') || { round: null, marks: {} },
  lastMod: store('pda_kd_lm') || '', checkedAt: 0, checking: false
};
// ทุก 1 นาที ถามแค่ "ไฟล์ต้นทางแก้ไขล่าสุดเมื่อไร" (HEAD ~0.5 KB) → เปลี่ยนแล้วค่อยโหลดไฟล์จริง
// เช็คเฉพาะตอนเปิดแท็บ Kingdee หรือหน้าสแกน (มี Location) และหน้าจอไม่ได้ซ่อน
var KD_CHECK_MS = 60000;
function kdCheckWanted() {
  return document.visibilityState !== 'hidden' && (S.view === 'kd' || (S.view === 'scan' && !!S.location));
}
function kdCheck() {
  if (KD.checking || KD.loading) return;
  if (!KD.rows.length || !KD.lastMod || !KD.pubOk) { KD.checkedAt = Date.now(); loadKd(true); return; } // pub ว่าง = เครื่องที่โหลดยอดไว้ก่อนมี Public area
  KD.checking = true;
  fetch(KD_URL + '?h=' + Date.now(), { method: 'HEAD', cache: 'no-store' }).then(function (r) {
    KD.checking = false; KD.checkedAt = Date.now();
    var lm = r.ok && r.headers.get('Last-Modified');
    // ใหม่กว่าเดิมเกิน 5 วินาทีจริงๆ ถึงโหลด (เซิร์ฟเวอร์ GitHub แต่ละตัวอาจบอกเวลาต่างกัน 1–2 วินาที)
    var tNew = Date.parse(lm || ''), tOld = Date.parse(KD.lastMod || '');
    if (tNew && (!tOld || tNew - tOld > 5000)) loadKd(true); else renderKdSnap();
  }, function () { KD.checking = false; KD.checkedAt = Date.now(); });
}
setInterval(function () { if (kdCheckWanted() && Date.now() - KD.checkedAt >= KD_CHECK_MS - 1000) kdCheck(); }, 15000);
document.addEventListener('visibilitychange', function () { if (kdCheckWanted() && Date.now() - KD.checkedAt >= KD_CHECK_MS) kdCheck(); });
var KD_ST = {
  todo: ['⚪', 'ยังไม่นับ', 'ระบบมีของ ยังไม่ได้นับในรอบนี้'],
  match: ['🟢', 'ตรง', 'รหัส / Lot / จำนวน ตรงกับ Kingdee'],
  diff: ['🟡', 'ไม่ตรง', 'มีของแต่จำนวนหรือรายการไม่ตรง'],
  missing: ['🔴', 'หาไม่เจอ', 'Kingdee มี แต่นับเสร็จแล้วไม่เจอของ'],
  extra: ['🟣', 'เกิน', 'นับเจอ แต่ Kingdee ไม่มีในช่องนี้']
};

function loadKd(force) {
  if (KD.loading) return;
  KD.loading = true; KD.err = ''; renderKdSnap();
  fetch(KD_URL + (force ? '?t=' + Date.now() : ''), { cache: force ? 'no-store' : 'default' }).then(function (r) {
    if (!r.ok) throw new Error('HTTP ' + r.status);
    var lm = r.headers.get('Last-Modified'); if (lm) { KD.lastMod = lm; store('pda_kd_lm', lm); }
    return r.text();
  }).then(function (t) {
    var d = JSON.parse(t.slice(t.indexOf('{'), t.lastIndexOf('}') + 1)), set = {};
    (window.LOCATIONS || []).forEach(function (c) { set[c] = 1; });
    var rows = [], pubAll = [], whs = {};
    (d.inventory || []).forEach(function (r) {
      var loc = String(r.storage || '').trim(), isPub = /^public area$/i.test(loc); if (!set[loc] && !isPub) return;
      var q = Number(r.onHandQty != null ? r.onHandQty : r.onHand); if (!q) return;
      var row = [isPub ? 'Public area' : loc, String(r.partCode || r.materialCode || '').trim(), String(r.lotNumber || '').trim(), q, String(r.unit || ''),
                 String(r.partName || r.materialName || ''), String(r.specification || ''), String(r.warehouse || '')];
      if (isPub) pubAll.push(row); else { rows.push(row); whs[row[7]] = 1; }
    });
    // Public area เฉพาะคลังที่มีช่องในผัง (ไม่เอา Scrap / Defective / คลังที่ไม่เกี่ยว)
    KD.pub = pubAll.filter(function (r) { return whs[r[7]]; }); storeJson('pda_kd_pub', KD.pub); KD.pubOk = true;
    KD.rows = rows; KD.snapshotAt = d.snapshotAt || ''; KD.loadedAt = Date.now(); KD.loading = false; kdCompute.key = null;
    if (KDF.q) kdfRun(KDF.q, false);
    storeJson('pda_kd_rows', rows); store('pda_kd_snap', KD.snapshotAt);
    kdRefreshViews();
  }).catch(function (err) {
    KD.loading = false; KD.err = 'ดึงยอด Kingdee ไม่ได้: ' + err.message;
    kdRefreshViews();
  });
}
function loadCount() {
  if (!apiUrl() || loadCount.busy) return;
  loadCount.busy = true;
  api('getCountState').then(function (d) {
    loadCount.busy = false;
    var changed = JSON.stringify(d.round) + JSON.stringify(d.marks) !== JSON.stringify(KD.count.round) + JSON.stringify(KD.count.marks);
    KD.count = { round: d.round, marks: d.marks || {} }; storeJson('pda_kd_count', KD.count);
    if (changed) { kdCompute.key = null; kdRefreshViews(); }
  }, function () { loadCount.busy = false; });
}
function kdRefreshViews() {
  if (S.view === 'kd') { renderKdSnap(); renderKdRound(); if (MAP.data) renderMapGrid(); }
  if (S.view === 'scan') renderKdLoc();
}
// เวลา snapshot (ISO UTC) → 'yyyy-MM-dd HH:mm' เวลาไทย
function kdSnapText() {
  var t = Date.parse(KD.snapshotAt); if (!t) return '';
  var d = new Date(t + 7 * 3600000);
  return d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate()) + ' ' + pad(d.getUTCHours()) + ':' + pad(d.getUTCMinutes());
}
function kdQtyEq(a, b) { return a != null && b != null && Math.abs(a - b) <= Math.max(1, Math.abs(a)) * 0.0005; }
function kdNum(v) { var n = Number(v); return v === '' || v == null || isNaN(n) ? null : n; }
function kdFmt(n) { return n == null ? '—' : (Math.round(n * 1000) / 1000).toLocaleString('en-US'); }

// เทียบทั้งคลัง: ต่อช่อง → { st, keys:[{key, part, lot, k, a, eq}], nk, na, nd, marked }
function kdCompute() {
  // ไม่นับข้อมูลทดสอบ (ผู้บันทึกชื่อ ทดสอบ / test) — เหมือนตอน Export
  var items = mapAllItems().filter(function (it) { return !isTestUser(it.by); }), cnt = KD.count || {}, round = cnt.round, marks = cnt.marks || {};
  var key = [KD.rows.length, KD.snapshotAt, KD.mode, MAP.itemsSig, items.length, JSON.stringify(round), Object.keys(marks).length, MAP.loadedAt].join('|');
  if (kdCompute.key === key && kdCompute.v) return kdCompute.v;
  var lot = KD.mode === 'lot', K = {}, A = {};
  function kk(part, l) { return lot ? part + '|' + l : part; }
  KD.rows.forEach(function (r) {
    var b = K[r[0]] || (K[r[0]] = {}), x = kk(r[1], r[2]);
    var e = b[x] || (b[x] = { part: r[1], lot: lot ? r[2] : '', q: 0, unit: r[4], name: r[5], spec: r[6], wh: r[7], lots: {} });
    e.q += r[3]; e.lots[r[2]] = 1;
  });
  items.forEach(function (it) {
    var b = A[it.loc] || (A[it.loc] = {}), x = kk(it.part, it.lot);
    var e = b[x] || (b[x] = { part: it.part, lot: lot ? it.lot : '', q: 0, unit: it.unit || '', n: 0, noQty: 0, pending: 0, lots: {} });
    var q = kdNum(it.qty); if (q == null) e.noQty++; else e.q += q;
    e.n++; if (it.pending) e.pending++; e.lots[it.lot] = 1;
    if (it.at) { if (!e.at || it.at > e.at) { e.at = it.at; e.by = it.by; } if (!e.at0 || it.at < e.at0) e.at0 = it.at; }
  });
  var map = (MAP.data && MAP.data.map) || {}, out = {}, sum = { todo: 0, match: 0, diff: 0, missing: 0, extra: 0, kBins: 0, counted: 0 };
  Object.keys(K).concat(Object.keys(A)).forEach(function (loc) {
    if (out[loc]) return;
    var k = K[loc] || {}, a = A[loc] || {}, keys = [], nd = 0;
    Object.keys(k).concat(Object.keys(a)).forEach(function (x) {
      if (keys.some(function (y) { return y.key === x; })) return;
      var ke = k[x], ae = a[x];
      var unitBad = ke && ae && ae.unit && ke.unit && ae.unit.toUpperCase() !== ke.unit.toUpperCase();
      var eq = !!(ke && ae && !ae.noQty && !unitBad && kdQtyEq(ke.q, ae.q));
      if (!eq) nd++;
      keys.push({ key: x, part: (ke || ae).part, lot: (ke || ae).lot, k: ke || null, a: ae || null, eq: eq, unitBad: unitBad });
    });
    keys.sort(function (p, q) { return p.eq - q.eq || (p.part < q.part ? -1 : p.part > q.part ? 1 : p.lot < q.lot ? -1 : 1); });
    var nk = Object.keys(k).length, na = Object.keys(a).length, marked = marks[loc] || null;
    var last = map[loc] && map[loc].last;
    var counted = !round || !!marked || !!(last && last >= round.start) || keys.some(function (y) { return y.a && y.a.pending; });
    var st = !nk ? 'extra' : !na ? (marked ? 'missing' : 'todo') : nd ? 'diff' : 'match';
    if (round && !counted) st = 'todo';
    out[loc] = { loc: loc, st: st, keys: keys, nk: nk, na: na, nd: nd, marked: marked, counted: counted, last: last };
    sum[st]++;
    if (nk) { sum.kBins++; if (st !== 'todo') sum.counted++; }
  });
  kdCompute.key = key;
  return (kdCompute.v = { bins: out, sum: sum });
}

function kdTopHtml() {
  // ตัวเลือกการแสดงผลพับไว้ในบรรทัดเดียว (summary บอกค่าที่เลือกอยู่) — ไม่ให้หน้าจอรก
  return '<div class="kd-bar">' +
      '<div id="kdSnap" class="small muted kd-snap"></div>' +
      '<details class="kd-opts" id="kdOpts"' + (store('pda_kd_opts') === '1' ? ' open' : '') + '><summary>⚙ <span id="kdOptsSum">' + kdOptsSummary() + '</span></summary>' +
        '<div class="kd-opt"><span class="small">เทียบระดับ</span><div class="seg"><button data-kdmode="lot" class="' + (KD.mode === 'lot' ? 'active' : '') + '">รหัส + Lot</button>' +
          '<button data-kdmode="part" class="' + (KD.mode === 'part' ? 'active' : '') + '">รหัสอย่างเดียว</button></div></div>' +
        '<div class="kd-opt"><span class="small">สีช่อง</span><div class="seg"><button data-kdcolor="cmp" class="' + (KD.color === 'cmp' ? 'active' : '') + '">เทียบยอด</button>' +
          '<button data-kdcolor="age" class="' + (KD.color === 'age' ? 'active' : '') + '">🕒 อายุในช่อง</button></div></div>' +
        '<div class="kd-opt"><span class="small">ลูกศร</span><div class="seg"><button class="' + (KDM.trail ? 'active' : '') + '" id="kdTrail" title="ลูกศร 10 ความเคลื่อนไหว Kingdee ล่าสุด">➜ ความเคลื่อนไหว ' + (KDM.trail ? 'เปิด' : 'ปิด') + '</button></div></div>' +
      '</details>' +
    '</div>' +
    '<div id="kdCap"></div><div id="kdStale"></div><div id="kdRound" class="kd-round"></div><div id="kdPub"></div><div id="kdXfer"></div>' +
    '<div class="kdf-bar"><div class="ac-wrap kdf-wrap"><input id="kdfQ" class="field" autocomplete="off" spellcheck="false" enterkeyhint="search" placeholder="สแกน / พิมพ์ รหัส · Lot · ชื่อพาร์ท · Spec" value="' + esc(KDF.q) + '">' +
      '<div id="kdfSug" class="ac-list hidden" role="listbox"></div></div>' +
      '<button class="btn primary" id="kdfCam" title="เปิดกล้องสแกนป้าย">📸 สแกน</button></div>' +
    '<div id="kdFind"></div>' +
    (KD.color === 'age'
      ? '<div class="map-legend small">' + KDA_BANDS.map(function (b, i) { return '<span><i class="lg kd-age' + i + '"></i>' + b[1] + '</span>'; }).join('') +
        '<span>เลขในช่อง = จำนวนวันของที่อยู่นานสุดในช่อง</span></div>'
      : '<div class="map-legend small">' + Object.keys(KD_ST).map(function (k) {
      return '<span title="' + esc(KD_ST[k][2]) + '"><i class="lg kd-' + k + '"></i>' + KD_ST[k][1] + '</span>';
    }).join('') + '<span><i class="lg kd-done-lg">✔</i>กดนับเสร็จแล้ว</span><span><i class="lg kd-moved-lg"></i>Kingdee เปลี่ยน (ช่วงที่เลือก)</span></div>') +
    '<div id="kdList"></div><div id="kdMoves"></div>';
}
function kdOptsSummary() {
  return '<b>' + (KD.mode === 'lot' ? 'รหัส + Lot' : 'รหัสอย่างเดียว') + '</b> · <b>' + (KD.color === 'age' ? '🕒 อายุในช่อง' : 'เทียบยอด') + '</b>' + (KDM.trail ? ' · <b>➜ ความเคลื่อนไหว</b>' : '');
}
function bindKdTop() {
  $('kdOpts').addEventListener('toggle', function () { store('pda_kd_opts', this.open ? '1' : '0'); });
  Array.prototype.forEach.call(document.querySelectorAll('[data-kdmode]'), function (b) {
    b.onclick = function () { KD.mode = b.getAttribute('data-kdmode'); store('pda_kd_mode', KD.mode); kdCompute.key = null; renderMap(); };
  });
  Array.prototype.forEach.call(document.querySelectorAll('[data-kdcolor]'), function (b) {
    b.onclick = function () { KD.color = b.getAttribute('data-kdcolor'); store('pda_kd_color', KD.color); KD.more = 0; renderMap(); };
  });
  loadKdAges();
  renderKdSnap(); renderKdRound(); renderKdMoves(); bindKdFind();
  $('kdTrail').onclick = function () {
    KDM.trail = !KDM.trail; store('pda_kdm_trail', KDM.trail ? '1' : '0');
    this.classList.toggle('active', KDM.trail); this.textContent = '➜ ความเคลื่อนไหว ' + (KDM.trail ? 'เปิด' : 'ปิด');
    $('kdOptsSum').innerHTML = kdOptsSummary(); rpPaint();
  };
  if (Date.now() - KDM.loadedAt > 60000) loadKdMoves();
}
// ยอด Kingdee ค้าง: ไฟล์ต้นทางยังอัปเดตเวลา แต่ตัวเลขไม่เปลี่ยนเลยเกิน 2 ชม. ทำงาน (จ.–ส. 08:00–18:00)
function kdStaleHours() {
  var t0 = kdTs(KDM.dataSince), t1 = kdTs(KDM.snapAt);
  if (!t0 || !t1 || t1 <= t0) return 0;
  var h = 0, step = 15 * 60000, end = Date.now(), t = Math.max(t0, end - 14 * 86400000);
  for (; t < end; t += step) { var d = new Date(t), hr = d.getHours(); if (d.getDay() !== 0 && hr >= 8 && hr < 18) h += 0.25; }
  return h;
}
function kdStaleHtml(short) {
  if (kdStaleHours() < 2) return '';
  return short ? '<span class="err-text"> · ⚠ ยอดไม่เปลี่ยนตั้งแต่ ' + esc(kdWhen(KDM.dataSince)) + '</span>'
    : '<div class="kd-stale">⚠ <b>ยอด Kingdee ไม่เปลี่ยนเลยตั้งแต่ ' + esc(kdWhen(KDM.dataSince)) + '</b> (' + esc(agoText(KDM.dataSince)) + ')' +
      '<br><span class="small">ไฟล์ต้นทางยังส่งมาทุก 10 นาที แต่ตัวเลขเหมือนเดิมทุกรอบ — ตัวดึงข้อมูล Kingdee ของทีมอาจหยุดทำงาน ยอดที่เห็นอาจไม่ใช่ยอดล่าสุด</span></div>';
}
// สรุปพื้นที่: Location ทั้งหมด (จากไฟล์ Location ของ Kingdee) · ใช้แล้ว = มีของใน Kingdee หรือมีกล่องที่สแกนในแอป · ว่าง = ไม่มีทั้งสองระบบ
// ไม่นับ Public area (ไม่ใช่ช่องชั้นวาง) · เลือกได้ว่าจะรวมโซน CO / CP / CQ หรือไม่ (จำไว้ในเครื่อง)
var KDCAP = { open: store('pda_kdcap_open') === '1', cpq: store('pda_kdcap_cpq') !== '0' };
var KDCAP_ZONES = ['CO', 'CP', 'CQ'];
function renderKdCap() {
  var el = $('kdCap'); if (!el) return;
  var all = (window.LOCATIONS || []).filter(function (c) { return KDCAP.cpq || KDCAP_ZONES.indexOf(String(c).split('-')[0]) < 0; }), set = {}, kUse = {}, aUse = {};
  all.forEach(function (c) { set[c] = 1; });
  KD.rows.forEach(function (r) { if (set[r[0]]) kUse[r[0]] = 1; });
  var appReady = !!(MAP.loadedAt || MAP.items.length);
  mapAllItems().forEach(function (it) { if (set[it.loc] && !isTestUser(it.by)) aUse[it.loc] = 1; });
  var zones = {}, tot = { n: 0, used: 0, k: 0, a: 0 };
  all.forEach(function (c) {
    var z = String(c).split('-')[0], o = zones[z] || (zones[z] = { n: 0, used: 0, k: 0, a: 0 }), k = !!kUse[c], a = !!aUse[c];
    o.n++; tot.n++;
    if (k) { o.k++; tot.k++; }
    if (a) { o.a++; tot.a++; }
    if (k || a) { o.used++; tot.used++; }
  });
  var pct = function (x, n) { return n ? Math.round(x / n * 100) : 0; };
  var fmt = function (n) { return Number(n).toLocaleString('en-US'); };
  var kReady = KD.rows.length > 0;
  el.innerHTML = '<div class="kd-cap">' +
    '<div class="kd-cap-h">📦 พื้นที่ Location <span class="muted small">' + (kReady ? '' : 'รอยอด Kingdee… ') + (appReady ? '' : 'รอข้อมูลสแกน…') + '</span></div>' +
    '<div class="seg kd-cap-seg"><button type="button" data-kdcpq="1" class="' + (KDCAP.cpq ? 'active' : '') + '">รวม CO CP CQ</button>' +
      '<button type="button" data-kdcpq="0" class="' + (KDCAP.cpq ? '' : 'active') + '">ไม่รวม CO CP CQ</button></div>' +
    '<div class="stats kd-cap-stats"><div><b>' + fmt(tot.n) + '</b><span>ทั้งหมด</span></div>' +
      '<div><b class="kd-cap-used">' + fmt(tot.used) + '</b><span>ใช้แล้ว (' + pct(tot.used, tot.n) + '%)</span></div>' +
      '<div><b class="kd-cap-free">' + fmt(tot.n - tot.used) + '</b><span>ว่าง (' + pct(tot.n - tot.used, tot.n) + '%)</span></div></div>' +
    '<div class="kd-cap-bar" title="ใช้แล้ว ' + pct(tot.used, tot.n) + '%"><i style="width:' + pct(tot.used, tot.n) + '%"></i></div>' +
    '<div class="small muted">ใช้แล้ว = มีของใน Kingdee หรือมีกล่องที่สแกนในแอป · ไม่นับ Public area' + (KDCAP.cpq ? '' : ' · ไม่รวมโซน CO CP CQ') + ' · Kingdee มีของ ' + fmt(tot.k) + ' ช่อง · แอปสแกนแล้ว ' + fmt(tot.a) + ' ช่อง</div>' +
    '<details id="kdCapZ"' + (KDCAP.open ? ' open' : '') + '><summary class="small">แยกตามโซน</summary><table class="kd-cap-t"><thead><tr><th>โซน</th><th>ทั้งหมด</th><th>ใช้แล้ว</th><th>ว่าง</th><th>Kingdee</th><th>แอป</th><th></th></tr></thead><tbody>' +
      Object.keys(zones).sort().map(function (z) {
        var o = zones[z], p = pct(o.used, o.n);
        return '<tr><td><b>' + esc(z) + '</b></td><td>' + o.n + '</td><td>' + o.used + '</td><td class="kd-cap-free">' + (o.n - o.used) + '</td><td>' + o.k + '</td><td>' + o.a + '</td>' +
          '<td class="kd-cap-pc"><span class="kd-cap-mini"><i style="width:' + p + '%"></i></span>' + p + '%</td></tr>';
      }).join('') + '</tbody></table></details></div>';
  $('kdCapZ').addEventListener('toggle', function () { KDCAP.open = this.open; store('pda_kdcap_open', this.open ? '1' : '0'); });
  Array.prototype.forEach.call(el.querySelectorAll('[data-kdcpq]'), function (b) {
    b.onclick = function () { KDCAP.cpq = b.getAttribute('data-kdcpq') === '1'; store('pda_kdcap_cpq', KDCAP.cpq ? '1' : '0'); renderKdCap(); };
  });
}
function renderKdSnap() {
  var el = $('kdSnap'); if (!el) return;
  var st = $('kdStale'); if (st) st.innerHTML = kdStaleHtml();
  renderKdPub(); renderKdXfer(); renderKdCap();
  el.innerHTML = KD.loading ? '⏳ กำลังดึงยอด Kingdee…'
    : KD.err ? '<span class="err-text">' + esc(KD.err) + '</span>' + (KD.rows.length ? ' (ใช้ข้อมูลล่าสุดที่มี)' : '')
    : KD.snapshotAt ? 'ยอด Kingdee ณ <b>' + esc(fmtWhen(kdSnapText())) + '</b> · ' + KD.rows.length.toLocaleString() + ' แถว' : '';
}
function renderKdRound() {
  var el = $('kdRound'); if (!el) return;
  var r = KD.count && KD.count.round;
  el.innerHTML = (r
    ? '<span>📋 รอบนับ' + (r.name ? ' <b>' + esc(r.name) + '</b>' : '') + ' เริ่ม <b>' + esc(fmtWhen(r.start)) + '</b>' + (r.by ? ' · ตั้งโดย ' + esc(r.by) : '') + '</span>'
    : '<span class="muted">ยังไม่ได้ตั้งรอบนับ — เทียบกับของทั้งหมดในแอปตอนนี้</span>') +
    '<button class="btn small" id="kdRoundBtn">' + (r ? 'เริ่มรอบใหม่' : '▶ เริ่มรอบนับ') + '</button>' +
    '<button class="btn small" id="kdExport">⬇ Excel ผลต่าง</button>';
  $('kdRoundBtn').onclick = openKdRound;
  $('kdExport').onclick = exportKdDiff;
}
function openKdRound() {
  if (!S.user) { openUserModal(); return; }
  var now = new Date(), v = now.getFullYear() + '-' + pad(now.getMonth() + 1) + '-' + pad(now.getDate()) + 'T' + pad(now.getHours()) + ':' + pad(now.getMinutes());
  openModal('<h3>เริ่มรอบนับใหม่</h3>' +
    '<p class="small">ช่องที่มีการสแกน / ย้าย / กด "นับเสร็จ" <b>ตั้งแต่เวลานี้</b> จะนับเป็นของรอบนี้ ช่องอื่นแสดงเป็น "ยังไม่นับ" · ทุกเครื่องเห็นรอบเดียวกัน</p>' +
    '<label>ชื่อรอบ (ไม่บังคับ)</label><input id="kdrName" class="field" placeholder="เช่น นับใหญ่ ธ.ค. 69">' +
    '<label>เริ่มนับตั้งแต่</label><input id="kdrStart" class="field" type="datetime-local" value="' + v + '">' +
    '<div class="actions"><button class="btn primary" id="kdrOk">เริ่มรอบนับ</button><button class="btn" id="mCancel">ยกเลิก</button></div>');
  $('mCancel').onclick = closeModal;
  $('kdrOk').onclick = function () {
    var st = $('kdrStart').value.replace('T', ' ');
    this.disabled = true;
    api('setCountRound', { start: st, name: $('kdrName').value }, S.user).then(function (d) {
      KD.count = { round: d.round, marks: d.marks || {} }; storeJson('pda_kd_count', KD.count); kdCompute.key = null;
      closeModal(); toast('เริ่มรอบนับแล้ว'); kdRefreshViews();
    }, function (err) { toast(err.message, 3000); $('kdrOk').disabled = false; });
  };
}
function renderKdSummary(x) {
  var el = $('mapSum'); if (!el) return;
  var s = x.sum, pct = s.kBins ? Math.round(s.counted / s.kBins * 100) : 0;
  el.innerHTML = 'ช่องที่ Kingdee มีของ: นับแล้ว <b>' + s.counted.toLocaleString() + '</b> / ' + s.kBins.toLocaleString() + ' (' + pct + '%)' +
    ' · 🟢 ' + s.match + ' · 🟡 ' + s.diff + ' · 🔴 ' + s.missing + ' · 🟣 ' + s.extra + ' · ⚪ ' + s.todo +
    (MAP.err ? ' <span class="err-text">(อัปเดตผังไม่ได้: ' + esc(MAP.err) + ')</span>' : '') +
    (!KD.rows.length && !KD.loading ? ' <span class="err-text">· ยังไม่มียอด Kingdee</span>' : '');
  renderKdList(x);
}
function kdCellHtml(code, x) {
  var b = x.bins[code], cls = 'cell ' + (b ? 'kd-' + b.st : 'empty');
  var ag = KD.color === 'age' && b ? kdBinAge().bins[code] : null;
  if (KD.color === 'age') cls = 'cell ' + (ag ? 'kd-age kd-age' + kdAgeBand(ag.days) : b ? 'kd-age-none' : 'empty');
  if (b && b.marked) cls += ' kd-done';
  if (x.moved && x.moved[code]) cls += ' kd-moved';
  if (KDF.hits && KDF.hits[code]) cls += KDF.hits[code] === 'lot' ? ' kdf-hit' : ' kdf-hit2';
  if (KDF.pkgState === 'found' && KDF.pkgRecs.some(function (x) { return x.location === code; })) cls += ' kdf-pkg-cell';
  if (code === S.location) cls += ' cur';
  var txt = !b ? '' : b.st === 'todo' ? (b.nk > 1 ? b.nk : '') : b.st === 'diff' ? b.nd : b.st === 'extra' ? (b.na > 1 ? b.na : '') : '';
  if (KD.color === 'age') txt = ag ? ag.days : '';
  return '<td><button class="' + cls + '" data-cell="' + code + '" title="' + code + (ag ? ' · อยู่ช่องนี้ ' + kdAgeText(ag) : '') + (b ? ' · ' + KD_ST[b.st][1] + ' · Kingdee ' + b.nk + ' รายการ · นับได้ ' + b.na + ' รายการ' : '') + '">' + txt + '</button></td>';
}
// รายการช่องที่ต้องดู (กรองตามสถานะ)
function renderKdList(x) {
  renderKdXfer(); renderKdCap();
  var el = $('kdList'); if (!el) return;
  if (KD.color === 'age') {
    var ah = kdAgeListHtml();
    if (el._html !== ah) {
      el._html = ah; el.innerHTML = ah;
      Array.prototype.forEach.call(el.querySelectorAll('[data-kdc]'), function (b) {
        b.onclick = function () { var loc = b.getAttribute('data-kdc'); mapGotoCell(loc); setTimeout(function () { openKdCell(loc); }, 350); };
      });
      if ($('kdMore')) $('kdMore').onclick = function () { KD.more = (KD.more || 0) + 30; renderKdList(kdCompute()); };
      if ($('kdLess')) $('kdLess').onclick = function () { KD.more = 0; renderKdList(kdCompute()); };
      if ($('kdaXlsx')) $('kdaXlsx').onclick = exportKdAges;
    }
    return;
  }
  var f = KD.filter, list = Object.keys(x.bins).filter(function (loc) {
    var st = x.bins[loc].st; return f === 'diff' ? (st === 'diff' || st === 'missing' || st === 'extra') : st === f;
  }).sort();
  var chips = [['diff', 'ต้องตรวจ (' + (x.sum.diff + x.sum.missing + x.sum.extra) + ')'], ['todo', '⚪ ยังไม่นับ (' + x.sum.todo + ')'], ['match', '🟢 ตรง (' + x.sum.match + ')']];
  var lim = (mapWide() ? 30 : 5) + (KD.more || 0); // มือถือ: แสดงน้อยก่อน ไม่ทำกล่องเลื่อนซ้อนในหน้า · กดดูเพิ่มทีละ 30
  var shown = list.slice(0, lim);
  var html = '<div class="find-box"><div class="kd-chips">' + chips.map(function (c) {
      return '<button type="button" class="find-zone' + (f === c[0] ? ' on' : '') + '" data-kdf="' + c[0] + '">' + c[1] + '</button>';
    }).join('') + '</div>' +
    (list.length ? '<div class="find-list">' + shown.map(function (loc) {
      var b = x.bins[loc], first = b.keys[0];
      return '<button type="button" class="find-item" data-kdc="' + loc + '"><span class="kd-ico">' + KD_ST[b.st][0] + '</span>' +
        '<span class="find-main"><span class="find-top"><span class="loc-pill">' + loc + '</span> ' + KD_ST[b.st][1] + (b.marked ? ' ✔' : '') + '</span>' +
        '<span class="find-sub muted">Kingdee ' + b.nk + ' รายการ · นับได้ ' + b.na + ' รายการ' + (b.nd && b.st === 'diff' ? ' · ต่าง ' + b.nd : '') + '</span>' +
        (first ? '<span class="find-sub">' + esc(first.part) + (first.lot ? ' · ' + esc(first.lot) : '') + (b.keys.length > 1 ? ' +' + (b.keys.length - 1) : '') + (kdSpecOf(first.part) ? ' · ' + kdSpecHtml(first.part) : '') + '</span>' : '') +
        '</span></button>';
    }).join('') + '</div>' + (list.length > lim ? '<button type="button" class="btn small" id="kdMore">ดูเพิ่ม (อีก ' + (list.length - lim) + ' ช่อง)</button>' : '') +
      (KD.more ? ' <button type="button" class="btn small" id="kdLess">ย่อ</button>' : '')
    : '<div class="muted small center pad">ไม่มีรายการ</div>') + '</div>';
  if (el._html === html) return; // ไม่มีอะไรเปลี่ยน → ไม่วาดใหม่ (กันเด้ง/สะดุดตอนอัปเดตอัตโนมัติ)
  el._html = html; el.innerHTML = html;
  Array.prototype.forEach.call(el.querySelectorAll('[data-kdf]'), function (b) { b.onclick = function () { KD.filter = b.getAttribute('data-kdf'); KD.more = 0; renderKdList(kdCompute()); }; });
  Array.prototype.forEach.call(el.querySelectorAll('[data-kdc]'), function (b) {
    b.onclick = function () { var loc = b.getAttribute('data-kdc'); mapGotoCell(loc); setTimeout(function () { openKdCell(loc); }, 350); };
  });
  if ($('kdMore')) $('kdMore').onclick = function () { KD.more = (KD.more || 0) + 30; renderKdList(kdCompute()); };
  if ($('kdLess')) $('kdLess').onclick = function () { KD.more = 0; renderKdList(kdCompute()); };
}
// วันเวลาแบบสั้น 'yyyy-MM-dd HH:mm' → '17 พ.ย. 09:29'
function kdWhen(at) { return String(fmtWhen(String(at || '').slice(0, 16))).replace(/ \d{2} · /, ' '); }
// ความเคลื่อนไหว Kingdee ล่าสุดของ รหัส(+Lot) ที่ช่องนี้
function kdLastMove(loc, part, lot) {
  for (var i = 0; i < KDM.moves.length; i++) {
    var m = KDM.moves[i];
    if ((m[4] === loc || m[5] === loc) && m[2] === part && (KD.mode !== 'lot' || m[3] === lot)) return m;
  }
  return null;
}
// Spec ของรหัส (Kingdee ก่อน → BOM)
function kdSpecOf(part) {
  if (!kdSpecOf.map || kdSpecOf.n !== KD.rows.length) {
    kdSpecOf.map = {}; kdSpecOf.n = KD.rows.length;
    KD.rows.forEach(function (r) { if (r[6] && !kdSpecOf.map[r[1]]) kdSpecOf.map[r[1]] = r[6]; });
  }
  return kdSpecOf.map[part] || (bomInfo(part) || {}).spec || '';
}
function kdSpecHtml(part) { var sp = kdSpecOf(part); return sp ? '<span class="kd-spec">' + esc(sp) + '</span>' : ''; }
// ===== อายุในช่อง: ของวางอยู่ในช่องนี้มานานแค่ไหน =====
// แหล่งข้อมูล: (1) Kingdee — ไล่ย้อนรายการเข้า/ย้ายเข้าช่อง (ของเก่าออกก่อน) จากเซิร์ฟเวอร์ getBinAges
//              (2) เวลาสแกนกล่องที่ยังอยู่ในช่องครั้งแรกในแอป  (3) วันที่ใน Lot = อายุสูงสุดที่เป็นไปได้
// ถ้าของอยู่มาก่อนเริ่มเก็บประวัติ Kingdee → แสดงเป็น "≥ X วัน" (อย่างน้อย)
var KDA = { ages: storeJson('pda_kda') || {}, start: store('pda_kda_start') || '', loadedAt: 0, loading: false, err: '' };
KD.color = store('pda_kd_color') === 'age' ? 'age' : 'cmp';
var KDA_BANDS = [[7, '≤ 7 วัน'], [30, '8–30 วัน'], [90, '1–3 เดือน'], [1e9, '> 3 เดือน']];
function loadKdAges(force) {
  if (KDA.loading || (!force && Date.now() - KDA.loadedAt < 10 * 60000)) return;
  KDA.loading = true;
  api('getBinAges').then(function (d) {
    KDA.loading = false; KDA.loadedAt = Date.now(); KDA.err = '';
    KDA.ages = d.ages || {}; KDA.start = d.start || '';
    storeJson('pda_kda', KDA.ages); store('pda_kda_start', KDA.start);
    kdBinAge.key = null; kdRefreshViews(); if (S.view === 'kd') renderKdList(kdCompute());
  }, function (err) { KDA.loading = false; KDA.err = err.message; });
}
function kdTs(at) { var t = Date.parse(String(at || '').slice(0, 19).replace(' ', 'T')); return isNaN(t) ? 0 : t; }
function kdLotDate(lot) {
  var m = /^(20\d\d)(\d\d)(\d\d)/.exec(String(lot || '')); if (!m) return 0;
  var t = Date.parse(m[1] + '-' + m[2] + '-' + m[3] + 'T00:00:00'); return isNaN(t) ? 0 : t;
}
function kdDays(t) { return Math.max(0, Math.floor((Date.now() - t) / 86400000)); }
// อายุของ 1 แถว (รหัส/Lot) ในช่อง → { t: เวลาเริ่ม, days, min: true = อย่างน้อย, lotDays }
function kdAgeOf(loc, y) {
  var lots = y.lot ? [y.lot] : Object.keys(((y.k || y.a) || {}).lots || {});
  var kdT = 0, before = false, lotT = 0;
  if (y.k) lots.forEach(function (l) {
    var v = KDA.ages[loc + '|' + y.part + '|' + l];
    if (v === '') before = true; else if (v) { var t = kdTs(v); if (t && (!kdT || t < kdT)) kdT = t; }
  });
  lots.forEach(function (l) { var t = kdLotDate(l); if (t && (!lotT || t < lotT)) lotT = t; });
  var appT = y.a && y.a.at0 ? kdTs(y.a.at0) : 0, t = 0, min = false;
  if (before) { t = kdTs(KDA.start) || 0; min = true; }
  else if (kdT) t = kdT;
  if (appT && (!t || appT < t)) t = appT;
  if (!t) return null;
  if (lotT && lotT > t) t = lotT; // เข้าช่องก่อนผลิต Lot ไม่ได้
  return { t: t, days: kdDays(t), min: min, lotDays: lotT ? kdDays(lotT) : null };
}
function kdAgeText(g) { return g ? (g.min ? '≥ ' : '') + g.days + ' วัน' : '—'; }
function kdTsText(t) { var d = new Date(t); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()); }
function kdAgeBand(days) { for (var i = 0; i < KDA_BANDS.length; i++) if (days <= KDA_BANDS[i][0]) return i; return KDA_BANDS.length - 1; }
function kdAgeHtml(g) {
  if (!g) return '';
  return '<span class="kd-age kda-chip kd-age' + kdAgeBand(g.days) + '">🕒 อยู่ช่องนี้ ' + kdAgeText(g) + '</span>' +
    '<span class="small muted"> ' + (g.min ? 'ก่อน ' : 'ตั้งแต่ ') + esc(kdWhen(kdTsText(g.t))) +
    (g.lotDays != null ? ' · Lot ' + g.lotDays + ' วัน' : '') + '</span>';
}
// ทุกช่อง: แถวที่อยู่นานสุด (ของที่ Kingdee มี หรือแอปนับได้)
function kdBinAge() {
  var x = kdCompute(), key = kdCompute.key + '|' + KDA.loadedAt + '|' + KDA.start + '|' + Object.keys(KDA.ages).length + '|' + workDay();
  if (kdBinAge.key === key && kdBinAge.v) return kdBinAge.v;
  var out = {}, rows = [];
  Object.keys(x.bins).forEach(function (loc) {
    var b = x.bins[loc], best = null;
    b.keys.forEach(function (y) {
      var g = kdAgeOf(loc, y); if (!g) return;
      rows.push({ loc: loc, y: y, g: g });
      if (!best || g.days > best.days) best = g;
    });
    if (best) out[loc] = best;
  });
  rows.sort(function (a, b) { return b.g.days - a.g.days || (a.loc < b.loc ? -1 : 1); });
  kdBinAge.key = key;
  return (kdBinAge.v = { bins: out, rows: rows });
}
function kdAgeListHtml() {
  var A = kdBinAge(), rows = A.rows, n = rows.length;
  if (!n) return '<div class="find-box"><div class="muted small center pad">' + (KDA.loading ? '⏳ กำลังโหลดอายุในช่อง…' : 'ยังไม่มีข้อมูลอายุในช่อง') + '</div></div>';
  var sum = 0, nMin = 0, band = [0, 0, 0, 0];
  rows.forEach(function (r) { sum += r.g.days; if (r.g.min) nMin++; band[kdAgeBand(r.g.days)]++; });
  var lim = (mapWide() ? 30 : 8) + (KD.more || 0);
  return '<div class="find-box"><div class="kda-sum">อายุในช่องเฉลี่ย <b>' + (nMin ? '≥ ' : '') + (Math.round(sum / n * 10) / 10) + ' วัน</b> · ' + n.toLocaleString() + ' รายการ<br>' +
      KDA_BANDS.map(function (b, i) { return '<span class="kda-chip kd-age' + i + '">' + b[1] + ': ' + band[i] + '</span>'; }).join(' ') + '</div>' +
    '<div class="small muted">' + (KDA.start ? 'ประวัติ Kingdee เริ่มเก็บ ' + esc(kdWhen(KDA.start)) + ' — ของที่อยู่ก่อนนั้นแสดงเป็น "≥" (อย่างน้อย) · ' : '') + 'อายุ Lot = อายุมากสุดที่เป็นไปได้ ' +
      '<button type="button" class="btn small" id="kdaXlsx">⬇ Excel</button></div>' +
    '<div class="sec-title small"><span>อยู่นานสุด</span></div><div class="find-list">' + rows.slice(0, lim).map(function (r) {
      var nm = (r.y.k && r.y.k.name) || (bomInfo(r.y.part) || {}).name || '';
      return '<button type="button" class="find-item" data-kdc="' + r.loc + '"><span class="kda-days kd-age' + kdAgeBand(r.g.days) + '">' + (r.g.min ? '≥' : '') + r.g.days + '<small>วัน</small></span>' +
        '<span class="find-main"><span class="find-top"><span class="loc-pill">' + r.loc + '</span> <b>' + esc(r.y.part) + '</b>' + (r.y.lot ? ' · ' + esc(r.y.lot) : '') + '</span>' +
        '<span class="find-sub muted">' + esc(nm) + (kdSpecOf(r.y.part) ? ' · ' + kdSpecHtml(r.y.part) : '') + '</span>' +
        '<span class="find-sub small muted">' + (r.g.min ? 'ก่อน ' : 'ตั้งแต่ ') + esc(kdWhen(kdTsText(r.g.t))) + (r.g.lotDays != null ? ' · Lot ' + r.g.lotDays + ' วัน' : '') +
          (r.y.k ? ' · Kingdee ' + kdFmt(r.y.k.q) + ' ' + esc(r.y.k.unit) : ' · แอปนับได้ ' + (r.y.a.noQty ? '?' : kdFmt(r.y.a.q))) + '</span></span></button>';
    }).join('') + '</div>' + (n > lim ? '<button type="button" class="btn small" id="kdMore">ดูเพิ่ม (อีก ' + (n - lim) + ')</button>' : '') +
    (KD.more ? ' <button type="button" class="btn small" id="kdLess">ย่อ</button>' : '') + '</div>';
}
// ======================= รอโอนเข้า Kingdee (ดูอย่างเดียว — ยังไม่ส่งอะไรเข้า Kingdee) =======================
// กติกา: จับคู่ รหัส + Lot · จำนวน = ผลรวมกล่องที่สแกนในช่อง ลบยอดที่ Kingdee มีอยู่แล้วในช่องนั้น
// ต้นทาง: Public area ก่อน → ช่องที่แอปไม่เคยสแกนเจอ Lot นี้ → (สุดท้าย) ช่องที่สแกนเจอน้อยกว่า Kingdee · คลังปลายทาง = คลังต้นทาง
var KDX = { open: false, t: '', zone: '', q: '', per: 'all', n: 40 };
function kdxTol(q) { return Math.max(0.001, Math.abs(q || 0) * 0.0005); }
function kdXferCompute() {
  var items = mapAllItems().filter(function (it) { return !isTestUser(it.by) && it.part; });
  var key = [KD.rows.length, KD.pub.length, KD.snapshotAt, MAP.itemsSig, items.length, MAP.loadedAt].join('|');
  if (kdXferCompute.key === key && kdXferCompute.v) return kdXferCompute.v;
  var A = {}, K = {};
  items.forEach(function (it) {
    var g = A[it.part + '|' + it.lot] || (A[it.part + '|' + it.lot] = {});
    var x = g[it.loc] || (g[it.loc] = { q: 0, n: 0, noQty: 0, unit: it.unit || '', pending: 0 });
    var q = kdNum(it.qty); if (q == null) x.noQty++; else x.q += q;
    x.n++; if (it.pending) x.pending++;
    if (it.at && (!x.at || it.at > x.at)) { x.at = it.at; x.by = it.by; }
  });
  KD.rows.concat(KD.pub).forEach(function (r) {
    var g = K[r[1] + '|' + r[2]] || (K[r[1] + '|' + r[2]] = {}), id = r[0] + '|' + r[7];
    var e = g[id] || (g[id] = { loc: r[0], wh: r[7], q: 0, unit: r[4], name: r[5], spec: r[6] });
    e.q += r[3];
  });
  var lines = [], chk = [];
  Object.keys(A).forEach(function (k) {
    var a = A[k], g = K[k] || {}, kl = Object.keys(g).map(function (id) { return g[id]; });
    var part = k.split('|')[0], lot = k.slice(part.length + 1), info = kl[0] || bomInfo(part) || {};
    var base = { part: part, lot: lot, name: info.name || '', spec: info.spec || '', unit: info.unit || (a[Object.keys(a)[0]] || {}).unit || '' };
    var kAt = {}; kl.forEach(function (e) { kAt[e.loc] = (kAt[e.loc] || 0) + e.q; });
    var needs = [];
    Object.keys(a).sort().forEach(function (loc) {
      var x = a[loc], at = { to: loc, at: x.at, by: x.by, boxes: x.n, pending: x.pending };
      if (x.noQty) { chk.push(Object.assign({ why: 'noqty', qty: x.q }, base, at)); return; }
      if (kl.length && info.unit && x.unit && x.unit.toUpperCase() !== String(info.unit).toUpperCase()) {
        chk.push(Object.assign({ why: 'unit', qty: x.q, aunit: x.unit }, base, at)); return;
      }
      var need = x.q - (kAt[loc] || 0);
      if (need > kdxTol(x.q)) needs.push(Object.assign({ need: need, scanned: x.q }, at));
    });
    if (!needs.length) return;
    if (!kl.length) { needs.forEach(function (n) { chk.push(Object.assign({ why: 'nolot', qty: n.need }, base, n)); }); return; }
    var pub = kl.filter(function (e) { return e.loc === 'Public area'; });
    var free = kl.filter(function (e) { return e.loc !== 'Public area' && !a[e.loc]; }).sort(function (p, q) { return q.q - p.q; });
    var part2 = kl.filter(function (e) { return e.loc !== 'Public area' && a[e.loc] && e.q - a[e.loc].q > kdxTol(e.q); });
    var src = pub.map(function (e) { return { e: e, left: e.q, type: 'pub' }; })
      .concat(free.map(function (e) { return { e: e, left: e.q, type: 'bin' }; }))
      .concat(part2.map(function (e) { return { e: e, left: e.q - a[e.loc].q, type: 'bin', partial: true }; }));
    needs.forEach(function (n) {
      var need = n.need;
      src.forEach(function (s) {
        if (need <= kdxTol(n.need) || s.left <= kdxTol(s.e.q)) return;
        var take = Math.min(need, s.left);
        lines.push(Object.assign({}, base, n, {
          from: s.e.loc, wh: s.e.wh, qty: take, type: s.type, partial: !!s.partial, unit: s.e.unit || base.unit,
          defect: /defect|scrap/i.test(s.e.wh)
        }));
        s.left -= take; need -= take;
      });
      if (need > kdxTol(n.need)) chk.push(Object.assign({ why: 'short', qty: need }, base, n));
    });
  });
  lines.forEach(function (l) { l.hold = l.defect; });
  kdXferCompute.key = key;
  return (kdXferCompute.v = { lines: lines, chk: chk });
}
function kdxDayOk(at) {
  if (KDX.per === 'all') return true;
  var d = workShiftDate(at); if (!d) return false;
  return KDX.per === 'today' ? d === workDay() : d >= workDay(Date.now() - 6 * 86400000);
}
function kdxRows(v) {
  var q = KDX.q.trim().toUpperCase().split(/\s+/).filter(String);
  var all = v.lines.map(function (l) { return Object.assign({ kind: l.hold || l.partial ? 'chk' : l.type }, l); })
    .concat(v.chk.map(function (c) { return Object.assign({ kind: 'chk', review: true }, c); }));
  return all.filter(function (r) {
    if (KDX.zone && r.to.split('-')[0] !== KDX.zone) return false;
    if (!kdxDayOk(r.at)) return false;
    if (!q.length) return true;
    var hay = (r.part + ' ' + r.lot + ' ' + r.name + ' ' + r.spec + ' ' + r.to + ' ' + (r.from || '')).toUpperCase();
    return q.every(function (w) { return hay.indexOf(w) >= 0; });
  });
}
var KDX_WHY = {
  nolot: '⚠ Kingdee ไม่มี Lot นี้เลย — ไม่ทำใบโอน ต้องตรวจ (รับเข้าไม่ครบ / ป้ายผิด / Lot พิมพ์ผิด)',
  short: '⚠ สแกนเจอมากกว่าที่ Kingdee มีให้โอน — ส่วนที่ขาด',
  unit: '⚠ หน่วยไม่ตรงกับ Kingdee',
  noqty: '⚠ มีกล่องที่ไม่มีจำนวน — ใส่จำนวนก่อน'
};
function kdxRowHtml(r) {
  var u = esc(r.unit || ''), whS = esc(kdPubWhShort(r.wh));
  var route = r.review ? '<span class="kdx-why">' + KDX_WHY[r.why] + (r.why === 'unit' ? ' (สแกน ' + esc(r.aunit) + ' / Kingdee ' + u + ')' : '') + '</span> → <span class="loc-pill">' + esc(r.to) + '</span>'
    : (r.type === 'pub' ? '📥 Public area' : '🔁 <span class="loc-pill">' + esc(r.from) + '</span>') + ' → <span class="loc-pill">' + esc(r.to) + '</span> <span class="small muted">' + whS + '</span>';
  var flags = [];
  if (r.defect) flags.push('⚠ คลัง Defective / Scrap — ให้คนตรวจก่อน');
  if (r.partial) flags.push('⚠ ตัดจากช่องที่สแกนเจอ Lot นี้น้อยกว่า Kingdee — อาจยังนับไม่ครบ');
  if (r.pending) flags.push('⏳ ยังไม่ส่งขึ้นเซิร์ฟเวอร์');
  return '<div class="kdp-row kdx-row' + (r.kind === 'chk' ? ' kdx-chk' : '') + '"><span class="kdp-main"><b>' + esc(r.part) + '</b> ' + esc(r.name) +
      (r.spec ? ' <span class="kd-spec">' + esc(r.spec) + '</span>' : '') + '<span class="small muted"> · Lot ' + esc(r.lot || '-') + '</span>' +
      '<div class="kdx-route">' + route + '</div>' +
      '<div class="small muted">สแกน ' + r.boxes + ' กล่อง' + (r.scanned != null ? ' รวม ' + kdFmt(r.scanned) : '') + (r.by ? ' · ' + esc(r.by) : '') + (r.at ? ' · ' + esc(kdWhen(r.at)) : '') + '</div>' +
      (flags.length ? '<div class="small kdx-flag">' + flags.join('<br>') + '</div>' : '') + '</span>' +
    '<span class="kdp-q"><b>' + kdFmt(r.qty) + '</b> <span class="small muted">' + (r.why === 'unit' ? esc(r.aunit) : u) + '</span></span></div>';
}
function renderKdXfer() {
  var el = $('kdXfer'); if (!el) return;
  if (!KD.rows.length) { el.innerHTML = ''; return; }
  if (document.activeElement && document.activeElement.id === 'kdxQ') return; // กำลังพิมพ์กรอง — อย่าวาดทับ
  var v = kdXferCompute(), nPub = 0, nBin = 0, nChk = v.chk.length;
  v.lines.forEach(function (l) { if (l.hold || l.partial) nChk++; else if (l.type === 'pub') nPub++; else nBin++; });
  var head = '<summary>📝 <b>รอโอนเข้า Kingdee</b> — 📥 ' + nPub + ' · 🔁 ' + nBin + ' · ⚠ ' + nChk + ' <span class="small muted">(ดูอย่างเดียว ยังไม่ส่งเข้า Kingdee)</span></summary>';
  if (!KDX.open) { el.innerHTML = '<details class="kdp kdx" id="kdxD">' + head + '</details>'; bindKdXfer(); return; }
  var rows = kdxRows(v), cnt = { '': rows.length, pub: 0, bin: 0, chk: 0 }, zones = {};
  rows.forEach(function (r) { cnt[r.kind]++; });
  v.lines.concat(v.chk).forEach(function (r) { var z = r.to.split('-')[0]; zones[z] = (zones[z] || 0) + 1; });
  var shown = rows.filter(function (r) { return !KDX.t || r.kind === KDX.t; });
  function chip(attr, val, cur, label) { return '<button type="button" class="kda-chip' + (cur === val ? ' on' : '') + '" data-' + attr + '="' + esc(val) + '">' + label + '</button>'; }
  el.innerHTML = '<details class="kdp kdx" id="kdxD" open>' + head +
    '<div class="small muted">แอปเทียบของที่สแกนอยู่ในช่องตอนนี้กับยอด Kingdee (รหัส + Lot) · จำนวน = ผลรวมกล่องที่สแกน ลบยอดที่ Kingdee มีในช่องนั้นอยู่แล้ว · ตัดจาก Public area ก่อน · ยังไม่มีปุ่มส่ง</div>' +
    '<div class="kdp-chips">' + chip('kdxt', '', KDX.t, 'ทั้งหมด ' + cnt['']) + chip('kdxt', 'pub', KDX.t, '📥 จาก Public area ' + cnt.pub) +
      chip('kdxt', 'bin', KDX.t, '🔁 จากช่องอื่น ' + cnt.bin) + chip('kdxt', 'chk', KDX.t, '⚠ ต้องตรวจ ' + cnt.chk) + '</div>' +
    '<div class="kdp-chips">' + chip('kdxz', '', KDX.zone, 'ทุกโซน') + Object.keys(zones).sort().map(function (z) { return chip('kdxz', z, KDX.zone, esc(z) + ' ' + zones[z]); }).join('') +
      '<span class="kdx-sep"></span>' + chip('kdxp', 'all', KDX.per, 'ทุกวัน') + chip('kdxp', 'today', KDX.per, 'สแกนวันนี้') + chip('kdxp', '7d', KDX.per, '7 วัน') + '</div>' +
    '<div class="kdp-bar"><input id="kdxQ" class="field" placeholder="กรอง รหัส · Lot · ชื่อ · ช่อง" value="' + esc(KDX.q) + '" autocomplete="off">' +
      '<button type="button" class="btn small" id="kdxXlsx" title="Excel สำหรับตรวจ (ไม่ใช่ไฟล์นำเข้า Kingdee)">⬇ Excel ตรวจ</button></div>' +
    '<div class="kdp-list">' + (shown.length ? shown.slice(0, KDX.n).map(kdxRowHtml).join('') : '<div class="small muted">ไม่มีรายการ</div>') + '</div>' +
    (shown.length > KDX.n ? '<button type="button" class="btn small" id="kdxMore">ดูเพิ่ม (เหลือ ' + (shown.length - KDX.n) + ')</button>' : '') +
  '</details>';
  bindKdXfer();
}
function bindKdXfer() {
  var d = $('kdxD'); if (!d) return;
  d.addEventListener('toggle', function () { if (KDX.open !== d.open) { KDX.open = d.open; renderKdXfer(); } });
  [['kdxt', 't'], ['kdxz', 'zone'], ['kdxp', 'per']].forEach(function (p) {
    Array.prototype.forEach.call(d.querySelectorAll('[data-' + p[0] + ']'), function (b) {
      b.onclick = function () { KDX[p[1]] = b.getAttribute('data-' + p[0]); KDX.n = 40; renderKdXfer(); };
    });
  });
  if ($('kdxMore')) $('kdxMore').onclick = function () { KDX.n += 100; renderKdXfer(); };
  if ($('kdxXlsx')) $('kdxXlsx').onclick = exportKdXfer;
  var q = $('kdxQ'), tm = 0;
  if (q) q.addEventListener('input', function () { clearTimeout(tm); tm = setTimeout(function () {
    KDX.q = q.value; KDX.n = 40; q.blur(); renderKdXfer(); var n = $('kdxQ'); if (n) { n.focus(); n.setSelectionRange(n.value.length, n.value.length); } }, 300); });
}
function exportKdXfer() {
  var rows = kdxRows(kdXferCompute()).filter(function (r) { return !KDX.t || r.kind === KDX.t; });
  if (!rows.length) { toast('ไม่มีรายการ'); return; }
  loadScriptOnce(XLSX_URL).then(function () {
    var wb = XLSX.utils.book_new();
    var ws = XLSX.utils.json_to_sheet(rows.map(function (r) {
      return { 'ประเภท': r.review ? 'ต้องตรวจ' : r.type === 'pub' ? 'จาก Public area' : 'จากช่องอื่น', 'รหัส': r.part, 'ชื่อ': r.name, 'Spec': r.spec, 'Lot': r.lot,
        'คลัง': r.wh || '', 'จากช่อง': r.review ? '' : r.from, 'ไปช่อง': r.to, 'จำนวนโอน': r.qty, 'หน่วย': r.unit,
        'หมายเหตุ': r.review ? KDX_WHY[r.why].replace(/^⚠ /, '') : [r.defect ? 'คลัง Defective/Scrap' : '', r.partial ? 'ตัดจากช่องที่อาจนับไม่ครบ' : ''].filter(String).join(' · '),
        'สแกนโดย': r.by || '', 'เวลาสแกน': r.at || '' };
    }));
    ws['!cols'] = [14, 14, 28, 16, 12, 30, 12, 12, 10, 6, 36, 12, 16].map(function (w) { return { wch: w }; });
    XLSX.utils.book_append_sheet(wb, ws, 'รอโอน (ตรวจ)');
    XLSX.writeFile(wb, 'รอโอนKingdee_ตรวจ_' + workDay() + '.xlsx');
  }, function () { toast('โหลดตัวสร้าง Excel ไม่ได้ (ต้องต่ออินเทอร์เน็ต)', 3000); });
}
// ======================= Public area (ของที่ Kingdee ยังไม่ได้ลงช่อง) =======================
var KDP = { open: false, wh: '', n: 50, q: '' };
function kdPubWhShort(w) { return String(w || '').replace(/ ?Warehouse/ig, '').replace(/Semi-finished Product/i, 'Semi').replace(/Finished Product/i, 'FG').trim(); }
function kdPubRows() {
  var q = KDP.q.trim().toUpperCase().split(/\s+/).filter(String);
  return KD.pub.filter(function (r) {
    if (KDP.wh && r[7] !== KDP.wh) return false;
    if (!q.length) return true;
    var hay = (r[1] + ' ' + r[2] + ' ' + r[5] + ' ' + r[6]).toUpperCase();
    return q.every(function (w) { return hay.indexOf(w) >= 0; });
  }).sort(function (a, b) { return (kdLotDate(a[2]) || 9e15) - (kdLotDate(b[2]) || 9e15) || (a[1] < b[1] ? -1 : 1); });
}
function kdPubRowHtml(r) {
  var t = kdLotDate(r[2]);
  return '<div class="kdp-row"><span class="kdp-main"><b>' + esc(r[1]) + '</b> ' + esc(r[5]) + (r[6] ? ' <span class="kd-spec">' + esc(r[6]) + '</span>' : '') +
    '<span class="small muted"> · Lot ' + esc(r[2] || '-') + ' · ' + esc(kdPubWhShort(r[7])) + '</span></span>' +
    '<span class="kdp-q"><span><b>' + kdFmt(r[3]) + '</b> <span class="small muted">' + esc(r[4]) + '</span></span>' + (t ? '<span class="small muted kdp-d">Lot ' + kdDays(t) + ' วัน</span>' : '') + '</span></div>';
}
function renderKdPub() {
  var el = $('kdPub'); if (!el) return;
  if (!KD.pub.length) { el.innerHTML = ''; return; }
  var byWh = {}; KD.pub.forEach(function (r) { byWh[r[7]] = (byWh[r[7]] || 0) + 1; });
  var whs = Object.keys(byWh).sort(function (a, b) { return byWh[b] - byWh[a]; });
  var head = '<summary>📥 <b>Public area</b> — ของที่ Kingdee ยังไม่ได้ลงช่อง <b>' + KD.pub.length.toLocaleString() + '</b> รายการ · ' + whs.length + ' คลัง</summary>';
  if (!KDP.open) { el.innerHTML = '<details class="kdp" id="kdpD">' + head + '</details>'; bindKdPub(); return; }
  var rows = kdPubRows();
  el.innerHTML = '<details class="kdp" id="kdpD" open>' + head +
    '<div class="kdp-chips"><button type="button" class="kda-chip' + (KDP.wh ? '' : ' on') + '" data-kdpwh="">ทั้งหมด ' + KD.pub.length + '</button>' +
      whs.map(function (w) { return '<button type="button" class="kda-chip' + (KDP.wh === w ? ' on' : '') + '" data-kdpwh="' + esc(w) + '" title="' + esc(w) + '">' + esc(kdPubWhShort(w)) + ' ' + byWh[w] + '</button>'; }).join('') + '</div>' +
    '<div class="kdp-bar"><input id="kdpQ" class="field" placeholder="กรอง รหัส · Lot · ชื่อ · Spec" value="' + esc(KDP.q) + '" autocomplete="off">' +
      '<button type="button" class="btn small" id="kdpXlsx">⬇ Excel</button></div>' +
    '<div class="small muted">' + rows.length.toLocaleString() + ' รายการ · เรียง Lot เก่าสุดก่อน</div>' +
    '<div class="kdp-list">' + rows.slice(0, KDP.n).map(kdPubRowHtml).join('') + '</div>' +
    (rows.length > KDP.n ? '<button type="button" class="btn small" id="kdpMore">ดูเพิ่ม (เหลือ ' + (rows.length - KDP.n) + ')</button>' : '') +
  '</details>';
  bindKdPub();
}
function bindKdPub() {
  var d = $('kdpD'); if (!d) return;
  d.addEventListener('toggle', function () { if (KDP.open !== d.open) { KDP.open = d.open; renderKdPub(); } });
  Array.prototype.forEach.call(d.querySelectorAll('[data-kdpwh]'), function (b) { b.onclick = function () { KDP.wh = b.getAttribute('data-kdpwh'); KDP.n = 50; renderKdPub(); }; });
  if ($('kdpMore')) $('kdpMore').onclick = function () { KDP.n += 100; renderKdPub(); };
  if ($('kdpXlsx')) $('kdpXlsx').onclick = exportKdPub;
  var q = $('kdpQ'), tm = 0;
  if (q) q.addEventListener('input', function () { clearTimeout(tm); tm = setTimeout(function () {
    KDP.q = q.value; KDP.n = 50; renderKdPub(); var n = $('kdpQ'); if (n) { n.focus(); n.setSelectionRange(n.value.length, n.value.length); } }, 300); });
}
function exportKdPub() {
  var rows = kdPubRows(); if (!rows.length) { toast('ไม่มีรายการ'); return; }
  loadScriptOnce(XLSX_URL).then(function () {
    var wb = XLSX.utils.book_new();
    var ws = XLSX.utils.json_to_sheet(rows.map(function (r) {
      var t = kdLotDate(r[2]);
      return { 'คลัง': r[7], 'รหัส': r[1], 'ชื่อ': r[5], 'Spec': r[6], 'Lot': r[2], 'จำนวน': r[3], 'หน่วย': r[4], 'อายุ Lot (วัน)': t ? kdDays(t) : '' };
    }));
    ws['!cols'] = [34, 14, 30, 18, 12, 10, 6, 10].map(function (w) { return { wch: w }; });
    XLSX.utils.book_append_sheet(wb, ws, 'Public area');
    XLSX.writeFile(wb, 'PublicArea_' + workDay() + '.xlsx');
  }, function () { toast('โหลดตัวสร้าง Excel ไม่ได้ (ต้องต่ออินเทอร์เน็ต)', 3000); });
}
function exportKdAges() {
  var rows = kdBinAge().rows; if (!rows.length) { toast('ยังไม่มีข้อมูล'); return; }
  loadScriptOnce(XLSX_URL).then(function () {
    var wb = XLSX.utils.book_new();
    var ws = XLSX.utils.json_to_sheet(rows.map(function (r) {
      var y = r.y, info = bomInfo(y.part) || {};
      return { 'Location': r.loc, 'รหัส': y.part, 'Lot': y.lot || Object.keys(((y.k || y.a) || {}).lots || {}).join(', '), 'ชื่อ': (y.k && y.k.name) || info.name || '', 'Spec': kdSpecOf(y.part),
        'อยู่ในช่อง (วัน)': r.g.days, 'อย่างน้อย': r.g.min ? 'ใช่ (อยู่ก่อนเริ่มเก็บประวัติ)' : '', 'ตั้งแต่': kdTsText(r.g.t), 'อายุ Lot (วัน)': r.g.lotDays == null ? '' : r.g.lotDays,
        'Kingdee จำนวน': y.k ? y.k.q : '', 'หน่วย': y.k ? y.k.unit : (y.a ? y.a.unit : ''), 'คลัง': y.k ? y.k.wh : '', 'นับได้ในแอป': y.a && !y.a.noQty ? y.a.q : '' };
    }));
    ws['!cols'] = [12, 14, 12, 30, 18, 10, 22, 16, 10, 12, 6, 28, 10].map(function (w) { return { wch: w }; });
    XLSX.utils.book_append_sheet(wb, ws, 'อายุในช่อง');
    XLSX.writeFile(wb, 'อายุในช่อง_' + workDay() + '.xlsx');
  }, function () { toast('โหลดตัวสร้าง Excel ไม่ได้ (ต้องต่ออินเทอร์เน็ต)', 3000); });
}
// ตารางเทียบในช่อง
function kdTableHtml(b, compact) {
  if (!b || !b.keys.length) return '<div class="muted small center pad">ทั้ง Kingdee และในแอปไม่มีของในช่องนี้</div>';
  return '<table class="kd-table"><thead><tr><th>รหัส' + (KD.mode === 'lot' ? ' · Lot' : '') + '</th><th class="num">Kingdee</th><th class="num">นับได้</th>' + (compact ? '' : '<th class="num">ต่าง</th>') + '</tr></thead><tbody>' +
    b.keys.map(function (y) {
      var info = bomInfo(y.part) || {}, name = (y.k && y.k.name) || info.name || '';
      var diff = y.k && y.a && !y.a.noQty && !y.unitBad ? y.a.q - y.k.q : null;
      var ico = y.eq ? '✅' : !y.a ? (b.st === 'todo' ? '○' : '❌') : !y.k ? '➕' : '⚠';
      var km = kdLastMove(b.loc, y.part, y.lot);
      return '<tr class="' + (y.eq ? 'ok' : 'bad') + '"><td><span class="kd-ico">' + ico + '</span><b>' + esc(y.part) + '</b>' + (y.lot ? '<br><span class="small">Lot ' + esc(y.lot) + '</span>' : '') +
          (name && !compact ? '<br><span class="small muted">' + esc(name) + '</span>' : '') +
          (kdSpecOf(y.part) ? '<br>' + kdSpecHtml(y.part) : '') +
          (function () { var g = kdAgeOf(b.loc, y); return g ? '<br>' + kdAgeHtml(g) : ''; })() + '</td>' +
        '<td class="num">' + (y.k ? kdFmt(y.k.q) + ' <span class="small muted">' + esc(y.k.unit) + '</span>' : '—') +
          (km ? '<br><span class="kd-when">' + (km[1] === 'out' || (km[1] === 'move' && km[4] === b.loc) ? 'ออก ' : 'เข้า ') + esc(kdWhen(km[0])) + '</span>'
            : y.k ? '<br><span class="kd-when muted">ยอด ณ ' + esc(kdWhen(kdSnapText())) + '</span>' : '') + '</td>' +
        '<td class="num">' + (y.a ? (y.a.noQty ? '<span class="small">ไม่ระบุจำนวน</span>' : kdFmt(y.a.q)) + ' <span class="small muted">' + esc(y.a.unit) + '</span><br><span class="small muted">' + y.a.n + ' กล่อง' + (y.a.pending ? ' · รอส่ง ' + y.a.pending : '') + '</span>' +
          (y.a.at ? '<br><span class="kd-when">' + (y.a.at0 && y.a.at0.slice(0, 10) !== y.a.at.slice(0, 10) ? esc(kdWhen(y.a.at0)) + ' – ' : '') + esc(kdWhen(y.a.at)) + '</span>' +
            (y.a.by && !compact ? '<br><span class="small muted">' + esc(y.a.by) + '</span>' : '') : '') : '—') + '</td>' +
        (compact ? '' : '<td class="num">' + (y.unitBad ? '<span class="small">หน่วยต่างกัน</span>' : diff == null ? (y.k && !y.a ? '−' + kdFmt(y.k.q) : y.a && !y.k ? '+' + kdFmt(y.a.q) : '') : diff ? (diff > 0 ? '+' : '') + kdFmt(diff) : '0') + '</td>') +
      '</tr>';
    }).join('') + '</tbody></table>';
}
function openKdCell(code) {
  var x = kdCompute(), b = x.bins[code], st = b ? b.st : null;
  openModal('<h3>เทียบ Kingdee <span class="loc-pill">' + esc(code) + '</span></h3>' +
    '<p class="small">' + (st ? KD_ST[st][0] + ' <b>' + KD_ST[st][1] + '</b> — ' + KD_ST[st][2] : 'ไม่มีข้อมูล') +
      (b && b.marked ? '<br>✔ กดนับเสร็จโดย ' + esc(b.marked[1]) + ' · ' + esc(fmtWhen(b.marked[0])) : '') +
      (b && b.last ? '<br><span class="muted">เคลื่อนไหวล่าสุดในแอป ' + esc(agoText(b.last)) + '</span>' : '') + '</p>' +
    '<div class="kd-scroll">' + kdTableHtml(b) +
      (function () {
        var h = KDM.moves.filter(function (m) { return m[4] === code || m[5] === code; }).slice(0, 15);
        return h.length ? '<div class="sec-title small"><span>📈 ความเคลื่อนไหว Kingdee ของช่องนี้</span></div><div class="find-list">' + h.map(function (m) { return kdmRowHtml(m); }).join('') + '</div>' : '';
      })() + '</div>' +
    '<p class="muted small">ยอด Kingdee ณ ' + esc(fmtWhen(kdSnapText())) + ' · ระดับ ' + (KD.mode === 'lot' ? 'รหัส + Lot' : 'รหัส') + '</p>' +
    '<div class="actions">' +
      '<button class="btn ' + (b && b.marked ? '' : 'primary') + '" id="kdMark">' + (b && b.marked ? 'ยกเลิก "นับเสร็จ"' : '✔ นับช่องนี้เสร็จ') + '</button>' +
      '<button class="btn" id="cellUse">📍 ไปนับช่องนี้</button><button class="btn" id="mCancel">ปิด</button></div>');
  $('mCancel').onclick = closeModal;
  $('cellUse').onclick = function () { S.location = code; store('pda_loc', code); closeModal(); S.view = 'scan'; render(); toast('ตั้ง Location เป็น ' + code); };
  $('kdMark').onclick = function () {
    if (!S.user) { openUserModal(); return; }
    var done = !(b && b.marked), btn = this; btn.disabled = true;
    api('markBinCounted', code, done, S.user).then(function (d) {
      KD.count = { round: d.round, marks: d.marks || {} }; storeJson('pda_kd_count', KD.count); kdCompute.key = null;
      closeModal(); toast(done ? 'บันทึก ' + code + ' นับเสร็จแล้ว' : 'ยกเลิกนับเสร็จ ' + code); kdRefreshViews();
    }, function (err) { btn.disabled = false; toast(err.message, 3000); });
  };
}
// หน้าสแกน: Kingdee บอกว่าช่องนี้มีอะไร → ติ๊กเมื่อสแกนเจอ
function renderKdLoc() {
  var el = $('kdLoc'); if (!el) return;
  if (!S.location) { el.innerHTML = ''; return; }
  if (!KD.checkedAt && !KD.loading) kdCheck();
  if (!KD.rows.length) { el.innerHTML = ''; return; }
  if (Date.now() - KDM.loadedAt > 15 * 60000 && !KDM.loading) loadKdMoves(); // รู้ว่ายอด Kingdee ค้างหรือไม่
  var b = kdCompute().bins[S.location], open = store('pda_kd_scan') !== '0';
  if (!b || !b.nk) { el.innerHTML = '<div class="kd-loc muted small">Kingdee: ไม่มีของในช่องนี้</div>'; return; }
  var found = b.keys.filter(function (y) { return y.k && y.a; }).length;
  el.innerHTML = '<div class="kd-loc"><button type="button" class="kd-loc-head" id="kdLocT"><span>📦 Kingdee: ช่องนี้มี <b>' + b.nk + '</b> รายการ · สแกนเจอ <b>' + found + '</b>' +
      (found === b.nk && b.nd === 0 ? ' ✅ ครบ' : '') + kdStaleHtml(true) + '</span><span>' + (open ? '▲' : '▼') + '</span></button>' +
    (open ? kdTableHtml(b, true) : '') + '</div>';
  $('kdLocT').onclick = function () { store('pda_kd_scan', open ? '0' : '1'); renderKdLoc(); };
}
// Excel ผลต่าง (ทุกช่องที่ไม่ตรง + ยังไม่นับ)
function exportKdDiff() {
  var x = kdCompute();
  loadScriptOnce(XLSX_URL).then(function () {
    var rows = [];
    Object.keys(x.bins).sort().forEach(function (loc) {
      var b = x.bins[loc];
      b.keys.forEach(function (y) {
        if (y.eq && b.st === 'match') return;
        var info = bomInfo(y.part) || {};
        rows.push({
          'Location': loc, 'สถานะช่อง': KD_ST[b.st][1], 'รายการ': b.st === 'todo' ? 'ยังไม่นับ' : y.eq ? 'ตรง' : !y.a ? 'ไม่เจอ' : !y.k ? 'เกิน (Kingdee ไม่มี)' : y.unitBad ? 'หน่วยต่างกัน' : y.a.noQty ? 'ไม่ระบุจำนวน' : 'จำนวนไม่ตรง',
          'รหัสสินค้า': y.part, 'ชื่อ': (y.k && y.k.name) || info.name || '', 'Spec': (y.k && y.k.spec) || info.spec || '',
          'Lot': KD.mode === 'lot' ? y.lot : Object.keys((y.k || y.a).lots).join(', '),
          'Kingdee จำนวน': y.k ? y.k.q : '', 'Kingdee หน่วย': y.k ? y.k.unit : '',
          'นับได้ จำนวน': y.a && !y.a.noQty ? y.a.q : '', 'นับได้ หน่วย': y.a ? y.a.unit : '', 'กล่อง': y.a ? y.a.n : '',
          'ผลต่าง (นับ − Kingdee)': y.k && y.a && !y.a.noQty && !y.unitBad ? y.a.q - y.k.q : '',
          'คลัง (Kingdee)': y.k ? y.k.wh : '', 'นับเสร็จโดย': b.marked ? b.marked[1] : ''
        });
      });
    });
    var s = x.sum, r = KD.count.round;
    var wb = XLSX.utils.book_new();
    var ws = XLSX.utils.json_to_sheet(rows.length ? rows : [{ 'Location': '(ไม่มีผลต่าง)' }]);
    ws['!cols'] = [12, 10, 16, 14, 30, 18, 14, 12, 8, 12, 8, 6, 14, 30, 14].map(function (w) { return { wch: w }; });
    XLSX.utils.book_append_sheet(wb, ws, 'ผลต่าง');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
      ['ยอด Kingdee ณ', kdSnapText()], ['รอบนับ', r ? (r.name || '') + ' เริ่ม ' + r.start : '(ไม่ได้ตั้ง)'], ['เทียบระดับ', KD.mode === 'lot' ? 'รหัส + Lot' : 'รหัส'],
      ['ช่องที่ Kingdee มีของ', s.kBins], ['นับแล้ว', s.counted], ['ตรง', s.match], ['ไม่ตรง', s.diff], ['หาไม่เจอ', s.missing], ['เกิน', s.extra], ['ยังไม่นับ', s.todo],
      ['ส่งออกโดย', S.user || ''], ['เวลา', new Date().toLocaleString('th-TH')]
    ]), 'สรุป');
    var d = new Date();
    XLSX.writeFile(wb, 'เทียบKingdee_' + d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) + '-' + pad(d.getHours()) + pad(d.getMinutes()) + '.xlsx');
    toast('ดาวน์โหลด ' + rows.length + ' รายการ');
  }, function () { toast('โหลดตัวสร้าง Excel ไม่ได้ (ต้องต่ออินเทอร์เน็ต)', 3000); });
}

// ===== ความเคลื่อนไหว Kingdee (เซิร์ฟเวอร์เทียบยอดทุก 10 นาที → ชีต KingdeeMoves) =====
// moves: [at, type(in|out|move), part, lot, from, to, qty, unit, name, match(ok|kd_only)]
var KDM = { moves: storeJson('pda_kdm') || [], appOnly: [], lastPoll: '', snapAt: '', err: '', loadedAt: 0, loading: false,
  range: store('pda_kdm_range') || 'today', more: 0, trail: store('pda_kdm_trail') !== '0',
  from: store('pda_kdm_from') || '', to: store('pda_kdm_to') || '', rm: [], rmKey: '', rmLoading: false, rmErr: '' };
var KDM_RANGES = [['hour', '1 ชม.'], ['today', 'วันนี้'], ['yday', 'เมื่อวาน'], ['7d', '7 วัน'], ['custom', '📅 เลือกวัน'], ['all', 'ล่าสุดทั้งหมด']];
function kdmAddDay(d, n) { var t = new Date(Date.parse(d + 'T00:00:00Z') + n * 86400000); return t.toISOString().slice(0, 10); }
// ช่วงที่ต้องถามเซิร์ฟเวอร์ (วันทำงาน 08:00 → 08:00 วันถัดไป) · null = ใช้ข้อมูลล่าสุดที่โหลดไว้
function kdmBounds() {
  var r = KDM.range, today = workDay(), a, b;
  if (r === 'yday') { a = b = kdmAddDay(today, -1); }
  else if (r === '7d') { a = kdmAddDay(today, -6); b = today; }
  else if (r === 'custom') { a = KDM.from || today; b = KDM.to || a; if (b < a) { var x = a; a = b; b = x; } }
  else return null;
  return { from: a, to: b, since: a + ' 08:00:00', until: kdmAddDay(b, 1) + ' 08:00:00', key: a + '|' + b };
}
function loadKdRange(force) {
  var bd = kdmBounds(); if (!bd || !apiUrl()) return;
  if (!force && (KDM.rmKey === bd.key || KDM.rmLoading === bd.key)) return;
  KDM.rmLoading = bd.key; KDM.rmErr = '';
  api('getKingdeeMoves', { since: bd.since, until: bd.until, limit: 3000 }).then(function (d) {
    if (KDM.rmLoading !== bd.key) return;
    KDM.rmLoading = false; KDM.rm = d.moves || []; KDM.rmKey = bd.key; KDM.rmAt = Date.now();
    if (S.view === 'kd') { renderKdMoves(); if (MAP.data) renderMapGrid(); }
  }, function (err) {
    if (KDM.rmLoading !== bd.key) return;
    KDM.rmLoading = false; KDM.rmErr = err.message; if (S.view === 'kd') renderKdMoves();
  });
}
var KDM_TYPE = { in: ['🟢', 'เข้า'], out: ['🔴', 'ออก'], move: ['🟠', 'ย้าย'] };
MAP_EV.kd_in = '🟢 เข้า (Kingdee)'; MAP_EV.kd_out = '🔴 ออก (Kingdee)';
function loadKdMoves() {
  if (KDM.loading || !apiUrl()) return;
  KDM.loading = true;
  api('getKingdeeMoves', { limit: 800 }).then(function (d) {
    KDM.loading = false; KDM.loadedAt = Date.now();
    var changed = JSON.stringify(d.moves.slice(0, 5)) !== JSON.stringify(KDM.moves.slice(0, 5)) || d.moves.length !== KDM.moves.length;
    KDM.moves = d.moves || []; KDM.appOnly = d.appOnly || []; KDM.lastPoll = d.lastPoll; KDM.snapAt = d.snapAt; KDM.err = d.err; KDM.dataSince = d.dataSince || '';
    storeJson('pda_kdm', KDM.moves.slice(0, 300));
    if (S.view === 'scan') renderKdLoc();
    if (S.view === 'kd') { renderKdSnap(); renderKdMoves(); if (changed && MAP.data) renderMapGrid(); }
  }, function (err) {
    KDM.loading = false; KDM.err = err.message;
    if (S.view === 'kd') renderKdMoves();
  });
}
setInterval(function () {
  if (S.view !== 'kd' || document.visibilityState === 'hidden') return;
  if (Date.now() - KDM.loadedAt > 60000) loadKdMoves();
  var bd = kdmBounds(); if (bd && bd.to >= workDay() && Date.now() - (KDM.rmAt || 0) > 60000) loadKdRange(true);
}, 15000);
function kdmLatestSet() {
  var s = {};
  if (KDM.range !== 'all') {
    kdmFiltered().forEach(function (m) { if (m[4]) s[m[4]] = 1; if (m[5]) s[m[5]] = 1; });
    return s;
  }
  var t = KDM.moves[0] && KDM.moves[0][0];
  if (!t || Date.now() - bkkMs(t) > 3 * 3600000) return s; // รอบล่าสุดเก่ากว่า 3 ชม. ไม่ต้องไฮไลต์
  KDM.moves.forEach(function (m) { if (m[0] === t) { if (m[4]) s[m[4]] = 1; if (m[5]) s[m[5]] = 1; } });
  return s;
}
function kdmFiltered() {
  var r = KDM.range, now = Date.now(), today = workDay(), bd = kdmBounds();
  if (bd) {
    if (KDM.rmKey !== bd.key) { loadKdRange(); return []; }
    return KDM.rm.filter(function (m) { return m[0] >= bd.since && m[0] < bd.until; });
  }
  return KDM.moves.filter(function (m) {
    if (r === 'hour') return now - bkkMs(m[0]) <= 3600000;
    if (r === 'today') return workShiftDate(m[0]) === today;
    return true;
  });
}
// วันทำงาน (เริ่ม 08:00) ของเวลา 'yyyy-MM-dd HH:mm:ss'
function workShiftDate(at) {
  var t = bkkMs(at); if (!t) return '';
  var d = new Date(t + 7 * 3600000 - 8 * 3600000);
  return d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate());
}
function kdmRowHtml(m, showLoc) {
  var t = KDM_TYPE[m[1]] || ['•', m[1]], info = bomInfo(m[2]) || {};
  var where = m[1] === 'move' ? '<span class="loc-pill">' + esc(m[4]) + '</span> → <span class="loc-pill">' + esc(m[5]) + '</span>'
    : '<span class="loc-pill">' + esc(m[4] || m[5]) + '</span>';
  var sign = m[1] === 'in' ? '+' : m[1] === 'out' ? '−' : '';
  return '<button type="button" class="find-item kdm-row" data-kdmloc="' + esc(m[5] || m[4]) + '">' +
    '<span class="kd-ico">' + t[0] + '</span><span class="find-main">' +
    '<span class="find-top">' + (showLoc !== false ? where + ' ' : '') + '<b>' + t[1] + ' ' + sign + kdFmt(m[6]) + '</b> <span class="small muted">' + esc(m[7]) + '</span>' +
      (m[9] === 'kd_only' ? ' <span class="kdm-flag" title="Kingdee มีรายการนี้ แต่วันนี้ยังไม่มีใครสแกนในแอป">ไม่ได้สแกน</span>' : m[9] === 'ok' ? ' <span class="kdm-ok" title="แอปมีการสแกนรายการนี้ในวันเดียวกัน">✓ สแกนแล้ว</span>' : '') + '</span>' +
    '<span class="find-sub">' + esc(m[2]) + (m[3] ? ' · Lot ' + esc(m[3]) : '') + ((m[8] || info.name) ? ' · ' + esc(m[8] || info.name) : '') + (kdSpecOf(m[2]) ? ' · ' + kdSpecHtml(m[2]) : '') + '</span>' +
    '<span class="find-sub muted">' + esc(fmtWhen(m[0])) + ' · ' + esc(agoText(m[0])) + '</span></span></button>';
}
function renderKdMoves() {
  var el = $('kdMoves'); if (!el) return;
  var list = kdmFiltered(), bd0 = kdmBounds(), lim = (mapWide() ? 30 : 5) + KDM.more, n = { in: 0, out: 0, move: 0, flag: 0 };
  list.forEach(function (m) { n[m[1]] = (n[m[1]] || 0) + 1; if (m[9] === 'kd_only') n.flag++; });
  var status = !KDM.lastPoll && !KDM.moves.length
    ? '<div class="msg warn small">ยังไม่ได้เปิดตัวดึงความเคลื่อนไหว — ต้องกดอนุญาตใน Apps Script ครั้งแรก (ฟังก์ชัน <b>setupKingdeeTrigger</b>)</div>'
    : '<div class="muted small">เทียบยอด Kingdee ทุก 10 นาที · รอบล่าสุด ' + esc(fmtWhen(KDM.snapAt)) + (KDM.lastPoll ? ' · เช็คล่าสุด ' + esc(agoText(KDM.lastPoll)) : '') +
      (KDM.err ? '<br><span class="err-text">⚠ ' + esc(KDM.err) + '</span>' : '') + '</div>';
  var html = '<div class="find-box kdm-box"><div class="kdm-head"><b>📈 ความเคลื่อนไหว Kingdee</b>' +
      '</div><div class="kdm-ranges">' + KDM_RANGES.map(function (r) {
        return '<button type="button" data-kdmr="' + r[0] + '" class="find-zone' + (KDM.range === r[0] ? ' on' : '') + '">' + r[1] + '</button>';
      }).join('') + '</div>' +
      (KDM.range === 'custom' ? '<div class="kdm-dates"><label>ตั้งแต่ <input type="date" id="kdmFrom" class="field" value="' + esc(bd0 ? bd0.from : '') + '" max="' + workDay() + '"></label>' +
        '<label>ถึง <input type="date" id="kdmTo" class="field" value="' + esc(bd0 ? bd0.to : '') + '" max="' + workDay() + '"></label></div>' : '') +
      (bd0 ? '<div class="small kdm-rangeinfo">📅 ' + esc(fmtWhen(bd0.since)) + ' → ' + esc(fmtWhen(bd0.until)) + ' <span class="muted">(วันทำงานเริ่ม 08:00)</span>' +
        (KDM.rmLoading ? ' · ⏳ กำลังโหลด…' : '') + (KDM.rmErr ? ' <span class="err-text">⚠ ' + esc(KDM.rmErr) + '</span>' : '') + '</div>' : '') + status +
    (list.length ? '<div class="small kdm-sum">🟢 เข้า ' + n.in + ' · 🔴 ออก ' + n.out + ' · 🟠 ย้าย ' + n.move + (n.flag ? ' · <span class="kdm-flag">ไม่ได้สแกน ' + n.flag + '</span>' : '') + '</div>' +
      '<div class="find-list">' + list.slice(0, lim).map(function (m) { return kdmRowHtml(m); }).join('') + '</div>' +
      (list.length > lim ? '<button type="button" class="btn small" id="kdmMore">ดูเพิ่ม (อีก ' + (list.length - lim) + ')</button>' : '') +
      (KDM.more ? ' <button type="button" class="btn small" id="kdmLess">ย่อ</button>' : '')
      : '<div class="muted small center pad">' + (bd0 && KDM.rmKey !== bd0.key ? '⏳ กำลังโหลด…' : 'ไม่มีความเคลื่อนไหวในช่วงนี้') + '</div>') +
    kdmDailyHtml(list) +
    (list.length && KDM.range !== 'all' ? '<div class="small muted">ช่องที่มีความเคลื่อนไหวในช่วงนี้มีกรอบส้มประบนผัง' + (KDM.trail ? ' · ลูกศร = 10 รายการล่าสุดของช่วงนี้' : '') + '</div>' : '') +
    (KDM.appOnly.length ? '<details class="kdm-apponly"><summary>📱 แอปย้ายแล้ว แต่ Kingdee ยังไม่ทำรายการ (วันนี้ ' + KDM.appOnly.length + ')</summary>' +
      KDM.appOnly.slice(0, 50).map(function (a) {
        return '<div class="small kdm-ao"><span class="loc-pill">' + esc(a[2]) + '</span> → <span class="loc-pill">' + esc(a[3]) + '</span> ' + esc(a[1]) + ' · ' + esc(a[4]) + ' · ' + esc(fmtWhen(a[0])) + '</div>';
      }).join('') + '</details>' : '') +
    '</div>';
  if (el._html === html) return;
  el._html = html; el.innerHTML = html;
  Array.prototype.forEach.call(el.querySelectorAll('[data-kdmr]'), function (b) {
    b.onclick = function () {
      KDM.range = b.getAttribute('data-kdmr'); store('pda_kdm_range', KDM.range); KDM.more = 0;
      if (KDM.range === 'custom' && !KDM.from) { KDM.from = KDM.to = workDay(); }
      renderKdMoves(); if (MAP.data) renderMapGrid();
    };
  });
  ['kdmFrom', 'kdmTo'].forEach(function (id) {
    if (!$(id)) return;
    $(id).onchange = function () {
      if (!this.value) return;
      if (id === 'kdmFrom') { KDM.from = this.value; if (!KDM.to || KDM.to < KDM.from) KDM.to = KDM.from; }
      else { KDM.to = this.value; if (!KDM.from || KDM.from > KDM.to) KDM.from = KDM.to; }
      store('pda_kdm_from', KDM.from); store('pda_kdm_to', KDM.to); KDM.more = 0;
      renderKdMoves(); if (MAP.data) renderMapGrid();
    };
  });
  Array.prototype.forEach.call(el.querySelectorAll('[data-kdmloc]'), function (b) {
    b.onclick = function () { var loc = b.getAttribute('data-kdmloc'); mapGotoCell(loc); setTimeout(function () { openKdCell(loc); }, 350); };
  });
  if ($('kdmMore')) $('kdmMore').onclick = function () { KDM.more += 30; renderKdMoves(); };
  if ($('kdmDaily')) $('kdmDaily').addEventListener('toggle', function () { store('pda_kdm_daily', this.open ? '1' : '0'); el._html = ''; });
  if ($('kdmMin')) $('kdmMin').onchange = function () { var v = Number(this.value); if (v > 0) { KDM.min = v; store('pda_kdm_min', v); renderKdMoves(); } };
  if ($('kdmXlsx')) $('kdmXlsx').onclick = exportKdmDaily;
  if ($('kdmLess')) $('kdmLess').onclick = function () { KDM.more = 0; renderKdMoves(); };
}
// สรุปรายวัน: เข้า / ออก / ย้าย + จำนวนเที่ยวโฟล์คลิฟท์ (ประมาณ) + เวลาที่ใช้
// เที่ยว = รายการประเภทเดียวกัน ช่องเดียวกัน ในรอบตรวจเดียวกัน (10 นาที) นับเป็น 1 เที่ยว
KDM.min = Number(store('pda_kdm_min')) || 3;
function kdmDaily(list) {
  var days = {};
  list.forEach(function (m) {
    var d = workShiftDate(m[0]), e = days[d] || (days[d] = { d: d, in: 0, out: 0, move: 0, trips: {}, hours: {}, qin: 0, qout: 0 });
    e[m[1]] = (e[m[1]] || 0) + 1;
    if (m[1] === 'in') e.qin += m[6]; else if (m[1] === 'out') e.qout += m[6];
    // จ่ายออกจากช่องเดียวกันในเวลาเดียวกัน (ออก + ย้ายออก) = 1 เที่ยว · เอาเข้าช่องเดียวกันในเวลาเดียวกัน = 1 เที่ยว
    e.trips[m[0] + '|' + (m[1] === 'in' ? 'to|' + m[5] : 'from|' + m[4])] = 1;
    var h = String(m[0]).slice(11, 13); e.hours[h] = (e.hours[h] || 0) + 1;
  });
  return Object.keys(days).sort().reverse().map(function (k) {
    var e = days[k]; e.n = e.in + e.out + e.move; e.nTrips = Object.keys(e.trips).length; e.mins = e.nTrips * KDM.min;
    e.peak = Object.keys(e.hours).sort(function (a, b) { return e.hours[b] - e.hours[a]; })[0] || '';
    return e;
  });
}
function kdmMinText(m) { m = Math.round(m); return m >= 60 ? Math.floor(m / 60) + ' ชม. ' + (m % 60) + ' นาที' : m + ' นาที'; }
function kdmDayText(d) { return String(fmtWhen(d + ' 00:00')).replace(/ · 00:00$/, ''); }
function kdmDailyHtml(list) {
  if (!list.length) return '';
  var rows = kdmDaily(list), t = { in: 0, out: 0, move: 0, nTrips: 0, mins: 0 };
  rows.forEach(function (e) { t.in += e.in; t.out += e.out; t.move += e.move; t.nTrips += e.nTrips; t.mins += e.mins; });
  return '<details class="kdm-daily"' + (store('pda_kdm_daily') === '1' ? ' open' : '') + ' id="kdmDaily"><summary>📊 สรุปรายวัน · เวลาโฟล์คลิฟท์ ≈ <b>' + kdmMinText(t.mins) + '</b>' + (rows.length > 1 ? ' (' + rows.length + ' วัน)' : '') + '</summary>' +
    '<div class="kdm-minrow small">เวลาต่อเที่ยว <input type="number" id="kdmMin" class="field" min="0.5" max="60" step="0.5" value="' + KDM.min + '"> นาที' +
      ' <button type="button" class="btn small" id="kdmXlsx">⬇ Excel</button></div>' +
    '<div class="kd-scroll"><table class="kd-table kdm-dtable"><thead><tr><th>วันทำงาน</th><th class="num">🟢 เข้า</th><th class="num">🔴 ออก</th><th class="num">🟠 ย้าย</th><th class="num">เที่ยว*</th><th class="num">เวลา</th><th class="num">ชม.ยุ่งสุด</th></tr></thead><tbody>' +
    rows.map(function (e) {
      return '<tr><td>' + esc(kdmDayText(e.d)) + '</td><td class="num">' + e.in + '</td><td class="num">' + e.out + '</td><td class="num">' + e.move + '</td>' +
        '<td class="num"><b>' + e.nTrips + '</b></td><td class="num">' + kdmMinText(e.mins) + '</td><td class="num">' + (e.peak ? e.peak + ':00 (' + e.hours[e.peak] + ')' : '') + '</td></tr>';
    }).join('') +
    (rows.length > 1 ? '<tr class="kdm-total"><td>รวม</td><td class="num">' + t.in + '</td><td class="num">' + t.out + '</td><td class="num">' + t.move + '</td><td class="num"><b>' + t.nTrips + '</b></td><td class="num">' + kdmMinText(t.mins) + '</td><td class="num">เฉลี่ย ' + kdmMinText(t.mins / rows.length) + '/วัน</td></tr>' : '') +
    '</tbody></table></div>' +
    '<div class="small muted">* เที่ยว = จ่ายออก (ออก/ย้ายออก) จากช่องเดียวกันในเวลาเดียวกัน นับเป็น 1 เที่ยว · เอาเข้าช่องเดียวกันในเวลาเดียวกัน นับเป็น 1 เที่ยว (เวลาเดียวกัน = รอบตรวจเดียวกัน ทุก 10 นาที) · นับจากยอด Kingdee ที่เปลี่ยน เฉพาะช่องในผัง (ไม่รวม Public area) · เวลา = เที่ยว × เวลาต่อเที่ยว' +
      (KDM.range === 'all' ? ' · "ล่าสุดทั้งหมด" ดึงมาแค่ 800 รายการล่าสุด — เลือก 7 วัน / เลือกวัน เพื่อข้อมูลครบ' : '') + '</div></details>';
}
function exportKdmDaily() {
  var list = kdmFiltered(); if (!list.length) { toast('ไม่มีข้อมูลในช่วงนี้'); return; }
  loadScriptOnce(XLSX_URL).then(function () {
    var rows = kdmDaily(list).slice().reverse();
    var wb = XLSX.utils.book_new();
    var s1 = rows.map(function (e) {
      return { 'วันทำงาน': e.d, 'เข้า (รายการ)': e.in, 'ออก (รายการ)': e.out, 'ย้าย (รายการ)': e.move, 'รวมรายการ': e.n, 'เที่ยว (ประมาณ)': e.nTrips,
        'นาทีต่อเที่ยว': KDM.min, 'เวลาโฟล์คลิฟท์ (นาที)': e.mins, 'เวลาโฟล์คลิฟท์ (ชม.)': Math.round(e.mins / 6) / 10, 'ชั่วโมงที่ยุ่งสุด': e.peak ? e.peak + ':00' : '', 'รายการในชั่วโมงนั้น': e.peak ? e.hours[e.peak] : 0 };
    });
    var ws1 = XLSX.utils.json_to_sheet(s1); ws1['!cols'] = [12, 12, 12, 12, 11, 14, 12, 18, 16, 14, 16].map(function (w) { return { wch: w }; });
    XLSX.utils.book_append_sheet(wb, ws1, 'สรุปรายวัน');
    // ตามชั่วโมง
    var hrs = {}; list.forEach(function (m) { var k = workShiftDate(m[0]) + '|' + String(m[0]).slice(11, 13); hrs[k] = (hrs[k] || 0) + 1; });
    var ws3 = XLSX.utils.json_to_sheet(Object.keys(hrs).sort().map(function (k) { var a = k.split('|'); return { 'วันทำงาน': a[0], 'ชั่วโมง': a[1] + ':00', 'รายการ': hrs[k] }; }));
    XLSX.utils.book_append_sheet(wb, ws3, 'ตามชั่วโมง');
    var ws2 = XLSX.utils.json_to_sheet(list.slice().reverse().map(function (m) {
      return { 'เวลา': m[0], 'วันทำงาน': workShiftDate(m[0]), 'ประเภท': (KDM_TYPE[m[1]] || ['', m[1]])[1], 'รหัส': m[2], 'Lot': m[3], 'จากช่อง': m[4], 'ไปช่อง': m[5], 'จำนวน': m[6], 'หน่วย': m[7], 'ชื่อ': m[8], 'Spec': kdSpecOf(m[2]),
        'ในแอป': m[9] === 'ok' ? 'สแกนแล้ว' : m[9] === 'kd_only' ? 'ไม่ได้สแกน' : '' };
    }));
    ws2['!cols'] = [19, 11, 7, 14, 12, 12, 12, 10, 6, 30, 16, 10].map(function (w) { return { wch: w }; });
    XLSX.utils.book_append_sheet(wb, ws2, 'รายการ');
    var bd = kdmBounds(), tag = bd ? bd.from + (bd.to !== bd.from ? '_' + bd.to : '') : workDay();
    XLSX.writeFile(wb, 'Kingdee-เข้าออก-' + tag + '.xlsx');
  }, function (err) { toast('โหลดตัวสร้าง Excel ไม่ได้: ' + err.message, 3000); });
}
// ลูกศรบนผัง Kingdee: 10 ความเคลื่อนไหวล่าสุด (รูปแบบเดียวกับผังสแกน)
function kdTrailActions() {
  var out = [];
  (KDM.range === 'all' ? KDM.moves : kdmFiltered()).forEach(function (m) {
    if (out.length > TRAIL_N) return;
    var ev = m[1] === 'move' ? 'move' : m[1] === 'in' ? 'kd_in' : 'kd_out', loc = m[5] || m[4], last = out[out.length - 1];
    if (last && last.loc === loc && ev !== 'move' && last.ev !== 'move') { last.n++; return; }
    if (out.length < TRAIL_N) out.push({ at: m[0], first: m[0], ev: ev, from: m[4], to: m[5], loc: loc, part: m[2], by: 'Kingdee', n: 1 });
  });
  return out;
}

// ===== หา "Kingdee บอกว่าอยู่ช่องไหน" จากการสแกนป้ายหน้างาน (กล้อง / ปืนสแกน / พิมพ์) =====
// hits: { ช่อง: 'lot' (รหัส+Lot ตรง → กระพริบแดง) | 'part' (รหัสตรงแต่คนละ Lot → กรอบส้ม) }
var KDF = { q: '', part: '', lot: '', parts: null, hits: null, list: [], appLocs: [], all: false, pkg: '', qty: '', unit: '', qr: '', pkgRec: null, pkgRecs: [], pkgState: '' };
// รหัสใน Kingdee ที่ รหัส / ชื่อ / Spec มีทุกคำที่พิมพ์ → [{ part, name, spec, bins, score }]
function kdPartSearch(q, max) {
  var words = String(q || '').trim().toUpperCase().split(/\s+/).filter(String); if (!words.length) return [];
  var by = {};
  KD.rows.forEach(function (r) {
    var e = by[r[1]] || (by[r[1]] = { part: r[1], name: r[5], spec: r[6], bins: {} }); e.bins[r[0]] = 1;
  });
  var out = [];
  Object.keys(by).forEach(function (k) {
    var e = by[k], code = k.toUpperCase(), hay = code + ' ' + String(e.name).toUpperCase() + ' ' + String(e.spec).toUpperCase();
    if (!words.every(function (w) { return hay.indexOf(w) >= 0; })) return;
    e.score = code.indexOf(words[0]) === 0 ? 0 : code.indexOf(words[0]) > 0 ? 1 : String(e.name).toUpperCase().indexOf(words[0]) === 0 ? 2 : 3;
    e.n = Object.keys(e.bins).length; out.push(e);
  });
  out.sort(function (a, b) { return a.score - b.score || b.n - a.n || (a.part < b.part ? -1 : 1); });
  return max ? out.slice(0, max) : out;
}
function kdfRun(raw, jump) {
  var chk = checkScan(raw), text = (chk.text || String(raw || '')).trim();
  if (!text) { kdfClear(); return; }
  var loc = asLocation(text);
  if (loc) { KDF.q = ''; KDF.hits = null; KDF.list = []; renderKdFind(); if ($('kdfQ')) $('kdfQ').value = ''; mapGotoCell(loc); setTimeout(function () { openKdCell(loc); }, 400); return; }
  var p = parseQr(text), part = '', lot = '', parts = null;
  KDF.pkg = ''; KDF.qty = ''; KDF.unit = ''; KDF.qr = ''; KDF.pkgRec = null; KDF.pkgRecs = []; KDF.pkgState = '';
  if (p.format !== 'text' && p.part_code) {
    part = p.part_code.toUpperCase(); lot = p.lot_no;
    KDF.pkg = p.pkg_ref || ''; KDF.qty = p.qty; KDF.unit = p.unit || ''; KDF.qr = p.qr_raw;
  }
  else {
    // ข้อความเดียว: ลองเป็นรหัส → เป็น Lot
    var u = text.toUpperCase();
    if (KD.rows.some(function (r) { return r[1].toUpperCase() === u; })) part = u;
    else if (KD.rows.some(function (r) { return r[2].toUpperCase() === u; })) lot = text;
    else {
      // ไม่ตรงรหัส / Lot → หาจากชื่อพาร์ท / Spec / บางส่วนของรหัส
      var found = kdPartSearch(text);
      if (found.length === 1) part = found[0].part.toUpperCase();
      else if (found.length > 1) { parts = {}; found.forEach(function (f) { parts[f.part.toUpperCase()] = 1; }); }
      else part = u;
    }
  }
  KDF.q = text; KDF.part = part; KDF.lot = lot; KDF.parts = parts; KDF.all = false;
  function partOk(code) { code = String(code).toUpperCase(); return parts ? !!parts[code] : (!part || code === part); }
  var hits = {}, by = {};
  KD.rows.forEach(function (r) {
    var pOk = partOk(r[1]), lOk = !lot || r[2].toUpperCase() === lot.toUpperCase();
    var kind = pOk && lOk ? 'lot' : (part && pOk ? 'part' : '');
    if (!kind) return;
    if (hits[r[0]] !== 'lot') hits[r[0]] = kind;
    var e = by[r[0]] || (by[r[0]] = { loc: r[0], kind: kind, q: 0, unit: r[4], lots: {}, parts: {}, part: r[1], name: r[5] });
    if (kind === 'lot') e.kind = 'lot';
    e.q += r[3]; e.lots[r[2] || '-'] = (e.lots[r[2] || '-'] || 0) + r[3]; e.parts[r[1]] = 1;
  });
  KDF.hits = hits;
  KDF.pub = parts || part || lot ? KD.pub.filter(function (r) { return partOk(r[1]) && (!lot || r[2].toUpperCase() === lot.toUpperCase()); }) : [];
  KDF.list = Object.keys(by).map(function (k) { return by[k]; }).sort(function (a, b) { return (a.kind === 'lot' ? 0 : 1) - (b.kind === 'lot' ? 0 : 1) || (a.loc < b.loc ? -1 : 1); });
  // แอปสแกนไว้ที่ไหน (ของชิ้นเดียวกัน) — เทียบกับที่ Kingdee บอก
  var app = {};
  mapAllItems().forEach(function (it) {
    if (isTestUser(it.by)) return;
    if (partOk(it.part) && (!lot || String(it.lot).toUpperCase() === lot.toUpperCase())) app[it.loc] = 1;
  });
  KDF.appLocs = Object.keys(app).sort();
  if ($('kdfQ')) $('kdfQ').value = text;
  if (KDF.qr) kdfLookupPkg(KDF.qr);
  renderKdFind();
  if (MAP.data) renderMapGrid();
  var first = KDF.list.filter(function (e) { return e.kind === 'lot'; })[0] || KDF.list[0];
  KDF.jump = jump !== false;
  if (KDF.jump) {
    if (KDF.pkgRec) { beep(true); mapGotoCell(KDF.pkgRec.location); KDF.jump = false; }
    else if (first) { beep(true); mapGotoCell(first.loc); } else beep(false);
  }
}
// Package นี้ (QR เดียวกันทั้งใบ) แอปสแกนไว้ช่องไหน — ดูในเครื่องก่อน แล้วถามเซิร์ฟเวอร์
// ตรงทั้งใบ หรือ รหัส + Lot + Package เดียวกัน (ป้ายพิมพ์ใหม่)
function kdfPkgMatch(r) {
  if (r.qr_raw === KDF.qr) return true;
  return !!(pkgKey(KDF.pkg) && String(r.part_code || '').toUpperCase() === KDF.part && String(r.lot_no || '') === String(KDF.lot || '') && pkgKey(r.pkg_ref) === pkgKey(KDF.pkg));
}
function kdfSetPkg(list) {
  var seen = {};
  KDF.pkgRecs = list.filter(function (r) { if (!r.location || seen[r.location]) return false; seen[r.location] = 1; return true; });
  KDF.pkgRec = KDF.pkgRecs[0] || null;
}
function kdfLookupPkg(qr) {
  var local = S.recent.filter(function (r) { return r.location && (r.status === 'pending' || r.status === 'saved') && kdfPkgMatch(r); })
    .map(function (r) { return { location: r.location, scanned_by: r.scanned_by, scanned_at: r.scanned_at, qty: r.qty, unit: r.unit, pkg_ref: r.pkg_ref, exact: r.qr_raw === qr, local: true }; });
  kdfSetPkg(local);
  KDF.pkgState = KDF.pkgRec ? 'found' : 'loading';
  if (!apiUrl()) { if (!KDF.pkgRec) KDF.pkgState = 'offline'; return; }
  api('findPackage', qr, KDF.part, KDF.lot, KDF.pkg).then(function (list) {
    if (KDF.qr !== qr) return;
    var had = KDF.pkgRec && KDF.pkgRec.location;
    var pend = local.filter(function (l) { return !(list || []).some(function (r) { return r.location === l.location; }); });
    kdfSetPkg(pend.concat(list || []));
    KDF.pkgState = KDF.pkgRec ? 'found' : 'none';
    renderKdFind(); if (MAP.data) renderMapGrid();
    if (KDF.pkgRec && (KDF.jump || had !== KDF.pkgRec.location)) { KDF.jump = false; mapGotoCell(KDF.pkgRec.location); }
  }, function () { if (KDF.qr !== qr) return; if (!KDF.pkgRec) KDF.pkgState = 'offline'; renderKdFind(); });
}
function kdfPkgHtml() {
  if (!KDF.qr) return '';
  var head = '<div class="kdf-pkg-line">📦 Package <b>' + (KDF.pkg ? esc(KDF.pkg) : '<span class="muted">ไม่มีบนป้าย</span>') + '</b>' +
    (KDF.qty !== '' ? ' · ป้ายนี้ <b>' + esc(fmtQty(KDF.qty, KDF.unit)) + '</b>' : '') + '</div>';
  var r = KDF.pkgRec, body;
  function where(x, big) {
    var okK = KDF.hits && KDF.hits[x.location] === 'lot';
    return '<div class="' + (big ? 'kdf-here' : 'kdf-pkg-res') + '">' + (big ? '<span class="kdf-here-t">📍 กล่องนี้อยู่ที่</span> ' : '') +
      '<button type="button" class="loc-pill kdf-al' + (big ? ' kdf-big' : '') + '" data-kdfc="' + esc(x.location) + '">' + esc(x.location) + '</button>' +
      ' <span class="small muted">สแกนโดย ' + esc(x.scanned_by || '-') + ' · ' + esc(fmtWhen(String(x.scanned_at || '').slice(0, 16))) +
        (x.qty !== '' && x.qty != null ? ' · ' + esc(fmtQty(x.qty, x.unit)) : '') + (x.exact === false ? ' · ป้ายคนละใบ (Package เดียวกัน)' : '') + '</span> ' +
      (okK ? '<span class="kdm-ok">✓ ตรงกับ Kingdee</span>' : '<span class="kdm-flag">Kingdee ไม่ได้บอกว่าอยู่ช่องนี้</span>') + '</div>';
  }
  if (KDF.pkgState === 'found' && r) {
    body = where(r, true) + (KDF.pkgRecs.length > 1 ? '<div class="small kdf-pkg-none">⚠ Package นี้ถูกสแกนไว้ ' + KDF.pkgRecs.length + ' ช่อง (อาจแบ่งกล่อง หรือสแกนซ้ำ):</div>' +
      KDF.pkgRecs.slice(1).map(function (x) { return where(x, false); }).join('') : '');
  } else if (KDF.pkgState === 'loading') body = '<div class="small muted">⏳ กำลังหาว่ากล่องนี้สแกนไว้ช่องไหน…</div>';
  else if (KDF.pkgState === 'none') body = '<div class="small kdf-pkg-none">กล่องนี้ยังไม่เคยสแกนเข้าแอป — ดูได้แค่ช่องที่ Kingdee บอกว่ามี Lot นี้ (ด้านล่าง)</div>';
  else if (KDF.pkgState === 'offline') body = '<div class="small muted">ออฟไลน์ — เช็คกล่องในแอปไม่ได้</div>';
  else body = '';
  return '<div class="kdf-pkg' + (KDF.pkgState === 'found' ? ' kdf-pkg-found' : '') + '">' + head + body + '</div>';
}
function kdfClear() {
  KDF.q = ''; KDF.hits = null; KDF.list = []; KDF.appLocs = []; KDF.qr = ''; KDF.parts = null; KDF.pkgRec = null; KDF.pkgRecs = []; KDF.pkgState = '';
  if ($('kdfQ')) $('kdfQ').value = '';
  renderKdFind(); if (MAP.data) renderMapGrid();
}
function renderKdFind() {
  var el = $('kdFind'); if (!el) return;
  if (!KDF.q) { el.innerHTML = ''; return; }
  var lots = KDF.list.filter(function (e) { return e.kind === 'lot'; }), others = KDF.list.filter(function (e) { return e.kind !== 'lot'; });
  var info = bomInfo(KDF.part) || {}, name = KDF.part ? (info.name || (KDF.list[0] && KDF.list[0].name) || '') : '';
  var lim = mapWide() || KDF.all ? 999 : 5;
  function row(e) {
    var lotTxt = Object.keys(e.lots).map(function (l) { return (l === '-' ? 'ไม่มี Lot' : 'Lot ' + esc(l)) + ' ' + kdFmt(e.lots[l]); }).join(' · ');
    var inApp = KDF.appLocs.indexOf(e.loc) >= 0;
    return '<button type="button" class="find-item" data-kdfc="' + esc(e.loc) + '"><span class="kd-ico">' + (e.kind === 'lot' ? '📍' : '🔸') + '</span><span class="find-main">' +
      '<span class="find-top"><span class="loc-pill">' + esc(e.loc) + '</span> <b>' + kdFmt(e.q) + '</b> <span class="small muted">' + esc(e.unit) + '</span>' +
        (inApp ? ' <span class="kdm-ok">✓ แอปสแกนไว้ช่องนี้</span>' : '') + '</span>' +
      '<span class="find-sub">' + (KDF.part ? '' : Object.keys(e.parts).map(function (pc) {
          var nm = KDF.parts ? (KD.rows.filter(function (r) { return r[1] === pc; })[0] || [])[5] : '';
          return '<b>' + esc(pc) + '</b>' + (nm ? ' ' + esc(nm) : '') + (kdSpecOf(pc) ? ' ' + kdSpecHtml(pc) : '');
        }).join(', ') + ' · ') + lotTxt + '</span></span></button>';
  }
  var appOnly = KDF.appLocs.filter(function (l) { return !KDF.hits[l]; });
  el.innerHTML = '<div class="find-box kdf-box">' +
    '<div class="kdm-head"><span>' + [KDF.part ? '<b>' + esc(KDF.part) + '</b>' : '', KDF.lot ? 'Lot <b>' + esc(KDF.lot) + '</b>' : '',
        KDF.parts ? '🔎 "<b>' + esc(KDF.q) + '</b>" เจอ <b>' + Object.keys(KDF.parts).length + '</b> รหัส' : ''].filter(String).join(' · ') + (name ? ' <span class="small muted">' + esc(name) + '</span>' : '') + (KDF.part && kdSpecOf(KDF.part) ? ' ' + kdSpecHtml(KDF.part) : '') + '</span>' +
      '<button type="button" class="btn small" id="kdfX">✕ ล้าง</button></div>' + kdfPkgHtml() +
    (lots.length && KDF.pkgRec ? '<details class="kdm-apponly"><summary>📍 Lot นี้ทั้งหมดใน Kingdee อยู่ ' + lots.length + ' ช่อง (กระพริบแดงบนผัง)</summary><div class="find-list">' + lots.map(row).join('') + '</div></details>'
      : lots.length ? '<div class="small">📍 Kingdee บอกว่า Lot นี้อยู่ <b>' + lots.length + '</b> ช่อง (กระพริบแดงบนผัง)</div><div class="find-list">' + lots.slice(0, lim).map(row).join('') + '</div>' +
        (lots.length > lim ? '<button type="button" class="btn small" id="kdfMore">ดูทั้งหมด ' + lots.length + ' ช่อง</button>' : '')
      : '<div class="msg warn small">Kingdee ไม่มี' + (KDF.lot ? ' Lot นี้' : 'รหัส / ชื่อนี้') + 'ในช่องไหนเลย' + ((KDF.pub || []).length ? ' — แต่มีใน Public area (ด้านล่าง)' : others.length ? '' : ' (หรือยอดเป็น 0)') + '</div>') +
    ((KDF.pub || []).length ? '<div class="kdf-pub"><div class="small">📥 <b>Public area</b> (Kingdee ยังไม่ได้ลงช่อง) <b>' + KDF.pub.length + '</b> รายการ</div>' +
      '<div class="kdp-list">' + KDF.pub.slice(0, 20).map(kdPubRowHtml).join('') + '</div>' + (KDF.pub.length > 20 ? '<div class="small muted">… อีก ' + (KDF.pub.length - 20) + ' รายการ</div>' : '') + '</div>' : '') +
    (others.length ? '<details class="kdm-apponly"' + (lots.length ? '' : ' open') + '><summary>🔸 รหัสเดียวกัน คนละ Lot (' + others.length + ' ช่อง · กรอบส้มบนผัง)</summary><div class="find-list">' + others.slice(0, 40).map(row).join('') + '</div></details>' : '') +
    (appOnly.length ? '<div class="small kdf-app">📱 แอปสแกนไว้ที่ ' + appOnly.map(function (l) { return '<button type="button" class="loc-pill kdf-al" data-kdfc="' + esc(l) + '">' + esc(l) + '</button>'; }).join(' ') + ' <span class="muted">— แต่ Kingdee ไม่ได้บอกว่าอยู่ช่องนี้</span></div>' : '') +
  '</div>';
  $('kdfX').onclick = kdfClear;
  if ($('kdfMore')) $('kdfMore').onclick = function () { KDF.all = true; renderKdFind(); };
  Array.prototype.forEach.call(el.querySelectorAll('[data-kdfc]'), function (b) {
    b.onclick = function () { var loc = b.getAttribute('data-kdfc'); mapGotoCell(loc); setTimeout(function () { openKdCell(loc); }, 450); };
  });
}
function bindKdFind() {
  var inp = $('kdfQ'), sug = $('kdfSug'), timer = 0; if (!inp) return;
  function hide() { sug.classList.add('hidden'); sug.innerHTML = ''; }
  function show() {
    var v = inp.value.trim();
    if (v.length < 2 || looksLikeScan(v)) { hide(); return; }
    var list = kdPartSearch(v, 8);
    if (!list.length) { hide(); return; }
    sug.innerHTML = list.map(function (e) {
      return '<button type="button" class="ac-item" data-kdfp="' + esc(e.part) + '"><span class="ac-code">' + markQ(e.part, v) + ' <span class="small muted">· ' + e.n + ' ช่อง</span></span>' +
        (e.name ? '<span class="ac-name">' + markQ(e.name, v) + '</span>' : '') + (e.spec ? '<span class="ac-spec">' + markQ(e.spec, v) + '</span>' : '') + '</button>';
    }).join('');
    sug.classList.remove('hidden');
    Array.prototype.forEach.call(sug.querySelectorAll('[data-kdfp]'), function (b) {
      b.onmousedown = function (ev) { ev.preventDefault(); };
      b.onclick = function () { hide(); kdfRun(b.getAttribute('data-kdfp')); inp.blur(); };
    });
  }
  inp.addEventListener('input', function () { clearTimeout(timer); timer = setTimeout(show, 150); });
  inp.addEventListener('focus', show);
  inp.addEventListener('blur', function () { setTimeout(hide, 200); });
  inp.addEventListener('keydown', function (e) { if (e.key === 'Escape') hide(); if (e.key === 'Enter') { e.preventDefault(); hide(); kdfRun(inp.value); inp.blur(); } });
  // ปืนสแกน (DataWedge) บางเครื่องไม่ส่ง Enter → ข้อความที่ดูเป็นป้ายให้ค้นเลย
  inp.addEventListener('change', function () { if (inp.value.trim() !== KDF.q) kdfRun(inp.value); });
  $('kdfCam').onclick = function () { openCameraScanner(function (raw) { kdfRun(raw); }); };
  renderKdFind();
}

// ======================= นับจากรูป (สอนเองที่หน้างาน) =======================
// ถ่ายรูป → ลากกรอบตัวอย่าง 1–3 ชิ้น → แอปหาชิ้นที่เหมือนทั้งรูป (js/countworker.js) → แตะเพิ่ม/ลบจุด → ยืนยัน
// ยืนยันแล้ว: จำแม่แบบไว้กับรหัสพาร์ท (ครั้งหน้าไม่ต้องลากกรอบ) + เก็บรูปและจุดไว้เทรนโมเดลภายหลัง
var CNT = { part: store('pda_cnt_part') || '', prof: null, profState: '', src: null, gray: null, sent: false, boxes: [], cands: [], removed: {}, added: [],
  thr: Number(store('pda_cnt_thr')) || 0.6, rot: store('pda_cnt_rot') !== '0', mode: 'box', zoom: 1, busy: false, err: '', res: null, undo: [], done: null };
var CNT_PROFS = storeJson('pda_cnt_prof') || {};
var CW = null, CW_SEQ = 0, CW_CB = {};
function cntWorker() {
  if (!CW) {
    CW = new Worker('js/countworker.js?v=' + APP_VERSION);
    CW.onmessage = function (e) { var cb = CW_CB[e.data.id]; delete CW_CB[e.data.id]; if (cb) cb(e.data); };
    CW.onerror = function (e) { Object.keys(CW_CB).forEach(function (k) { CW_CB[k]({ error: e.message || 'ตัวนับผิดพลาด' }); delete CW_CB[k]; }); CW = null; CNT.sent = false; };
  }
  return CW;
}
function cntCall(msg) {
  return new Promise(function (res, rej) {
    var id = ++CW_SEQ; msg.id = id;
    if (!CNT.sent && CNT.gray) { msg.gray = CNT.gray; CNT.sent = true; }
    CW_CB[id] = function (d) { if (d.error) rej(new Error(d.error)); else res(d); };
    cntWorker().postMessage(msg);
  });
}
function b64FromU8(u) { var s = ''; for (var i = 0; i < u.length; i += 8192) s += String.fromCharCode.apply(null, u.subarray(i, i + 8192)); return btoa(s); }
function u8FromB64(b) { var s = atob(b), u = new Uint8Array(s.length); for (var i = 0; i < s.length; i++) u[i] = s.charCodeAt(i); return u; }
function cntProfTpls(list) { return (list || []).map(function (t) { return { w: t.w, h: t.h, data: u8FromB64(t.b) }; }); }

function renderCount() {
  $('main').innerHTML =
    '<section class="card-form cnt">' +
      '<div class="sec-title"><span>📷 นับจากรูป</span><span class="small muted">ต้นแบบ · สอนเองที่หน้างาน</span></div>' +
      '<label>รหัสพาร์ท <span class="muted small">(ใส่ไว้ แอปจะจำการสอนของพาร์ทนี้)</span></label>' +
      '<div class="kdf-bar"><input id="cntPart" class="field" autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="พิมพ์ / สแกนป้าย" value="' + esc(CNT.part) + '">' +
        '<button class="btn" id="cntPartScan" title="สแกนป้าย">📸</button></div>' +
      '<div id="cntProf" class="small cnt-prof"></div>' +
      '<label class="btn primary cnt-shot">📷 ถ่ายรูป / เลือกรูป<input type="file" id="cntFile" accept="image/*" capture="environment" hidden></label>' +
      '<div id="cntWork"></div>' +
    '</section>' +
    '<section class="cnt-help small muted" id="cntHelp">' +
      '<b>วิธีใช้</b><ol><li>ใส่รหัสพาร์ท แล้วถ่ายรูปให้เห็นชิ้นงานชัด ไม่ทับกัน ถ่ายตรงๆ จากด้านบนหรือด้านปลาย</li>' +
      '<li>กด <b>✏ ลากกรอบ</b> แล้วลากกรอบรอบชิ้นงาน 1–3 ชิ้น (ชิ้นที่ชัดที่สุด) → แอปนับให้</li>' +
      '<li>กด <b>👆 แก้จุด</b>: แตะชิ้นที่แอปพลาดเพื่อเพิ่ม · แตะจุดที่ผิดเพื่อลบ (ซูม 🔍 ได้)</li>' +
      '<li>กด <b>✔ ยืนยัน</b> — แอปจำการสอนไว้ ครั้งหน้าพาร์ทเดียวกันนับได้เลยไม่ต้องลากกรอบ</li></ol></section>';
  var inp = $('cntPart'), timer = 0;
  inp.addEventListener('input', function () { clearTimeout(timer); timer = setTimeout(function () { cntSetPart(inp.value); }, 500); });
  inp.addEventListener('change', function () { cntSetPart(inp.value); });
  $('cntPartScan').onclick = function () {
    openCameraScanner(function (raw) {
      var p = parseQr(checkScan(raw).text || raw), code = (p.part_code || '').toUpperCase();
      if (code) { inp.value = code; cntSetPart(code); beep(true); }
    });
  };
  $('cntFile').onchange = function () { var f = this.files && this.files[0]; this.value = ''; if (f) cntLoadFile(f); };
  cntSetPart(CNT.part, true);
  renderCntWork();
}
function cntSetPart(v, quiet) {
  v = String(v || '').trim().toUpperCase();
  if (v === CNT.part && CNT.profState && !quiet) return;
  CNT.part = v; store('pda_cnt_part', v);
  CNT.prof = v && CNT_PROFS[v] ? CNT_PROFS[v] : null; CNT.profState = v ? (CNT.prof ? 'cached' : 'loading') : '';
  renderCntProf();
  if (!v || !apiUrl()) { if (v && !CNT.prof) CNT.profState = 'none'; renderCntProf(); return; }
  api('getCountProfile', v).then(function (r) {
    if (CNT.part !== v) return;
    if (r && r.profile) { CNT.prof = r.profile; CNT.prof.uses = r.uses; CNT.prof.at = r.updated_at; CNT_PROFS[v] = CNT.prof; storeJson('pda_cnt_prof', CNT_PROFS); CNT.profState = 'ok'; }
    else { CNT.profState = CNT.prof ? 'cached' : 'none'; }
    renderCntProf();
  }, function () { if (CNT.part === v) { CNT.profState = CNT.prof ? 'cached' : 'offline'; renderCntProf(); } });
}
function renderCntProf() {
  var el = $('cntProf'); if (!el) return;
  var b = bomInfo(CNT.part) || {}, p = CNT.prof;
  el.innerHTML = !CNT.part ? '<span class="muted">ไม่ใส่รหัสก็นับได้ แต่แอปจะไม่จำการสอน</span>'
    : (b.name ? '<b>' + esc(b.name) + '</b>' + (b.spec ? ' <span class="kd-spec">' + esc(b.spec) + '</span>' : '') + '<br>' : '') +
      (p ? '🧠 <b>สอนแล้ว</b> · ตัวอย่าง ' + (p.tpl || []).length + ' · ตัวที่ไม่ใช่ ' + (p.neg || []).length + (p.uses ? ' · ใช้ ' + p.uses + ' ครั้ง' : '') + ' — ถ่ายรูปแล้วนับได้เลย'
        : CNT.profState === 'loading' ? '⏳ กำลังดูว่าเคยสอนไหม…' : '🆕 ยังไม่เคยสอนพาร์ทนี้ — ถ่ายรูปแล้วลากกรอบตัวอย่าง');
}
function cntLoadFile(file) {
  var url = URL.createObjectURL(file), img = new Image();
  img.onload = function () {
    var max = 1600, k = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
    var w = Math.round(img.naturalWidth * k), h = Math.round(img.naturalHeight * k);
    var c = document.createElement('canvas'); c.width = w; c.height = h;
    var ctx = c.getContext('2d', { willReadFrequently: true }); ctx.drawImage(img, 0, 0, w, h);
    URL.revokeObjectURL(url);
    cntSetImage(c);
  };
  img.onerror = function () { URL.revokeObjectURL(url); toast('เปิดรูปไม่ได้'); };
  img.src = url;
}
function cntSetImage(c) {
  var w = c.width, h = c.height, d = c.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, w, h).data, g = new Uint8Array(w * h);
  for (var i = 0, j = 0; i < g.length; i++, j += 4) g[i] = (d[j] * 77 + d[j + 1] * 150 + d[j + 2] * 29) >> 8;
  CNT.src = c; CNT.gray = { w: w, h: h, data: g }; CNT.sent = false;
  CNT.boxes = []; CNT.cands = []; CNT.removed = {}; CNT.added = []; CNT.undo = []; CNT.res = null; CNT.err = ''; CNT.done = null; CNT.zoom = 1;
  CNT.mode = CNT.prof && (CNT.prof.tpl || []).length ? 'edit' : 'box';
  renderCntWork();
  if (CNT.mode === 'edit') cntRun();
}
function cntPoints() {
  var out = [];
  CNT.cands.forEach(function (c, i) { if (c.s >= CNT.thr && !CNT.removed[i]) out.push({ x: c.x, y: c.y, i: i, auto: true }); });
  CNT.added.forEach(function (p, i) { out.push({ x: p.x, y: p.y, j: i, auto: false }); });
  return out;
}
function cntRun() {
  if (!CNT.gray || CNT.busy) return;
  var prof = CNT.prof, tpls = prof ? cntProfTpls(prof.tpl) : [], negs = prof ? cntProfTpls(prof.neg) : [];
  if (!CNT.boxes.length && !tpls.length) { CNT.mode = 'box'; renderCntWork(); toast('ลากกรอบรอบชิ้นงานตัวอย่างก่อน'); return; }
  CNT.busy = true; CNT.err = ''; renderCntWork();
  cntCall({ op: 'count', boxes: CNT.boxes, tpls: tpls, negs: negs, rot: CNT.rot, minScore: 0.3, objHint: prof && prof.obj ? prof.obj * CNT.src.width / (prof.imgW || CNT.src.width) : 0 }).then(function (r) {
    CNT.busy = false; CNT.res = r; CNT.cands = r.cands; CNT.removed = {}; CNT.undo = [];
    if (!CNT.boxes.length && prof && prof.thr) { CNT.thr = prof.thr; }
    CNT.mode = 'edit'; renderCntWork();
  }, function (err) { CNT.busy = false; CNT.err = err.message; renderCntWork(); });
}
function renderCntWork() {
  var el = $('cntWork'); if (!el) return;
  if ($('cntHelp')) $('cntHelp').classList.toggle('hidden', !!CNT.src);
  if (!CNT.src) { el.innerHTML = ''; return; }
  if (CNT.done) { el.innerHTML = cntDoneHtml(); bindCntDone(); return; }
  var pts = cntPoints(), nAuto = pts.filter(function (p) { return p.auto; }).length, nRem = Object.keys(CNT.removed).length;
  el.innerHTML =
    '<div class="cnt-bar"><div class="seg">' +
      '<button type="button" data-cm="box" class="' + (CNT.mode === 'box' ? 'active' : '') + '">✏ ลากกรอบ</button>' +
      '<button type="button" data-cm="edit" class="' + (CNT.mode === 'edit' ? 'active' : '') + '">👆 แก้จุด</button></div>' +
      '<button type="button" class="btn small' + (CNT.zoom > 1 ? ' active' : '') + '" id="cntZoom">🔍 ' + (CNT.zoom > 1 ? 'x' + CNT.zoom : 'ซูม') + '</button>' +
      '<button type="button" class="btn small" id="cntUndo"' + (CNT.undo.length ? '' : ' disabled') + '>↶ ย้อน</button></div>' +
    '<div class="cnt-hint small">' + (CNT.busy ? '⏳ กำลังนับ…' : CNT.err ? '<span class="err-text">⚠ ' + esc(CNT.err) + '</span>'
      : CNT.mode === 'box' ? '✏ ลากกรอบรอบชิ้นงาน 1–3 ชิ้น (ให้พอดีชิ้น) แล้วกด ▶ นับ' : '👆 แตะชิ้นที่ยังไม่มีจุด = เพิ่ม · แตะจุด = ลบ') + '</div>' +
    '<div class="cnt-stage' + (CNT.zoom > 1 ? ' zoomed' : '') + '" id="cntStage"><canvas id="cntCv"></canvas></div>' +
    '<div class="cnt-res"><div class="cnt-num"><b id="cntNum">' + (CNT.res || CNT.added.length ? pts.length : '—') + '</b> <span>ชิ้น</span></div>' +
      '<div class="small muted" id="cntDetail">' + (CNT.res ? 'อัตโนมัติ ' + nAuto + ' · เพิ่มเอง ' + CNT.added.length + ' · ลบ ' + nRem + (CNT.res.ms ? ' · ' + (CNT.res.ms / 1000).toFixed(1) + ' วิ' : '') : '') + '</div></div>' +
    '<div class="cnt-ctl">' +
      '<label class="cnt-thr">เกณฑ์ <span class="muted small">หลวม</span><input type="range" id="cntThr" min="0.35" max="0.9" step="0.01" value="' + CNT.thr + '"><span class="muted small">เข้ม</span></label>' +
      '<label class="cnt-rot"><input type="checkbox" id="cntRot"' + (CNT.rot ? ' checked' : '') + '> ชิ้นงานวางหลายทิศ</label>' +
      '<button type="button" class="btn" id="cntRun"' + (CNT.busy ? ' disabled' : '') + '>▶ นับ' + (CNT.res ? 'ใหม่' : '') + '</button>' +
      (CNT.boxes.length ? '<button type="button" class="btn small" id="cntClearBox">ล้างกรอบ (' + CNT.boxes.length + ')</button>' : '') + '</div>' +
    '<div class="actions"><button type="button" class="btn primary" id="cntOk"' + (pts.length && !CNT.busy ? '' : ' disabled') + '>✔ ยืนยัน ' + pts.length + ' ชิ้น</button></div>';
  Array.prototype.forEach.call(el.querySelectorAll('[data-cm]'), function (b) { b.onclick = function () { CNT.mode = b.getAttribute('data-cm'); renderCntWork(); }; });
  $('cntZoom').onclick = function () { CNT.zoom = CNT.zoom >= 3 ? 1 : CNT.zoom + 1; renderCntWork(); };
  $('cntUndo').onclick = cntUndo;
  $('cntThr').oninput = function () { CNT.thr = Number(this.value); store('pda_cnt_thr', CNT.thr); cntDraw(); cntUpdateNum(); };
  $('cntRot').onchange = function () { CNT.rot = this.checked; store('pda_cnt_rot', CNT.rot ? '1' : '0'); };
  $('cntRun').onclick = cntRun;
  if ($('cntClearBox')) $('cntClearBox').onclick = function () { CNT.boxes = []; renderCntWork(); };
  $('cntOk').onclick = cntConfirm;
  cntBindCanvas();
  cntDraw();
}
function cntUpdateNum() {
  var pts = cntPoints(), nAuto = pts.filter(function (p) { return p.auto; }).length;
  if ($('cntNum')) $('cntNum').textContent = pts.length;
  if ($('cntDetail') && CNT.res) $('cntDetail').textContent = 'อัตโนมัติ ' + nAuto + ' · เพิ่มเอง ' + CNT.added.length + ' · ลบ ' + Object.keys(CNT.removed).length;
  if ($('cntOk')) { $('cntOk').textContent = '✔ ยืนยัน ' + pts.length + ' ชิ้น'; $('cntOk').disabled = !pts.length; }
  if ($('cntUndo')) $('cntUndo').disabled = !CNT.undo.length;
}
// ขนาดแสดงผล: รูป (gray) → จอ
function cntView() {
  var st = $('cntStage'), cv = $('cntCv'); if (!st || !cv || !CNT.src) return null;
  var w = Math.max(200, (st.clientWidth || 320)) * CNT.zoom, k = w / CNT.src.width;
  return { st: st, cv: cv, k: k, w: Math.round(w), h: Math.round(CNT.src.height * k) };
}
function cntDraw(tmpBox) {
  var v = cntView(); if (!v) return;
  var dpr = window.devicePixelRatio || 1, cv = v.cv;
  if (cv.width !== Math.round(v.w * dpr) || cv.height !== Math.round(v.h * dpr)) { cv.width = Math.round(v.w * dpr); cv.height = Math.round(v.h * dpr); }
  cv.style.width = v.w + 'px'; cv.style.height = v.h + 'px';
  cv.style.touchAction = CNT.mode === 'box' ? 'none' : (CNT.zoom > 1 ? 'pan-x pan-y' : 'manipulation');
  var ctx = cv.getContext('2d'); ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.drawImage(CNT.src, 0, 0, v.w, v.h);
  var k = v.k, objMin = CNT.res ? CNT.res.objMin : 30, r = Math.max(5, Math.min(16, objMin * k * 0.22));
  var pts = cntPoints();
  pts.forEach(function (p, n) {
    var x = p.x * k, y = p.y * k;
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = p.auto ? 'rgba(18,183,106,.85)' : 'rgba(37,99,235,.9)'; ctx.fill();
    ctx.lineWidth = 2; ctx.strokeStyle = '#fff'; ctx.stroke();
    if (r >= 8) { ctx.fillStyle = '#fff'; ctx.font = 'bold ' + Math.round(r * 0.95) + 'px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(String(n + 1), x, y + 0.5); }
  });
  ctx.lineWidth = 2.5; ctx.setLineDash([6, 4]); ctx.strokeStyle = '#f59e0b';
  CNT.boxes.concat(tmpBox ? [tmpBox] : []).forEach(function (b) { ctx.strokeRect(b.x * k, b.y * k, b.w * k, b.h * k); });
  ctx.setLineDash([]);
}
function cntBindCanvas() {
  var cv = $('cntCv'); if (!cv) return;
  var drag = null;
  function pos(e) { var v = cntView(), r = cv.getBoundingClientRect(); return { x: (e.clientX - r.left) / v.k, y: (e.clientY - r.top) / v.k, k: v.k }; }
  cv.addEventListener('pointerdown', function (e) {
    if (CNT.mode !== 'box' || CNT.busy) return;
    e.preventDefault(); cv.setPointerCapture(e.pointerId); var p = pos(e); drag = { x0: p.x, y0: p.y, x: p.x, y: p.y };
  });
  cv.addEventListener('pointermove', function (e) {
    if (!drag) return; var p = pos(e); drag.x = p.x; drag.y = p.y;
    cntDraw({ x: Math.min(drag.x0, drag.x), y: Math.min(drag.y0, drag.y), w: Math.abs(drag.x - drag.x0), h: Math.abs(drag.y - drag.y0) });
  });
  function end() {
    if (!drag) return;
    var b = { x: Math.min(drag.x0, drag.x), y: Math.min(drag.y0, drag.y), w: Math.abs(drag.x - drag.x0), h: Math.abs(drag.y - drag.y0) };
    drag = null;
    if (b.w * cntView().k < 10 || b.h * cntView().k < 10) { cntDraw(); return; }
    CNT.boxes.push(b); if (CNT.boxes.length > 3) CNT.boxes.shift();
    renderCntWork();
    cntRun();
  }
  cv.addEventListener('pointerup', end); cv.addEventListener('pointercancel', function () { drag = null; cntDraw(); });
  cv.addEventListener('click', function (e) {
    if (CNT.mode !== 'edit' || CNT.busy) return;
    var p = pos(e), objMin = CNT.res ? CNT.res.objMin : 30, near = null, best = Math.max(12 / p.k, objMin * 0.45);
    cntPoints().forEach(function (q) { var d = Math.hypot(q.x - p.x, q.y - p.y); if (d < best) { best = d; near = q; } });
    if (near) {
      if (near.auto) { CNT.removed[near.i] = 1; CNT.undo.push({ t: 'rem', i: near.i }); }
      else { var a = CNT.added.splice(near.j, 1)[0]; CNT.undo.push({ t: 'unadd', p: a, j: near.j }); }
    } else { CNT.added.push({ x: Math.round(p.x * 10) / 10, y: Math.round(p.y * 10) / 10 }); CNT.undo.push({ t: 'add' }); }
    cntDraw(); cntUpdateNum();
  });
}
function cntUndo() {
  var u = CNT.undo.pop(); if (!u) return;
  if (u.t === 'rem') delete CNT.removed[u.i];
  else if (u.t === 'add') CNT.added.pop();
  else if (u.t === 'unadd') CNT.added.splice(u.j, 0, u.p);
  cntDraw(); cntUpdateNum();
}
// ยืนยัน: จำการสอน (แม่แบบจากกรอบ + ชิ้นที่คนเพิ่ม = ตัวอย่าง · จุดที่คนลบ = ตัวที่ไม่ใช่) + เก็บข้อมูลเทรน
function cntConfirm() {
  var pts = cntPoints(), n = pts.length; if (!n) return;
  var res = CNT.res || { objW: 30, objH: 30, tplsOut: [] }, ow = res.objW, oh = res.objH;
  var added = CNT.added.slice(-3), removed = Object.keys(CNT.removed).map(Number).slice(-6).map(function (i) { return CNT.cands[i]; });
  var items = added.concat(removed).map(function (p) { return { x: p.x, y: p.y, w: ow, h: oh }; });
  var summary = { n: n, auto: pts.filter(function (p) { return p.auto; }).length, added: CNT.added.length, removed: Object.keys(CNT.removed).length };
  CNT.done = { n: n, part: CNT.part, profMsg: CNT.part ? '⏳ กำลังจำการสอน…' : 'ไม่ได้ใส่รหัสพาร์ท — ไม่ได้จำการสอน', sampleMsg: '⏳ กำลังเก็บรูปไว้เทรน…' };
  renderCntWork();
  (items.length ? cntCall({ op: 'crop', items: items }) : Promise.resolve({ patches: [] })).then(function (cr) {
    var enc = function (t) { return { w: t.w, h: t.h, b: b64FromU8(t.data) }; };
    var newPos = (res.tplsOut || []).map(enc).concat(cr.patches.slice(0, added.length).map(enc));
    var newNeg = cr.patches.slice(added.length).map(enc);
    if (CNT.part) {
      var old = CNT.prof || {}, prof = { v: 1, tn: 16, tpl: newPos.concat(old.tpl || []).slice(0, 8), neg: newNeg.concat(old.neg || []).slice(0, 16), thr: CNT.thr, rot: CNT.rot, obj: Math.round(res.objMin || 0), imgW: CNT.src.width };
      var part = CNT.part;
      api('saveCountProfile', part, prof, S.user).then(function (r) {
        prof.uses = r.uses; prof.at = r.updated_at; CNT_PROFS[part] = prof; storeJson('pda_cnt_prof', CNT_PROFS);
        if (CNT.part === part) { CNT.prof = prof; CNT.profState = 'ok'; renderCntProf(); }
        if (CNT.done) { CNT.done.profMsg = '🧠 จำการสอนของ ' + esc(part) + ' แล้ว (ครั้งที่ ' + r.uses + ')'; renderCntWork(); }
      }, function (err) {
        CNT_PROFS[part] = prof; storeJson('pda_cnt_prof', CNT_PROFS); if (CNT.part === part) CNT.prof = prof;
        if (CNT.done) { CNT.done.profMsg = '⚠ จำในเครื่องนี้แล้ว แต่ส่งขึ้นเซิร์ฟเวอร์ไม่ได้: ' + esc(err.message); renderCntWork(); }
      });
    }
  }).catch(function (err) { if (CNT.done) { CNT.done.profMsg = '⚠ ' + esc(err.message); renderCntWork(); } });
  // รูป + จุด (ข้อมูลเทรน)
  var jpg = CNT.src.toDataURL('image/jpeg', 0.85).split(',')[1];
  api('saveCountSample', { part: CNT.part, count: n, auto: summary.auto, added: summary.added, removed: summary.removed, thr: CNT.thr, by: S.user,
    w: CNT.src.width, h: CNT.src.height, objW: Math.round(ow), objH: Math.round(oh), data: jpg,
    points: pts.map(function (p) { return [Math.round(p.x), Math.round(p.y), p.auto ? 1 : 0]; }) }).then(function () {
    if (CNT.done) { CNT.done.sampleMsg = '📦 เก็บรูป + จุดไว้เทรนแล้ว'; renderCntWork(); }
  }, function (err) { if (CNT.done) { CNT.done.sampleMsg = '⚠ เก็บรูปไว้เทรนไม่ได้: ' + esc(err.message); renderCntWork(); } });
}
function cntDoneHtml() {
  var d = CNT.done;
  return '<div class="cnt-done"><div class="cnt-num"><b>' + d.n + '</b> <span>ชิ้น</span></div>' +
    (d.part ? '<div>' + esc(d.part) + '</div>' : '') +
    '<div class="small">' + d.profMsg + '</div><div class="small">' + d.sampleMsg + '</div>' +
    '<div class="actions"><button type="button" class="btn primary" id="cntToManual">📝 บันทึกจำนวนนี้ (หน้ากรอกเอง)</button>' +
      '<button type="button" class="btn" id="cntBack">← กลับไปแก้</button></div></div>';
}
function bindCntDone() {
  $('cntToManual').onclick = function () {
    var part = CNT.done.part, n = CNT.done.n;
    S.view = 'manual'; render();
    if (part && $('mfPart')) { $('mfPart').value = part; updatePartInfo(); }
    if ($('mfQty')) { $('mfQty').value = String(n); $('mfQty').focus(); }
    toast('ใส่จำนวน ' + n + ' จากการนับรูปแล้ว — เลือก Location แล้วกดบันทึก', 3500);
  };
  $('cntBack').onclick = function () { CNT.done = null; renderCntWork(); };
}
window.addEventListener('resize', function () { if (S.view === 'count' && CNT.src && !CNT.done) cntDraw(); });

(function init() {
  render();
  if (!S.user) openUserModal();

  // โฟกัสต้องอยู่ที่ช่องสแกนเสมอ — หลังแตะปุ่ม โฟกัสจะค้างที่ปุ่ม ถ้าไม่ดึงกลับ ค่าที่สแกนจะหาย และ Enter จะไปกดปุ่มนั้นแทน
  function isTextField(a) { return a && (a.tagName === 'INPUT' && a.type !== 'button' && a.type !== 'checkbox' && a.type !== 'radio' || a.tagName === 'TEXTAREA' || a.tagName === 'SELECT'); }
  document.addEventListener('click', function () { setTimeout(function () {
    if (S.view === 'scan' && !isTextField(document.activeElement)) focusScan();
  }, 0); });
  document.addEventListener('keydown', function (e) {
    var a = document.activeElement, inp = $('scanInput');
    if (S.view !== 'scan' || !inp || a === inp || isTextField(a) || !$('modal').classList.contains('hidden')) return;
    if (e.key.length === 1) {
      e.preventDefault(); // ส่งตัวอักษรนี้เข้าช่องสแกนเอง ไม่ให้หายตัวแรก
      inp.focus({ preventScroll: true });
      inp.value += e.key;
      inp.dispatchEvent(new Event('input'));
    } else if (e.key === 'Enter' || e.keyCode === 13) {
      e.preventDefault(); // กัน Enter ไปกดปุ่มที่โฟกัสอยู่ (เช่น ปุ่มลบ)
      commitScanInput();
      inp.focus({ preventScroll: true });
    }
  }, true);
  document.addEventListener('visibilitychange', function () { if (!document.hidden) { focusScan(); flush(); } });
  window.addEventListener('online', function () { S.online = true; flush(); refreshHeader(); });
  window.addEventListener('offline', function () { S.online = false; refreshScanParts(); });
  setInterval(function () { flush(); flushPhotos(); }, 8000);
  flush(); flushPhotos();
  setInterval(checkUpdate, 60000);
  setInterval(syncRecent, 60000);
  setTimeout(syncRecent, 1500);
  document.addEventListener('visibilitychange', function () { if (!document.hidden) syncRecent(); });
  document.addEventListener('visibilitychange', function () { if (!document.hidden) checkUpdate(); });
  setTimeout(checkUpdate, 3000);
})();

// ---------- อัปเดตอัตโนมัติ ----------
// GitHub Pages ให้เบราว์เซอร์ cache ไฟล์ได้ 10 นาที → เครื่องที่เปิดค้างไว้อาจใช้โค้ดเก่า
// เช็ค version.json แบบไม่ใช้ cache ถ้ามีเวอร์ชันใหม่ ให้โหลดหน้าใหม่ด้วย URL ใหม่ (?v=) ตอนที่ไม่ได้ทำอะไรค้างอยู่
var updateReady = null;
function checkUpdate() {
  if (APP_VERSION === 'dev' || !window.fetch) return;
  fetch('version.json?_=' + Date.now(), { cache: 'no-store' }).then(function (r) { return r.ok ? r.json() : null; }).then(function (d) {
    if (d && d.version && d.version !== APP_VERSION) { updateReady = d.version; tryReload(); }
  }, function () {});
}
function tryReload() {
  if (!updateReady) return;
  var inp = $('scanInput');
  var busy = S.draft || manualDirty() || S.syncing || S.photoSyncing || !$('modal').classList.contains('hidden') || (inp && inp.value);
  if (busy) { setTimeout(tryReload, 5000); return; }
  location.replace(location.pathname + '?v=' + encodeURIComponent(updateReady));
}
