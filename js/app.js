// ======================= PDA Location Scan — หน้าจอหลัก =======================
// ใช้กับ Zebra DataWedge แบบ Keystroke output + ENTER: ค่าที่สแกนจะถูก "พิมพ์" ลงช่องสแกนแล้วกด Enter ให้เอง

var MAX_RECENT = 200;
var SYNC_BATCH = 20;

var S = {
  view: 'scan',
  user: store('pda_user') || '',
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
  hist: { filter: { date: today(), location: '', user: '', q: '', includeDeleted: false }, data: null, loading: false, error: '' }
};

// ---------- helpers ----------
function $(id) { return document.getElementById(id); }
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}
function pad(n) { return (n < 10 ? '0' : '') + n; }
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
function render() {
  var pending = S.recent.filter(function (r) { return r.status === 'pending'; }).length;
  $('app').innerHTML =
    '<header class="top">' +
      '<div class="brand">PDA Scan</div>' +
      '<button class="chip" id="btnUser">' + (S.user ? '👤 ' + esc(S.user) : '👤 ใส่ชื่อ') + '</button>' +
      '<span id="net" class="dot ' + (S.online ? 'on' : 'off') + '" title="สถานะเครือข่าย"></span>' +
      '<button class="icon" id="btnSettings" aria-label="ตั้งค่า">⚙</button>' +
    '</header>' +
    '<nav class="tabs">' +
      '<button data-view="scan" class="' + (S.view === 'scan' ? 'active' : '') + '">สแกน' + (pending ? ' <b class="badge">' + pending + '</b>' : '') + '</button>' +
      '<button data-view="history" class="' + (S.view === 'history' ? 'active' : '') + '">ประวัติ / ลบ</button>' +
    '</nav>' +
    '<main id="main"></main>';
  $('btnUser').onclick = openUserModal;
  $('btnSettings').onclick = openSettings;
  Array.prototype.forEach.call(document.querySelectorAll('.tabs button'), function (b) {
    b.onclick = function () { S.view = b.getAttribute('data-view'); render(); };
  });
  if (S.view === 'scan') renderScan(); else renderHistory();
}

function refreshHeader() {
  var pending = S.recent.filter(function (r) { return r.status === 'pending'; }).length;
  var tab = document.querySelector('.tabs button[data-view="scan"]');
  if (tab) tab.innerHTML = 'สแกน' + (pending ? ' <b class="badge">' + pending + '</b>' : '');
  var n = $('net'); if (n) n.className = 'dot ' + (S.online ? 'on' : 'off');
}

// ======================= หน้าสแกน =======================
// ช่องสแกนสร้างครั้งเดียว ส่วนอื่นอัปเดตแยก — กันตัวอักษรหายระหว่าง DataWedge กำลังพิมพ์
function renderScan() {
  $('main').innerHTML =
    '<section id="locCard" class="loc-card"></section>' +
    '<section class="scan-box">' +
      '<input id="scanInput" class="scan-input" inputmode="none" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="กดปุ่มสแกนที่ตัวเครื่อง">' +
      '<button id="btnType" class="btn ghost" title="พิมพ์รหัสเอง">⌨</button>' +
    '</section>' +
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
  var busy = S.syncing || S.photoSyncing;
  el.innerHTML = pending || pPhotos
    ? '<div class="sync-bar"><span>' + (busy ? '⏳ กำลังส่ง…' : '⏸ รอส่ง') + ' ' +
        [pending ? pending + ' รายการ' : '', pPhotos ? pPhotos + ' รูป' : ''].filter(Boolean).join(', ') + (S.online ? '' : ' (ออฟไลน์)') + '</span>' +
      '<button class="btn small" id="btnSync"' + (busy ? ' disabled' : '') + '>ส่งตอนนี้</button></div>'
    : '';
  if ($('btnSync')) $('btnSync').onclick = function () { flush(true); flushPhotos(true); };
  refreshHeader();
}

var STATUS_TEXT = { pending: 'รอส่ง', saved: 'บันทึกแล้ว', duplicate: 'ซ้ำ', error: 'ผิดพลาด', deleted: 'ลบแล้ว' };

function renderRecent() {
  var el = $('recent'); if (!el) return;
  var t = today();
  var savedToday = S.recent.filter(function (r) {
    var d = new Date(r.scanned_at);
    return r.status === 'saved' && !isNaN(d) && d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) === t;
  }).length;
  if ($('count')) $('count').textContent = 'วันนี้บันทึก ' + savedToday + ' รายการ';
  if (!S.recent.length) { el.innerHTML = '<div class="empty-list muted">ยังไม่มีรายการ</div>'; return; }
  el.innerHTML = S.recent.slice(0, 60).map(function (r) {
    var extra = '';
    if (r.status === 'duplicate' && r.existing) {
      extra = '<div class="dup">QR นี้บันทึกแล้วที่ <b>' + esc(r.existing.location) + '</b> โดย ' + esc(r.existing.scanned_by) +
        ' (' + esc(r.existing.scanned_at) + ')' +
        (r.existing.location !== r.location ? '<button class="btn small warn" data-move="' + esc(r.scan_id) + '">ย้ายมาที่ ' + esc(r.location) + '</button>' : '') +
        '</div>';
    } else if (r.status === 'error' && r.error) {
      extra = '<div class="dup">' + esc(r.error) + '</div>';
    }
    var canDelete = r.status !== 'deleted';
    var delLabel = r.status === 'saved' ? 'ลบ' : 'ลบออก';
    return '<div class="row st-' + r.status + '">' +
      '<div class="row-main">' +
        '<div class="row-top"><b class="part">' + esc(r.part_code || r.qr_raw) + '</b><span class="tag ' + r.status + '">' + STATUS_TEXT[r.status] + '</span></div>' +
        '<div class="row-sub">' +
          '<span class="loc-pill">' + esc(r.location) + '</span>' +
          (r.lot_no ? '<span>Lot ' + esc(r.lot_no) + '</span>' : '') +
          (r.qty !== '' ? '<span>' + esc(fmtQty(r.qty, r.unit)) + '</span>' : '') +
          '<span class="muted">' + hhmm(r.scanned_at) + '</span>' +
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
  bindPhotoButtons(el, function () { return null; });
}

function refreshScanParts() { if (S.view === 'scan') { renderSync(); renderRecent(); } else refreshHeader(); }

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

  if (chk.error) {
    beep(false);
    setDraft(null);
    setMsg('err', '❌ ' + esc(chk.error) + '<br><span class="small">ค่าที่อ่านได้: ' + esc(text.slice(0, 120)) + '</span>');
    return;
  }

  var p = parseQr(text);
  var replaced = S.draft && S.draft.qr_raw !== p.qr_raw ? S.draft : null;
  var dup = findSavedDuplicate(p.qr_raw);
  setDraft({
    qr_raw: p.qr_raw, part_code: p.part_code, lot_no: p.lot_no, qty: p.qty, unit: p.unit, pkg_ref: p.pkg_ref,
    scanned_at: new Date().toISOString()
  });
  if (dup) {
    beep(false);
    setMsg('err', '⚠ QR นี้บันทึกแล้วที่ <b>' + esc(dup.location) + '</b> เวลา ' + hhmm(dup.scanned_at) +
      '<br>ถ้าต้องการย้าย ให้ลบรายการเดิมก่อน');
    return;
  }
  beep(true);
  setMsg('warn', (chk.fixed ? 'อ่านค่าซ้ำ 2 รอบในครั้งเดียว ระบบตัดให้เหลือ 1 แล้ว · ' : '') +
    (replaced ? 'แทนที่รายการก่อนหน้า (' + esc(replaced.part_code) + ') · ' : '') +
    (S.location ? 'ตรวจสอบแล้วกด <b>บันทึก</b>' : 'เลือก Location แล้วกด <b>บันทึก</b>'));
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
  var dup = findSavedDuplicate(d.qr_raw);
  el.innerHTML = '<section class="draft-card' + (dup ? ' bad' : '') + '">' +
    '<div class="draft-head"><span>สแกนแล้ว · ยังไม่บันทึก</span><button class="link" id="dCancel">ยกเลิก</button></div>' +
    '<div class="draft-part">' + esc(d.part_code || d.qr_raw) + '</div>' +
    '<div class="row-sub">' +
      (d.lot_no ? '<span>Lot ' + esc(d.lot_no) + '</span>' : '') +
      (d.qty !== '' ? '<span><b>' + esc(fmtQty(d.qty, d.unit)) + '</b></span>' : '') +
      (d.pkg_ref ? '<span class="muted">Pkg ' + esc(d.pkg_ref) + '</span>' : '') +
    '</div>' +
    (S.location
      ? '<button class="btn primary save-btn" id="dSave"' + (dup ? ' disabled' : '') + '>💾 บันทึก → ' + esc(S.location) + '</button>'
      : '<button class="btn warn save-btn" id="dPickLoc">📍 เลือก Location ก่อนบันทึก</button>') +
  '</section>';
  $('dCancel').onclick = function () { setDraft(null); setMsg('idle', 'ยกเลิกแล้ว — สแกนรายการใหม่ได้เลย'); focusScan(); };
  if ($('dSave')) $('dSave').onclick = saveDraft;
  if ($('dPickLoc')) $('dPickLoc').onclick = openLocationPicker;
}

function saveDraft() {
  var d = S.draft; if (!d) return;
  if (!S.user) { beep(false); setMsg('err', 'กรุณาใส่ชื่อผู้สแกนก่อน'); openUserModal(); return; }
  if (!S.location) { beep(false); openLocationPicker(); return; }
  var dup = findSavedDuplicate(d.qr_raw);
  if (dup) { beep(false); setMsg('err', '⚠ QR นี้บันทึกแล้วที่ <b>' + esc(dup.location) + '</b>'); return; }
  var item = {
    scan_id: uid(), scanned_at: d.scanned_at || new Date().toISOString(), location: S.location,
    qr_raw: d.qr_raw, part_code: d.part_code, lot_no: d.lot_no, qty: d.qty, unit: d.unit, pkg_ref: d.pkg_ref,
    scanned_by: S.user, device: S.device, status: 'pending'
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

function setLocation(loc) {
  S.location = loc; store('pda_loc', loc);
  renderLoc(); renderDraft();
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
      lot_no: r.lot_no, qty: r.qty, unit: r.unit, pkg_ref: r.pkg_ref, scanned_by: r.scanned_by, device: r.device };
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

// ---------- ลบ ----------
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

function moveDuplicate(id) {
  var r = findRecent(id); if (!r || !r.existing) return;
  confirmModal('ย้าย Location?', 'ลบรายการเดิมที่ <b>' + esc(r.existing.location) + '</b> แล้วบันทึกใหม่ที่ <b>' + esc(r.location) + '</b>', 'ย้าย', function () {
    api('deleteScan', r.existing.scan_id, S.user, 'ย้าย Location → ' + r.location).then(function () {
      var old = findRecent(r.existing.scan_id); if (old) old.status = 'deleted';
      r.status = 'pending'; delete r.existing;
      saveRecent(); refreshScanParts(); flush();
      toast('ย้ายแล้ว');
    }, function (err) { toast(err.message, 3500); });
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
  var f = S.hist.filter;
  $('main').innerHTML =
    '<section class="filters">' +
      '<input type="date" id="fDate" class="field" value="' + esc(f.date) + '">' +
      '<input id="fLoc" class="field" placeholder="Location (เช่น CO-01)" value="' + esc(f.location) + '">' +
      '<input id="fUser" class="field" placeholder="ผู้สแกน" value="' + esc(f.user) + '">' +
      '<input id="fQ" class="field" placeholder="ค้นหา รหัสสินค้า / Lot / QR" value="' + esc(f.q) + '">' +
      '<label class="radio"><input type="checkbox" id="fDel"' + (f.includeDeleted ? ' checked' : '') + '> แสดงรายการที่ลบแล้ว</label>' +
      '<button class="btn primary" id="fGo">ค้นหา</button>' +
    '</section>' +
    '<div id="histOut"></div>';
  $('fGo').onclick = function () {
    S.hist.filter = { date: $('fDate').value, location: $('fLoc').value.trim().toUpperCase(), user: $('fUser').value.trim(),
      q: $('fQ').value.trim(), includeDeleted: $('fDel').checked };
    loadHistory();
  };
  ['fLoc', 'fUser', 'fQ'].forEach(function (id) {
    $(id).addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); $('fGo').click(); } });
  });
  if (S.hist.data) renderHistoryList(); else loadHistory();
}

function loadHistory() {
  S.hist.loading = true; S.hist.error = ''; renderHistoryList();
  api('listScans', Object.assign({ limit: 300 }, S.hist.filter)).then(function (d) {
    S.online = true; S.hist.data = d; S.hist.loading = false; renderHistoryList(); refreshHeader();
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
      var del = r.status === 'deleted';
      return '<div class="row ' + (del ? 'st-deleted' : '') + '">' +
        '<div class="row-main">' +
          '<div class="row-top"><b class="part">' + esc(r.part_code || r.qr_raw) + '</b>' + (del ? '<span class="tag deleted">ลบแล้ว</span>' : '') + '</div>' +
          '<div class="row-sub"><span class="loc-pill">' + esc(r.location) + '</span>' +
            (r.lot_no ? '<span>Lot ' + esc(r.lot_no) + '</span>' : '') +
            (r.qty !== '' ? '<span>' + esc(fmtQty(r.qty, r.unit)) + '</span>' : '') + photoChip(r.scan_id, r) + '</div>' +
          '<div class="row-sub muted"><span>' + esc(r.scanned_by) + '</span><span>' + esc(r.scanned_at) + '</span></div>' +
          (del ? '<div class="row-sub muted small">ลบโดย ' + esc(r.deleted_by) + ' · ' + esc(r.deleted_at) + ' · ' + esc(r.delete_reason) + '</div>' : '') +
        '</div>' +
        (del ? '' : '<div class="row-actions"><button class="btn small" data-cam="' + esc(r.scan_id) + '" aria-label="ถ่ายรูป">📷</button>' +
          '<button class="btn small danger" data-hdel="' + esc(r.scan_id) + '">ลบ</button></div>') +
      '</div>';
    }).join('');
  bindPhotoButtons(el, function (id) { return d.rows.filter(function (x) { return x.scan_id === id; })[0] || null; });
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
function openModal(html) {
  var m = $('modal');
  m.innerHTML = '<div class="sheet">' + html + '</div>';
  m.classList.remove('hidden');
  m.onclick = function (e) { if (e.target === m) closeModal(); };
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

function openUserModal() {
  openModal('<h3>ชื่อผู้สแกน</h3>' +
    '<p class="muted small">ใช้บันทึกว่าใครเป็นคนสแกน/ลบ (จำไว้ในเครื่องนี้)</p>' +
    '<input id="uName" class="field big" placeholder="ชื่อ หรือ รหัสพนักงาน" value="' + esc(S.user) + '">' +
    '<div class="actions"><button class="btn" id="mCancel">ยกเลิก</button><button class="btn primary" id="mOk">บันทึก</button></div>');
  var inp = $('uName'); setTimeout(function () { inp.focus(); }, 50);
  inp.addEventListener('keydown', function (e) { if (e.key === 'Enter') $('mOk').click(); });
  $('mCancel').onclick = closeModal;
  $('mOk').onclick = function () {
    var v = inp.value.trim();
    if (!v) { toast('กรุณาใส่ชื่อ'); return; }
    S.user = v; store('pda_user', v); closeModal(); render();
  };
}

function openSettings() {
  openModal('<h3>ตั้งค่า</h3>' +
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

function openLocationPicker() {
  var cur = (S.location || '').match(/^([A-Z0-9]+)-(\d+)-/);
  var zones = Object.keys(LOC_TREE);
  var st = { zone: cur ? cur[1] : zones[0], rack: cur ? cur[2] : null, q: '' };
  openModal('<h3>เลือก Location</h3>' +
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

  function choose(code) { setLocation(code); closeModal(); beep(true); setMsg('ok', '📍 Location: <b>' + esc(code) + '</b>'); }

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
  function btn(code, label) { return '<button data-loc="' + esc(code) + '" class="' + (code === S.location ? 'active' : '') + '">' + esc(label) + '</button>'; }
  draw();
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
  return files.reduce(function (p, f) { return p.then(function () { return addPhoto(scanId, f, row); }); }, Promise.resolve())
    .then(function () { if (files.length) { toast('แนบรูปแล้ว ' + files.length + ' รูป'); flushPhotos(); } });
}

function compressImage(file) {
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
  if (S.view === 'scan') { renderSync(); renderRecent(); } else { renderHistoryList(); refreshHeader(); }
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
  openModal('<h3>รูปถ่าย</h3>' +
    '<div class="muted small">' + esc(r.part_code || r.qr_raw || '') + (r.location ? ' @ ' + esc(r.location) : '') + '</div>' +
    (ids.length ? '<div class="photo-grid">' + ids.map(function (id) {
      return '<div class="photo"><img data-pid="' + esc(id) + '" alt="">' +
        (isPhotoPending(id) ? '<span class="ptag">รอส่ง</span>' : '') +
        '<button class="pdel" data-pdel="' + esc(id) + '" aria-label="ลบรูป">✕</button></div>';
    }).join('') + '</div>' : '<div class="empty-list muted">ยังไม่มีรูป</div>') +
    '<div class="actions wrap"><button class="btn primary" id="pCam">📷 ถ่ายรูป</button><button class="btn" id="pGal">🖼 เลือกจากเครื่อง</button></div>' +
    '<div class="actions"><button class="btn" id="mCancel">ปิด</button></div>');
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

function viewPhoto(src, scanId, row) {
  openPhotos.current = null;
  openModal('<img class="photo-full" src="' + src + '" alt=""><div class="actions"><button class="btn" id="mBack">กลับ</button></div>');
  $('mBack').onclick = function () { openPhotos(scanId, row); };
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
})();
