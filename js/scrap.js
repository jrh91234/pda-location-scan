// ======================= Scrap — พาเลทเศษวัสดุ =======================
// สร้างพาเลท (เลขพาเลท = วันที่-ลำดับ เช่น 11062026-1 ออกโดยเซิร์ฟเวอร์) · น้ำหนัก kg · รูปหลายรูป (ใช้ระบบรูปเดียวกับหน้าสแกน)
// สถานะ: เปิดอยู่ → ปิดพาเลท (ชั่งแล้ว) → ส่งขาย/ส่งออกแล้ว · Export Excel / PDF (รายงาน, ใบพาเลท, ป้ายพาเลทพร้อม QR)

var SCRAP_TYPES = ['เหล็ก', 'สแตนเลส', 'ทองแดง', 'อลูมิเนียม', 'พลาสติก', 'กระดาษ/ลัง', 'ไม้/พาเลท', 'ชิ้นงานเสีย (NG)', 'อื่นๆ'];
var SCRAP_ST = { open: ['เปิดอยู่', 'pending'], closed: ['ปิดแล้ว', 'saved'], shipped: ['ส่งออกแล้ว', 'shipped'], deleted: ['ลบแล้ว', 'deleted'] };
var SCRAP_WEIGHT_REASONS = ['ชั่งใหม่', 'กรอกผิด', 'เพิ่ม/เอาของออกจากพาเลท', 'อื่นๆ'];
var SCRAP_DELETE_REASONS = ['สร้างซ้ำ', 'สร้างผิด', 'รวมกับพาเลทอื่น', 'อื่นๆ'];
var SCRAP_ID_RE = /^\d{8}-\d+$/;
var H2P_URL = 'https://cdnjs.cloudflare.com/ajax/libs/html2pdf.js/0.10.1/html2pdf.bundle.min.js';
var QRGEN_URL = 'https://cdnjs.cloudflare.com/ajax/libs/qrcode-generator/1.4.4/qrcode.min.js';

// โหลดก่อน app.js (app.js render ทันทีตอนโหลด) → ห้ามเรียกฟังก์ชันของ app.js ที่ระดับบนสุดของไฟล์นี้
var SC = { filter: null, filterInit: { dateFrom: '', dateTo: '', status: '', type: '', q: '', includeDeleted: false }, data: null, loading: false, error: '',
  types: storeJson('pda_scrap_types') || [], sources: storeJson('pda_scrap_sources') || [] };

function scrapFmtKg(v) { return v === '' || v == null ? '' : Number(v).toLocaleString('en-US', { maximumFractionDigits: 3 }) + ' kg'; }
function scrapDay(d) { var m = /^(\d{4})-(\d\d)-(\d\d)/.exec(d || ''); return m ? m[3] + '/' + m[2] + '/' + m[1] : (d || ''); }
function scrapTypes() { // ประเภทมาตรฐาน + ที่เคยใช้ในระบบ
  var out = SCRAP_TYPES.slice();
  SC.types.forEach(function (t) { if (t && out.indexOf(t) < 0) out.push(t); });
  return out;
}
// ข้อมูลสำหรับระบบรูป (openPhotos ใช้ scan_id / part_code / location / photos ของ row)
function scrapDecorate(r) { r.scan_id = r.pallet_id; r.part_code = 'พาเลท ' + r.pallet_id; r.location = ''; r.photos = r.photos || []; return r; }
function scrapRowOf(id) { return SC.data && SC.data.rows.filter(function (x) { return x.pallet_id === id; })[0] || null; }
function scrapStTag(st) { var s = SCRAP_ST[st] || SCRAP_ST.open; return '<span class="tag ' + s[1] + '">' + s[0] + '</span>'; }

// ---------- หน้า Scrap ----------
function renderScrap() {
  if (!SC.filter) SC.filter = Object.assign({}, SC.filterInit, { dateFrom: today(), dateTo: today() });
  var f = SC.filter;
  $('main').innerHTML =
    '<section class="scrap-top">' +
      '<button class="btn primary save-btn" id="scNew">＋ สร้างพาเลทใหม่</button>' +
      '<div class="scan-box"><input id="scFind" class="field" placeholder="สแกน / พิมพ์เลขพาเลท เช่น ' + esc(scrapIdOf(new Date(), 1)) + '" autocomplete="off" enterkeyhint="search">' +
        '<button class="btn" id="scFindGo">เปิด</button></div>' +
    '</section>' +
    '<section class="filters">' +
      '<label class="flabel">จากวันที่<input type="date" id="scFrom" class="field" value="' + esc(f.dateFrom) + '"></label>' +
      '<label class="flabel">ถึงวันที่<input type="date" id="scTo" class="field" value="' + esc(f.dateTo) + '"></label>' +
      '<div class="seg quick-seg">' + [['today', 'วันนี้'], ['yesterday', 'เมื่อวาน'], ['7', '7 วัน'], ['month', 'เดือนนี้'], ['all', 'ทั้งหมด']].map(function (o) {
        return '<button type="button" data-scq="' + o[0] + '" class="' + (scrapQuickOf(f) === o[0] ? 'active' : '') + '">' + o[1] + '</button>';
      }).join('') + '</div>' +
      '<div class="seg span2">' + [['', 'ทุกสถานะ'], ['open', 'เปิดอยู่'], ['closed', 'ปิดแล้ว'], ['shipped', 'ส่งออกแล้ว']].map(function (o) {
        return '<button type="button" data-scst="' + o[0] + '" class="' + (f.status === o[0] ? 'active' : '') + '">' + o[1] + '</button>';
      }).join('') + '</div>' +
      '<select id="scType" class="field"><option value="">ทุกประเภท</option>' + scrapTypes().map(function (t) {
        return '<option' + (t === f.type ? ' selected' : '') + '>' + esc(t) + '</option>';
      }).join('') + '</select>' +
      '<input id="scQ" class="field" placeholder="ค้นหา ที่มา / หมายเหตุ / ผู้สร้าง" value="' + esc(f.q) + '">' +
      '<label class="radio"><input type="checkbox" id="scDel"' + (f.includeDeleted ? ' checked' : '') + '> แสดงที่ลบแล้ว</label>' +
      '<button class="btn primary" id="scGo">ค้นหา</button>' +
      '<button class="btn" id="scXlsx">⬇️ Excel</button>' +
      '<button class="btn" id="scPdf">⬇️ PDF</button>' +
    '</section>' +
    '<div id="scOut"></div>';
  $('scNew').onclick = openScrapCreate;
  $('scFindGo').onclick = scrapFindSubmit;
  $('scFind').addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); scrapFindSubmit(); } });
  $('scGo').onclick = function () { SC.filter = readScrapFilter(); scrapMarkQuick(); loadScrap(); };
  $('scType').onchange = $('scDel').onchange = function () { $('scGo').click(); };
  $('scQ').addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); $('scGo').click(); } });
  $('scXlsx').onclick = exportScrapExcel;
  $('scPdf').onclick = openScrapPdfMenu;
  Array.prototype.forEach.call(document.querySelectorAll('[data-scst]'), function (b) {
    b.onclick = function () {
      Array.prototype.forEach.call(document.querySelectorAll('[data-scst]'), function (x) { x.classList.toggle('active', x === b); });
      $('scGo').click();
    };
  });
  Array.prototype.forEach.call(document.querySelectorAll('[data-scq]'), function (b) {
    b.onclick = function () {
      var r = scrapQuickRange(b.getAttribute('data-scq'));
      $('scFrom').value = r[0]; $('scTo').value = r[1];
      $('scGo').click();
    };
  });
  if (SC.data) renderScrapList(); else loadScrap();
}

function scrapIdOf(d, seq) { return pad(d.getDate()) + pad(d.getMonth() + 1) + d.getFullYear() + '-' + seq; }
function scrapYmd(x) { return x.getFullYear() + '-' + pad(x.getMonth() + 1) + '-' + pad(x.getDate()); }
function scrapQuickRange(q) {
  var t = today(), d = new Date(t + 'T12:00:00');
  if (q === 'today') return [t, t];
  if (q === 'yesterday') { d.setDate(d.getDate() - 1); return [scrapYmd(d), scrapYmd(d)]; }
  if (q === '7') { d.setDate(d.getDate() - 6); return [scrapYmd(d), t]; }
  if (q === 'month') return [t.slice(0, 8) + '01', t];
  return ['', ''];
}
function scrapQuickOf(f) {
  var hit = '';
  ['today', 'yesterday', '7', 'month', 'all'].some(function (q) { var r = scrapQuickRange(q); if (r[0] === f.dateFrom && r[1] === f.dateTo) { hit = q; return true; } return false; });
  return hit;
}
function scrapMarkQuick() {
  var q = scrapQuickOf(SC.filter);
  Array.prototype.forEach.call(document.querySelectorAll('[data-scq]'), function (x) { x.classList.toggle('active', x.getAttribute('data-scq') === q); });
}
function readScrapFilter() {
  var st = document.querySelector('[data-scst].active');
  return { dateFrom: $('scFrom').value, dateTo: $('scTo').value, status: st ? st.getAttribute('data-scst') : '', type: $('scType').value,
           q: $('scQ').value.trim(), includeDeleted: $('scDel').checked };
}

function scrapFindSubmit() {
  var v = $('scFind').value.trim().replace(/^SCRAP[:\s-]*/i, '');
  if (!v) { $('scFind').focus(); return; }
  $('scFind').value = '';
  if (SCRAP_ID_RE.test(v)) { openScrapDetail(v); return; }
  $('scQ').value = v; $('scGo').click();
}

function loadScrap() {
  SC.loading = true; SC.error = ''; renderScrapList();
  api('scrapList', SC.filter).then(function (d) {
    SC.loading = false;
    d.rows.forEach(scrapDecorate);
    SC.data = d;
    if (d.types) { SC.types = d.types; storeJson('pda_scrap_types', d.types); }
    if (d.sources) { SC.sources = d.sources; storeJson('pda_scrap_sources', d.sources.slice(0, 100)); }
    renderScrapList();
  }, function (err) { SC.loading = false; SC.error = err.message; renderScrapList(); });
}

function renderScrapList() {
  var el = $('scOut'); if (!el) return;
  if (SC.loading) { el.innerHTML = '<div class="center muted pad">กำลังโหลด…</div>'; return; }
  if (SC.error) { el.innerHTML = '<div class="msg err">' + esc(SC.error) + '</div>'; return; }
  var d = SC.data; if (!d) { el.innerHTML = ''; return; }
  var types = Object.keys(d.byType).sort(function (a, b) { return d.byType[b].kg - d.byType[a].kg; });
  var maxKg = types.reduce(function (m, k) { return Math.max(m, d.byType[k].kg); }, 0) || 1;
  el.innerHTML =
    '<div class="stats"><div><b>' + d.total + '</b><span>พาเลท</span></div><div><b>' + esc(Number(d.totalKg).toLocaleString('en-US', { maximumFractionDigits: 1 })) + '</b><span>kg รวม</span></div>' +
      '<div><b class="' + (d.noWeight ? 'warn-num' : '') + '">' + d.noWeight + '</b><span>ยังไม่ชั่ง</span></div></div>' +
    (types.length ? '<div class="scrap-types">' + types.map(function (k) {
      var t = d.byType[k];
      return '<div class="st-row"><span class="st-name">' + esc(k) + '</span><span class="st-bar"><i style="width:' + Math.max(2, Math.round(t.kg / maxKg * 100)) + '%"></i></span>' +
        '<span class="st-val">' + esc(scrapFmtKg(t.kg) || '0 kg') + ' · ' + t.n + ' พาเลท</span></div>';
    }).join('') + '</div>' : '') +
    (!d.rows.length ? '<div class="empty-list muted">ไม่พบพาเลท — กด "＋ สร้างพาเลทใหม่"</div>' :
      (d.rows.length < d.total ? '<p class="muted small">แสดง ' + d.rows.length + ' พาเลทล่าสุด</p>' : '') +
      d.rows.map(function (r) {
        var del = r.status === 'deleted';
        return '<div class="row scrap-row st-' + (del ? 'deleted' : r.status === 'open' ? 'pending' : 'saved') + '">' +
          '<div class="row-main" data-scopen="' + esc(r.pallet_id) + '">' +
            '<div class="row-top"><b class="pallet-id">' + esc(r.pallet_id) + '</b>' + scrapStTag(r.status) + '</div>' +
            '<div class="row-sub"><span class="loc-pill">' + esc(r.scrap_type || '-') + '</span>' +
              (r.weight_kg === '' ? '<span class="warn-text small">⚖ ยังไม่ชั่ง</span>' : '<b>' + esc(scrapFmtKg(r.weight_kg)) + '</b>') +
              (r.weight_original !== '' && r.weight_original !== r.weight_kg ? '<span class="muted small">(เดิม ' + esc(scrapFmtKg(r.weight_original)) + ')</span>' : '') +
              (r.source ? '<span class="muted">จาก ' + esc(r.source) + '</span>' : '') + '</div>' +
            '<div class="row-sub muted small"><span>👤 ' + esc(r.created_by) + '</span><span>' + esc(r.created_at) + '</span>' + photoChip(r.pallet_id, r) +
              (r.ship_ref ? '<span>📄 ' + esc(r.ship_ref) + '</span>' : '') + '</div>' +
            (r.note ? '<div class="row-sub small">📝 ' + esc(r.note) + '</div>' : '') +
            (del ? '<div class="row-sub muted small">ลบโดย ' + esc(r.deleted_by) + ' · ' + esc(r.deleted_at) + ' · ' + esc(r.delete_reason) + '</div>' : '') +
          '</div>' +
          (del ? '' : '<div class="row-actions"><button class="btn small" data-cam="' + esc(r.pallet_id) + '" aria-label="ถ่ายรูป">📷</button>' +
            '<button class="btn small" data-scw="' + esc(r.pallet_id) + '">⚖</button></div>') +
        '</div>';
      }).join(''));
  bindPhotoButtons(el, scrapRowOf);
  Array.prototype.forEach.call(el.querySelectorAll('[data-scopen]'), function (b) {
    b.onclick = function (e) { if (e.target.closest('button')) return; openScrapDetail(b.getAttribute('data-scopen')); };
  });
  Array.prototype.forEach.call(el.querySelectorAll('[data-scw]'), function (b) {
    b.onclick = function () { editScrapWeight(scrapRowOf(b.getAttribute('data-scw'))); };
  });
}

// อัปเดตแถวในรายการหลังแก้ (ไม่ต้องโหลดใหม่ทั้งหมด)
function scrapApply(rec) {
  scrapDecorate(rec);
  var old = scrapRowOf(rec.pallet_id);
  if (old) { rec.photos = old.photos; var i = SC.data.rows.indexOf(old); SC.data.rows[i] = rec; }
  return rec;
}

// ---------- สร้างพาเลท ----------
function scrapTypeSeg(cur) {
  return '<div class="seg type-seg">' + scrapTypes().map(function (t) {
    return '<button type="button" data-sctype="' + esc(t) + '" class="' + (t === cur ? 'active' : '') + '">' + esc(t) + '</button>';
  }).join('') + '</div>';
}
function bindTypeSeg() {
  Array.prototype.forEach.call(document.querySelectorAll('[data-sctype]'), function (b) {
    b.onclick = function () { Array.prototype.forEach.call(document.querySelectorAll('[data-sctype]'), function (x) { x.classList.toggle('active', x === b && !x.classList.contains('active')); }); };
  });
}
function readTypeSeg() { var b = document.querySelector('[data-sctype].active'); return b ? b.getAttribute('data-sctype') : ''; }
function sourceList() { return '<datalist id="scSrcList">' + SC.sources.map(function (s) { return '<option value="' + esc(s) + '">'; }).join('') + '</datalist>'; }

function openScrapCreate() {
  if (!S.user) { openUserModal(); return; }
  var last = storeJson('pda_scrap_last') || {};
  openModal('<h3>＋ สร้างพาเลท Scrap</h3>' +
    '<p class="muted small">เลขพาเลทออกให้อัตโนมัติ (วันที่-ลำดับ เช่น ' + esc(scrapIdOf(new Date(), 1)) + ') · ต้องต่ออินเทอร์เน็ต</p>' +
    '<label>ประเภท Scrap</label>' + scrapTypeSeg(last.type || '') +
    '<label>ที่มา (แผนก / ไลน์ผลิต)</label><input id="scSrc" class="field" list="scSrcList" autocomplete="off" value="' + esc(last.source || '') + '">' + sourceList() +
    '<label>น้ำหนัก (kg) <span class="muted small">— ยังไม่ชั่ง เว้นว่างไว้ก่อนได้</span></label>' +
    '<input id="scKg" class="field big" type="number" inputmode="decimal" step="0.01" min="0" placeholder="0.00">' +
    '<label>หมายเหตุ</label><input id="scNote" class="field" autocomplete="off">' +
    '<div class="actions"><button class="btn" id="mCancel">ยกเลิก</button><button class="btn primary" id="mOk">สร้างพาเลท</button></div>');
  bindTypeSeg();
  $('mCancel').onclick = closeModal;
  var clientId = uid(); // กดซ้ำ / เน็ตกระตุก → เซิร์ฟเวอร์ไม่สร้างพาเลทซ้ำ
  $('mOk').onclick = function () {
    var kg = $('scKg').value.trim();
    if (kg !== '' && !(Number(kg) >= 0)) { toast('น้ำหนักไม่ถูกต้อง'); $('scKg').focus(); return; }
    var p = { by: S.user, device: S.device, scrap_type: readTypeSeg(), source: $('scSrc').value.trim(), weight_kg: kg, note: $('scNote').value.trim(), client_id: clientId };
    if (!p.scrap_type) { toast('กรุณาเลือกประเภท Scrap'); return; }
    var btn = $('mOk'); btn.disabled = true; btn.textContent = 'กำลังสร้าง…';
    api('scrapCreate', p).then(function (rec) {
      storeJson('pda_scrap_last', { type: p.scrap_type, source: p.source });
      beep(true);
      scrapDecorate(rec);
      if (S.view === 'scrap') loadScrap(); else SC.data = null;
      openScrapDetail(rec, true);
    }, function (err) { beep(false); btn.disabled = false; btn.textContent = 'สร้างพาเลท'; toast(err.message, 3500); });
  };
}

// ---------- รายละเอียดพาเลท ----------
function openScrapDetail(idOrRow, isNew) {
  if (typeof idOrRow === 'string') {
    var have = scrapRowOf(idOrRow);
    if (have) { openScrapDetail(have, isNew); return; }
    toast('กำลังเปิด ' + idOrRow + '…', 1200);
    api('scrapGet', idOrRow).then(function (r) { openScrapDetail(scrapDecorate(r), isNew); }, function (err) { beep(false); toast(err.message, 3000); });
    return;
  }
  var r = idOrRow, del = r.status === 'deleted', ids = photosFor(r.pallet_id, r);
  function line(k, v) { return '<div class="il"><span class="il-k">' + k + '</span><span class="il-v">' + (v || '<span class="muted">-</span>') + '</span></div>'; }
  openModal((isNew ? '<div class="msg ok">✅ สร้างพาเลทแล้ว — ถ่ายรูปแนบ / พิมพ์ป้ายติดพาเลทได้เลย</div>' : '') +
    '<div class="pallet-head"><div><div class="muted small">เลขพาเลท Scrap</div><div class="pallet-big">' + esc(r.pallet_id) + '</div>' + scrapStTag(r.status) + '</div>' +
      '<div id="scQr" class="pallet-qr"></div></div>' +
    '<div class="card-lite">' +
      line('ประเภท', esc(r.scrap_type)) + line('ที่มา', esc(r.source)) +
      line('น้ำหนัก', r.weight_kg === '' ? '<span class="warn-text">ยังไม่ชั่ง</span>' : '<b>' + esc(scrapFmtKg(r.weight_kg)) + '</b>' +
        (r.weight_original !== '' && r.weight_original !== r.weight_kg ? ' <span class="muted small">(เดิม ' + esc(scrapFmtKg(r.weight_original)) + ')</span>' : '')) +
      line('หมายเหตุ', esc(r.note)) +
      line('สร้าง', esc(r.created_by) + ' · ' + esc(r.created_at) + (r.device ? ' · ' + esc(r.device) : '')) +
      (r.closed_at ? line('ปิดพาเลท', esc(r.closed_by) + ' · ' + esc(r.closed_at)) : '') +
      (r.shipped_at ? line('ส่งออก', esc(r.shipped_by) + ' · ' + esc(r.shipped_at) + (r.ship_ref ? ' · 📄 ' + esc(r.ship_ref) : '')) : '') +
      (del ? line('ลบ', esc(r.deleted_by) + ' · ' + esc(r.deleted_at) + ' · ' + esc(r.delete_reason)) : '') +
    '</div>' +
    (del ? '' :
      '<div class="actions wrap">' +
        '<button class="btn primary" id="sdCam">📷 ถ่ายรูป</button>' +
        '<button class="btn" id="sdPhotos">🖼 รูป (' + ids.length + ')</button>' +
        '<button class="btn" id="sdWeight">⚖ ' + (r.weight_kg === '' ? 'ใส่น้ำหนัก' : 'แก้น้ำหนัก') + '</button>' +
        '<button class="btn" id="sdEdit">✏️ แก้ข้อมูล</button>' +
      '</div>' +
      '<div class="actions wrap">' +
        (r.status === 'open' ? '<button class="btn warn" id="sdClose">🔒 ปิดพาเลท</button>' : '') +
        (r.status === 'closed' ? '<button class="btn warn" id="sdShip">🚚 ส่งขาย / ส่งออก</button>' : '') +
        (r.status !== 'open' ? '<button class="btn" id="sdReopen">🔓 เปิดใหม่</button>' : '') +
      '</div>') +
    '<div class="actions wrap">' +
      '<button class="btn" id="sdLabel">🏷 ป้ายพาเลท (PDF)</button>' +
      '<button class="btn" id="sdPdf">📄 ใบพาเลท (PDF)</button>' +
      '<button class="btn" id="sdTl">🕘 ประวัติ</button>' +
      (del ? '' : '<button class="btn danger" id="sdDel">ลบ</button>') +
    '</div>' +
    '<div class="actions"><button class="btn" id="mCancel">ปิด</button></div>');
  $('mCancel').onclick = closeModal;
  scrapQrInto($('scQr'), r.pallet_id, 4);
  $('sdLabel').onclick = function () { scrapLabelPdf(r, this); };
  $('sdPdf').onclick = function () { scrapPalletPdf(r, this); };
  $('sdTl').onclick = function () { openScrapTimeline(r); };
  if (del) return;
  $('sdCam').onclick = function () { closeModal(); pickPhoto(r.pallet_id, true, r); };
  $('sdPhotos').onclick = function () { openPhotos(r.pallet_id, r); };
  $('sdWeight').onclick = function () { editScrapWeight(r); };
  $('sdEdit').onclick = function () { editScrapInfo(r); };
  $('sdDel').onclick = function () { deleteScrapUi(r); };
  if ($('sdClose')) $('sdClose').onclick = function () {
    if (r.weight_kg === '') { toast('ต้องใส่น้ำหนักก่อนปิดพาเลท'); editScrapWeight(r, 'closed'); return; }
    scrapSetStatusUi(r, 'closed');
  };
  if ($('sdShip')) $('sdShip').onclick = function () { openScrapShip(r); };
  if ($('sdReopen')) $('sdReopen').onclick = function () {
    confirmModal('เปิดพาเลท ' + esc(r.pallet_id) + ' ใหม่?', 'สถานะจะกลับเป็น "เปิดอยู่" (ข้อมูลการปิด/ส่งออกจะถูกล้าง แต่ยังอยู่ในประวัติ)', 'เปิดใหม่', function () { scrapSetStatusUi(r, 'open'); });
  };
}

function scrapQrInto(el, text, cell) {
  if (!el) return;
  loadScriptOnce(QRGEN_URL).then(function () {
    var qr = window.qrcode(0, 'M'); qr.addData(text); qr.make();
    el.innerHTML = qr.createSvgTag({ cellSize: cell || 4, margin: 1, scalable: true });
  }, function () { el.innerHTML = ''; });
}
function scrapQrDataUrl(text) {
  return loadScriptOnce(QRGEN_URL).then(function () {
    var qr = window.qrcode(0, 'M'); qr.addData(text); qr.make();
    return qr.createDataURL(10, 2);
  }, function () { return ''; });
}

function editScrapWeight(r, thenStatus) {
  if (!r) return;
  if (!S.user) { openUserModal(); return; }
  var has = r.weight_kg !== '';
  openModal('<h3>⚖ น้ำหนักพาเลท ' + esc(r.pallet_id) + '</h3>' +
    (has ? '<p class="muted small">ปัจจุบัน ' + esc(scrapFmtKg(r.weight_kg)) + ' — การแก้จะเก็บน้ำหนักเดิมไว้ในประวัติ</p>' : '') +
    '<input id="swKg" class="field big" type="number" inputmode="decimal" step="0.01" min="0" placeholder="0.00" value="' + esc(has ? r.weight_kg : '') + '">' +
    (has ? '<label>เหตุผล</label>' + SCRAP_WEIGHT_REASONS.map(function (x, i) {
      return '<label class="radio"><input type="radio" name="swWhy" value="' + esc(x) + '"' + (i === 0 ? ' checked' : '') + '> ' + esc(x) + '</label>';
    }).join('') + '<input id="swNote" class="field" placeholder="รายละเอียด (ถ้ามี)">' : '') +
    '<div class="actions"><button class="btn" id="mCancel">ยกเลิก</button><button class="btn primary" id="mOk">' + (thenStatus === 'closed' ? 'บันทึก + ปิดพาเลท' : 'บันทึก') + '</button></div>');
  var inp = $('swKg'); setTimeout(function () { inp.focus(); inp.select(); }, 50);
  inp.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); $('mOk').click(); } });
  $('mCancel').onclick = function () { openScrapDetail(r); };
  $('mOk').onclick = function () {
    var v = inp.value.trim();
    if (v === '' || !(Number(v) >= 0)) { toast('กรุณาใส่น้ำหนัก (kg)'); inp.focus(); return; }
    var why = '';
    if (has) {
      var c = document.querySelector('input[name="swWhy"]:checked');
      why = [c ? c.value : '', $('swNote').value.trim()].filter(String).join(': ');
    }
    var btn = $('mOk'); btn.disabled = true;
    api('scrapUpdate', r.pallet_id, { weight_kg: v }, S.user, why).then(function (rec) {
      rec = scrapApply(rec); rec.photos = r.photos;
      if (thenStatus) { scrapSetStatusUi(rec, thenStatus); return; }
      toast('บันทึกน้ำหนัก ' + scrapFmtKg(rec.weight_kg));
      renderScrapList(); openScrapDetail(rec);
    }, function (err) { btn.disabled = false; toast(err.message, 3500); });
  };
}

function editScrapInfo(r) {
  if (!S.user) { openUserModal(); return; }
  openModal('<h3>✏️ แก้ข้อมูลพาเลท ' + esc(r.pallet_id) + '</h3>' +
    '<label>ประเภท Scrap</label>' + scrapTypeSeg(r.scrap_type) +
    '<label>ที่มา</label><input id="scSrc" class="field" list="scSrcList" autocomplete="off" value="' + esc(r.source) + '">' + sourceList() +
    '<label>หมายเหตุ</label><input id="scNote" class="field" autocomplete="off" value="' + esc(r.note) + '">' +
    '<div class="actions"><button class="btn" id="mCancel">ยกเลิก</button><button class="btn primary" id="mOk">บันทึก</button></div>');
  bindTypeSeg();
  $('mCancel').onclick = function () { openScrapDetail(r); };
  $('mOk').onclick = function () {
    var t = readTypeSeg();
    if (!t) { toast('กรุณาเลือกประเภท Scrap'); return; }
    var btn = $('mOk'); btn.disabled = true;
    api('scrapUpdate', r.pallet_id, { scrap_type: t, source: $('scSrc').value.trim(), note: $('scNote').value.trim() }, S.user, '').then(function (rec) {
      rec = scrapApply(rec); rec.photos = r.photos;
      toast('บันทึกแล้ว'); renderScrapList(); openScrapDetail(rec);
    }, function (err) { btn.disabled = false; toast(err.message, 3500); });
  };
}

function scrapSetStatusUi(r, status, opt) {
  if (!S.user) { openUserModal(); return; }
  api('scrapSetStatus', r.pallet_id, status, S.user, opt || {}).then(function (rec) {
    rec = scrapApply(rec); rec.photos = r.photos;
    beep(true);
    toast(status === 'closed' ? '🔒 ปิดพาเลท ' + rec.pallet_id + ' แล้ว' : status === 'shipped' ? '🚚 บันทึกส่งออกแล้ว' : 'เปิดพาเลทใหม่แล้ว', 2500);
    renderScrapList(); openScrapDetail(rec);
  }, function (err) { beep(false); toast(err.message, 3500); });
}

function openScrapShip(r) {
  openModal('<h3>🚚 ส่งขาย / ส่งออก ' + esc(r.pallet_id) + '</h3>' +
    '<p class="muted small">' + esc(r.scrap_type) + ' · ' + esc(scrapFmtKg(r.weight_kg)) + '</p>' +
    '<label>เลขที่เอกสาร / ผู้รับซื้อ (ถ้ามี)</label><input id="shRef" class="field" autocomplete="off" placeholder="เช่น INV-0001 / ร้าน ก.">' +
    '<div class="actions"><button class="btn" id="mCancel">ยกเลิก</button><button class="btn primary" id="mOk">ยืนยันส่งออก</button></div>');
  $('mCancel').onclick = function () { openScrapDetail(r); };
  $('mOk').onclick = function () { this.disabled = true; scrapSetStatusUi(r, 'shipped', { ship_ref: $('shRef').value.trim() }); };
}

function deleteScrapUi(r) {
  if (!S.user) { openUserModal(); return; }
  openModal('<h3>ลบพาเลท ' + esc(r.pallet_id) + '?</h3>' +
    '<p class="muted small">ข้อมูลยังเก็บในชีต (สถานะ ลบแล้ว) และเลขพาเลทนี้จะไม่ถูกนำกลับมาใช้</p>' +
    SCRAP_DELETE_REASONS.map(function (x, i) { return '<label class="radio"><input type="radio" name="sdWhy" value="' + esc(x) + '"' + (i === 0 ? ' checked' : '') + '> ' + esc(x) + '</label>'; }).join('') +
    '<input id="sdNote" class="field" placeholder="รายละเอียด (ถ้ามี)">' +
    '<div class="actions"><button class="btn" id="mCancel">ยกเลิก</button><button class="btn danger" id="mOk">ลบ</button></div>');
  $('mCancel').onclick = function () { openScrapDetail(r); };
  $('mOk').onclick = function () {
    var c = document.querySelector('input[name="sdWhy"]:checked');
    var why = [c ? c.value : '', $('sdNote').value.trim()].filter(String).join(': ');
    this.disabled = true;
    api('scrapDelete', r.pallet_id, S.user, why).then(function () { closeModal(); toast('ลบพาเลทแล้ว'); loadScrap(); },
      function (err) { toast(err.message, 3500); $('mOk').disabled = false; });
  };
}

var SCRAP_EV = { create: '🟢 สร้างพาเลท', weight: '⚖ น้ำหนัก', edit: '✏️ แก้ข้อมูล', status: '🔵 สถานะ', delete: '🔴 ลบ', photo_add: '🖼 แนบรูป', photo_delete: '🗑 ลบรูป' };
function openScrapTimeline(r) {
  openModal('<h3>🕘 ประวัติพาเลท ' + esc(r.pallet_id) + '</h3><div id="stlOut" class="center muted pad">กำลังโหลด…</div>' +
    '<div class="actions"><button class="btn" id="mBack">กลับ</button></div>');
  $('mBack').onclick = function () { openScrapDetail(r); };
  api('scrapTimeline', r.pallet_id).then(function (d) {
    var el = $('stlOut'); if (!el) return;
    el.className = '';
    var ICON = { create: '🟢', weight: '⚖', edit: '✏️', status: '🔵', delete: '🔴', photo_add: '🖼', photo_delete: '🗑' };
    el.innerHTML = d.events.length ? '<ul class="timeline">' + d.events.map(function (e) {
      var st = function (s) { return (SCRAP_ST[s] || [s])[0]; };
      var det = e.event === 'status' ? st(e.from) + ' → ' + st(e.to) : e.from || e.to ? (e.field ? e.field + ': ' : '') + (e.from || '-') + ' → ' + (e.to || '-') : '';
      return '<li class="tl-item"><span class="tl-dot">' + (ICON[e.event] || '•') + '</span><div class="tl-body"><div class="tl-top"><b>' +
        esc((SCRAP_EV[e.event] || e.event).replace(/^\S+\s/, '')) + '</b><span class="muted small">' + fmtWhen(e.at) + '</span></div>' +
        (det ? '<div>' + esc(det) + '</div>' : '') +
        '<div class="muted small">👤 ' + esc(e.by) + (e.note ? ' · ' + esc(e.note) : '') + '</div></div></li>';
    }).join('') + '</ul>' : '<div class="empty-list muted">ยังไม่มีประวัติ</div>';
  }, function (err) { var el = $('stlOut'); if (el) el.innerHTML = '<div class="msg err">' + esc(err.message) + '</div>'; });
}

// ---------- Export Excel ----------
function exportScrapExcel() {
  var f = readScrapFilter(), btn = $('scXlsx');
  btn.disabled = true; btn.textContent = 'กำลังเตรียม…';
  function done() { btn.disabled = false; btn.textContent = '⬇️ Excel'; }
  Promise.all([loadScriptOnce(XLSX_URL), api('scrapList', Object.assign({}, f, { limit: 20000, export: true }))]).then(function (res) {
    var d = res[1];
    if (!d.rows.length) { done(); toast('ไม่มีข้อมูลตามตัวกรอง'); return; }
    var rows = d.rows.slice().reverse().map(function (r) {
      return { 'เลขพาเลท': r.pallet_id, 'วันที่พาเลท': scrapDay(r.pallet_date), 'ลำดับ': r.seq, 'ประเภท': r.scrap_type, 'ที่มา': r.source,
        'น้ำหนัก (kg)': r.weight_kg, 'น้ำหนักเดิม (kg)': r.weight_original !== r.weight_kg ? r.weight_original : '', 'สถานะ': (SCRAP_ST[r.status] || [r.status])[0],
        'หมายเหตุ': r.note, 'ผู้สร้าง': r.created_by, 'สร้างเมื่อ': r.created_at, 'เครื่อง': r.device,
        'ปิดโดย': r.closed_by, 'ปิดเมื่อ': r.closed_at, 'ส่งออกโดย': r.shipped_by, 'ส่งออกเมื่อ': r.shipped_at, 'เอกสาร/ผู้รับซื้อ': r.ship_ref,
        'แก้ไขล่าสุดโดย': r.updated_by, 'แก้ไขล่าสุดเมื่อ': r.updated_at, 'ลบโดย': r.deleted_by, 'ลบเมื่อ': r.deleted_at, 'เหตุผลลบ': r.delete_reason,
        'จำนวนรูป': (r.photos || []).length, 'ลิงก์รูป (Google Drive)': (r.photo_urls || []).join(' \n') };
    });
    var wb = XLSX.utils.book_new();
    var ws = XLSX.utils.json_to_sheet(rows);
    ws['!cols'] = [13, 11, 6, 16, 18, 11, 11, 11, 24, 14, 19, 10, 14, 19, 14, 19, 18, 14, 19, 12, 19, 16, 8, 60].map(function (w) { return { wch: w }; });
    ws['!autofilter'] = { ref: ws['!ref'] };
    XLSX.utils.book_append_sheet(wb, ws, 'พาเลท');

    var live = d.rows.filter(function (r) { return r.status !== 'deleted'; });
    var byType = {}, byDay = {};
    live.forEach(function (r) {
      var t = byType[r.scrap_type || '-'] || (byType[r.scrap_type || '-'] = { n: 0, kg: 0, nw: 0, open: 0, closed: 0, shipped: 0 });
      t.n++; t[r.status] = (t[r.status] || 0) + 1;
      if (r.weight_kg === '') t.nw++; else t.kg += r.weight_kg;
      var k = r.pallet_date + '|' + (r.scrap_type || '-');
      var dd = byDay[k] || (byDay[k] = { day: r.pallet_date, type: r.scrap_type || '-', n: 0, kg: 0 });
      dd.n++; if (r.weight_kg !== '') dd.kg += r.weight_kg;
    });
    var r3 = function (x) { return Math.round(x * 1000) / 1000; };
    var trows = Object.keys(byType).sort().map(function (k) {
      var t = byType[k];
      return { 'ประเภท': k, 'จำนวนพาเลท': t.n, 'น้ำหนักรวม (kg)': r3(t.kg), 'ยังไม่ชั่ง': t.nw, 'เปิดอยู่': t.open || 0, 'ปิดแล้ว': t.closed || 0, 'ส่งออกแล้ว': t.shipped || 0 };
    });
    trows.push({ 'ประเภท': 'รวม', 'จำนวนพาเลท': live.length, 'น้ำหนักรวม (kg)': r3(live.reduce(function (s, r) { return s + (r.weight_kg || 0); }, 0)),
      'ยังไม่ชั่ง': live.filter(function (r) { return r.weight_kg === ''; }).length });
    var ws2 = XLSX.utils.json_to_sheet(trows);
    ws2['!cols'] = [18, 12, 15, 10, 9, 9, 11].map(function (w) { return { wch: w }; });
    XLSX.utils.book_append_sheet(wb, ws2, 'สรุปตามประเภท');
    var drows = Object.keys(byDay).sort().map(function (k) { var x = byDay[k]; return { 'วันที่': scrapDay(x.day), 'ประเภท': x.type, 'จำนวนพาเลท': x.n, 'น้ำหนักรวม (kg)': r3(x.kg) }; });
    var ws3 = XLSX.utils.json_to_sheet(drows.length ? drows : [{ 'วันที่': '(ไม่มีข้อมูล)' }]);
    ws3['!cols'] = [12, 18, 12, 15].map(function (w) { return { wch: w }; });
    XLSX.utils.book_append_sheet(wb, ws3, 'สรุปรายวัน');
    XLSX.writeFile(wb, 'Scrap_' + scrapRangeName(f) + '_' + scrapStamp() + '.xlsx');
    done();
    toast('ดาวน์โหลด ' + d.rows.length + ' พาเลท', 3000);
  }, function (err) { done(); toast(err.message === 'load failed' ? 'โหลดตัวสร้าง Excel ไม่ได้ (ต้องต่ออินเทอร์เน็ต)' : err.message, 3500); });
}
function scrapRangeName(f) {
  return f.dateFrom || f.dateTo ? (f.dateFrom || '…').replace(/-/g, '') + (f.dateTo && f.dateTo !== f.dateFrom ? '-' + f.dateTo.replace(/-/g, '') : '') : 'ทั้งหมด';
}
function scrapStamp() { var n = new Date(); return n.getFullYear() + pad(n.getMonth() + 1) + pad(n.getDate()) + '-' + pad(n.getHours()) + pad(n.getMinutes()); }
function scrapRangeText(f) {
  if (!f.dateFrom && !f.dateTo) return 'ทุกวันที่';
  return f.dateFrom === f.dateTo ? 'วันที่ ' + scrapDay(f.dateFrom) : scrapDay(f.dateFrom || '…') + ' – ' + scrapDay(f.dateTo || '…');
}

// ---------- PDF ----------
// สร้างหน้า HTML (ฟอนต์ Sarabun) แล้วแปลงเป็น PDF ด้วย html2pdf ทีละหน้า (ภาพแต่ละหน้าเล็ก ใช้ได้บน PDA/มือถือ)
// โหลดตัวสร้าง PDF ไม่ได้ → เปิดหน้าพิมพ์ของเบราว์เซอร์แทน (เลือก "บันทึกเป็น PDF")
var PDF_CSS = '.pdfp{width:718px;height:1010px;overflow:hidden;padding:0;box-sizing:border-box;font-family:Sarabun,sans-serif;color:#111;font-size:12px;background:#fff;position:relative}' +
  '.pdfp h1{font-size:20px;margin:0 0 2px}.pdfp h2{font-size:15px;margin:14px 0 6px}.pdfp .mut{color:#666}' +
  '.pdfp table{width:100%;border-collapse:collapse;margin-top:6px}.pdfp th,.pdfp td{border:1px solid #bbb;padding:3px 5px;text-align:left;vertical-align:top}' +
  '.pdfp th{background:#eef2f8}.pdfp td.n,.pdfp th.n{text-align:right}.pdfp tr.tot td{font-weight:700;background:#f6f6f6}' +
  '.pdfp .kpi{display:flex;gap:10px;margin:10px 0}.pdfp .kpi div{flex:1;border:1px solid #ccd;border-radius:6px;padding:6px 8px}.pdfp .kpi b{display:block;font-size:20px;color:#1f5fbf}' +
  '.pdfp .ph{display:grid;grid-template-columns:repeat(3,1fr);gap:6px;margin-top:6px}.pdfp .ph img{width:100%;height:170px;object-fit:cover;border:1px solid #ccc;border-radius:4px}' +
  '.pdfp .ph.big{grid-template-columns:repeat(2,1fr)}.pdfp .ph.big img{height:260px}' +
  '.pdfp .blk{border:1px solid #ccc;border-radius:6px;padding:8px;margin-bottom:10px}' +
  '.pdfp .sig{display:flex;gap:20px;margin-top:40px}.pdfp .sig div{flex:1;text-align:center;border-top:1px dotted #333;padding-top:4px}' +
  '.pdfp .foot{position:absolute;bottom:0;left:0;right:0;font-size:10px;color:#888;display:flex;justify-content:space-between}' +
  '.pdfp .hd{display:flex;justify-content:space-between;align-items:flex-start;border-bottom:2px solid #1f5fbf;padding-bottom:6px}' +
  '.pdfl{width:516px;height:352px;box-sizing:border-box;font-family:Sarabun,sans-serif;color:#000;background:#fff;border:3px solid #000;border-radius:10px;padding:14px 18px;display:flex;gap:14px}' +
  '.pdfl .l{flex:1;display:flex;flex-direction:column}.pdfl .t{font-size:18px;font-weight:700;letter-spacing:2px}.pdfl .id{font-size:46px;font-weight:700;line-height:1.1;margin:6px 0}' +
  '.pdfl .f{font-size:17px;margin:3px 0}.pdfl .f b{font-size:20px}.pdfl img{width:200px;height:200px}.pdfl .w{margin-top:auto;font-size:18px;border-top:2px solid #000;padding-top:6px}';

function scrapPdfPages(pages, filename, opt, btn) {
  opt = opt || {};
  var label = btn ? btn.textContent : '';
  if (btn) { btn.disabled = true; btn.textContent = 'กำลังสร้าง PDF…'; }
  function done() { if (btn) { btn.disabled = false; btn.textContent = label; } }
  var fonts = document.fonts && document.fonts.load ? Promise.all([document.fonts.load('400 12px Sarabun'), document.fonts.load('700 12px Sarabun')]).catch(function () {}) : Promise.resolve();
  return Promise.all([loadScriptOnce(H2P_URL), fonts]).then(function () {
    var host = document.createElement('div');
    host.style.cssText = 'position:fixed;left:-10000px;top:0;';
    host.innerHTML = '<style>' + PDF_CSS + '</style>' + pages.join('');
    document.body.appendChild(host);
    var els = Array.prototype.slice.call(host.children, 1);
    var o = { margin: opt.margin == null ? 10 : opt.margin, filename: filename, image: { type: 'jpeg', quality: 0.9 },
              html2canvas: { scale: opt.scale || 2, useCORS: true, backgroundColor: '#ffffff', logging: false, scrollX: 0, scrollY: 0 },
              jsPDF: { unit: 'mm', format: opt.format || 'a4', orientation: opt.orientation || 'portrait' } };
    var w = window.html2pdf().set(o).from(els[0]).toPdf();
    els.slice(1).forEach(function (el) {
      w = w.get('pdf').then(function (pdf) { pdf.addPage(); }).from(el).toContainer().toCanvas().toPdf();
    });
    return w.save().then(function () { document.body.removeChild(host); done(); toast('ดาวน์โหลด ' + filename, 3000); },
      function (err) { if (host.parentNode) document.body.removeChild(host); throw err; });
  }).catch(function (err) {
    done();
    if (err && err.message === 'load failed') { scrapPrintFallback(pages, filename, opt); return; }
    toast('สร้าง PDF ไม่สำเร็จ: ' + (err && err.message || err), 4000);
  });
}

function scrapPrintFallback(pages, title, opt) {
  var w = window.open('', '_blank');
  if (!w) { toast('โหลดตัวสร้าง PDF ไม่ได้ (ต้องต่ออินเทอร์เน็ต)', 3500); return; }
  w.document.write('<!DOCTYPE html><html lang="th"><head><meta charset="utf-8"><title>' + esc(title) + '</title>' +
    '<link href="https://fonts.googleapis.com/css2?family=Sarabun:wght@400;700&display=swap" rel="stylesheet">' +
    '<style>@page{size:' + (opt.format === 'a6' ? 'A6 landscape' : 'A4') + ';margin:10mm}body{margin:0}.pdfp,.pdfl{page-break-after:always}' + PDF_CSS + '</style></head><body>' +
    pages.join('') + '<script>window.onload=function(){setTimeout(function(){window.print()},600)}<\/script></body></html>');
  w.document.close();
  toast('เลือก "บันทึกเป็น PDF" ในหน้าพิมพ์', 3500);
}

function scrapFoot(page, total) {
  return '<div class="foot"><span>PDA Scan · Scrap · พิมพ์โดย ' + esc(S.user) + ' · ' + esc(scrapNowText()) + '</span><span>หน้า ' + page + '/' + total + '</span></div>';
}
function scrapNowText() { var n = new Date(); return pad(n.getDate()) + '/' + pad(n.getMonth() + 1) + '/' + n.getFullYear() + ' ' + pad(n.getHours()) + ':' + pad(n.getMinutes()); }
function scrapInfoTable(r) {
  function tr(k, v) { return '<tr><th style="width:120px">' + k + '</th><td>' + (v || '-') + '</td></tr>'; }
  return '<table>' + tr('ประเภท', esc(r.scrap_type)) + tr('ที่มา', esc(r.source)) +
    tr('น้ำหนัก', r.weight_kg === '' ? 'ยังไม่ชั่ง' : '<b style="font-size:15px">' + esc(scrapFmtKg(r.weight_kg)) + '</b>' + (r.weight_original !== '' && r.weight_original !== r.weight_kg ? ' (เดิม ' + esc(scrapFmtKg(r.weight_original)) + ')' : '')) +
    tr('สถานะ', esc((SCRAP_ST[r.status] || [r.status])[0])) + tr('หมายเหตุ', esc(r.note)) +
    tr('สร้าง', esc(r.created_by) + ' · ' + esc(r.created_at)) +
    (r.closed_at ? tr('ปิดพาเลท', esc(r.closed_by) + ' · ' + esc(r.closed_at)) : '') +
    (r.shipped_at ? tr('ส่งออก', esc(r.shipped_by) + ' · ' + esc(r.shipped_at) + (r.ship_ref ? ' · ' + esc(r.ship_ref) : '')) : '') + '</table>';
}

// โหลดรูปเป็น data URL (ทีละ 3 รูปพร้อมกัน)
function scrapLoadPhotos(ids, onProgress) {
  var out = {}, i = 0, n = 0;
  function next() {
    if (i >= ids.length) return Promise.resolve();
    var id = ids[i++];
    return loadPhoto(id).then(function (d) { out[id] = d; }, function () {}).then(function () { n++; if (onProgress) onProgress(n, ids.length); return next(); });
  }
  return Promise.all([next(), next(), next()]).then(function () { return out; });
}

function scrapLabelPdf(r, btn) {
  scrapQrDataUrl(r.pallet_id).then(function (qr) {
    var page = '<div class="pdfl"><div class="l"><div class="t">SCRAP PALLET</div><div class="id">' + esc(r.pallet_id) + '</div>' +
      '<div class="f">ประเภท: <b>' + esc(r.scrap_type || '-') + '</b></div>' +
      (r.source ? '<div class="f">ที่มา: ' + esc(r.source) + '</div>' : '') +
      '<div class="f">วันที่: ' + esc(scrapDay(r.pallet_date)) + ' · ' + esc(r.created_by) + '</div>' +
      '<div class="w">น้ำหนัก: ' + (r.weight_kg === '' ? '______________ kg' : '<b>' + esc(scrapFmtKg(r.weight_kg)) + '</b>') + '</div></div>' +
      (qr ? '<div><img src="' + qr + '" alt=""></div>' : '') + '</div>';
    scrapPdfPages([page], 'Label_' + r.pallet_id + '.pdf', { format: 'a6', orientation: 'landscape', margin: 5, scale: 3 }, btn);
  });
}

function scrapPalletPdf(r, btn) {
  var ids = photosFor(r.pallet_id, r), label = btn ? btn.textContent : '';
  Promise.all([scrapQrDataUrl(r.pallet_id), scrapLoadPhotos(ids, function (n, t) { if (btn) btn.textContent = 'โหลดรูป ' + n + '/' + t; })]).then(function (res) {
    if (btn) btn.textContent = label;
    var qr = res[0], ph = res[1], imgs = ids.filter(function (id) { return ph[id]; });
    var per = 6, pageCount = 1 + Math.max(0, Math.ceil((imgs.length - 2) / per));
    var pages = ['<div class="pdfp"><div class="hd"><div><div class="mut">ใบพาเลท Scrap</div><h1 style="font-size:30px">' + esc(r.pallet_id) + '</h1></div>' +
      (qr ? '<img src="' + qr + '" style="width:110px;height:110px" alt="">' : '') + '</div>' +
      scrapInfoTable(r) +
      (imgs.length ? '<h2>รูปถ่าย (' + imgs.length + ' รูป)</h2><div class="ph big">' + imgs.slice(0, 2).map(function (id) { return '<img src="' + ph[id] + '">'; }).join('') + '</div>' : '') +
      '<div class="sig"><div>ผู้ชั่ง / ผู้บันทึก</div><div>ผู้ตรวจสอบ</div><div>ผู้รับซื้อ / ผู้รับของ</div></div>' + scrapFoot(1, pageCount) + '</div>'];
    for (var i = 2, pg = 2; i < imgs.length; i += per, pg++) {
      pages.push('<div class="pdfp"><h2>' + esc(r.pallet_id) + ' — รูปถ่าย (ต่อ)</h2><div class="ph big">' +
        imgs.slice(i, i + per).map(function (id) { return '<img src="' + ph[id] + '">'; }).join('') + '</div>' + scrapFoot(pg, pageCount) + '</div>');
    }
    scrapPdfPages(pages, 'Scrap_' + r.pallet_id + '.pdf', {}, btn);
  }, function (err) { if (btn) btn.textContent = label; toast(err.message, 3500); });
}

function openScrapPdfMenu() {
  openModal('<h3>⬇️ Export PDF (ตามตัวกรอง)</h3>' +
    '<label class="radio"><input type="radio" name="spMode" value="sum" checked> รายงานสรุป + ตารางพาเลท</label>' +
    '<label class="radio"><input type="radio" name="spMode" value="photo"> รายงาน + รูปถ่ายของแต่ละพาเลท <span class="muted small">(ช้ากว่า ใช้เน็ต)</span></label>' +
    '<p class="muted small">ไม่รวมพาเลทที่ลบแล้ว · ไฟล์สร้างในเครื่อง ใช้ได้ทั้ง PDA คอมฯ และโทรศัพท์</p>' +
    '<div class="actions"><button class="btn" id="mCancel">ยกเลิก</button><button class="btn primary" id="mOk">สร้าง PDF</button></div>');
  $('mCancel').onclick = closeModal;
  $('mOk').onclick = function () {
    var withPhotos = document.querySelector('input[name="spMode"]:checked').value === 'photo';
    exportScrapPdf(withPhotos, this);
  };
}

function exportScrapPdf(withPhotos, btn) {
  var f = readScrapFilter(), label = btn.textContent;
  btn.disabled = true; btn.textContent = 'กำลังโหลดข้อมูล…';
  api('scrapList', Object.assign({}, f, { includeDeleted: false, limit: 5000, export: true })).then(function (d) {
    var rows = d.rows.slice().reverse();
    if (!rows.length) { btn.disabled = false; btn.textContent = label; toast('ไม่มีข้อมูลตามตัวกรอง'); return; }
    var ids = [];
    if (withPhotos) rows.forEach(function (r) { (r.photos || []).slice(0, 6).forEach(function (id) { ids.push(id); }); });
    return scrapLoadPhotos(ids, function (n, t) { btn.textContent = 'โหลดรูป ' + n + '/' + t; }).then(function (ph) {
      btn.disabled = false; btn.textContent = label;
      closeModal();
      scrapPdfPages(scrapReportPages(f, d, rows, withPhotos ? ph : null), 'Scrap_' + scrapRangeName(f) + '_' + scrapStamp() + '.pdf', {}, $('scPdf'));
    });
  }).catch(function (err) { btn.disabled = false; btn.textContent = label; toast(err.message, 3500); });
}

function scrapReportPages(f, d, rows, ph) {
  var types = Object.keys(d.byType).sort(function (a, b) { return d.byType[b].kg - d.byType[a].kg; });
  var filt = [scrapRangeText(f), f.status ? 'สถานะ: ' + SCRAP_ST[f.status][0] : '', f.type ? 'ประเภท: ' + f.type : '', f.q ? 'ค้นหา: ' + f.q : ''].filter(String).join(' · ');
  var head = '<div class="hd"><div><h1>รายงาน Scrap</h1><div class="mut">' + esc(filt) + '</div></div><div class="mut" style="text-align:right">พิมพ์ ' + esc(scrapNowText()) + '<br>โดย ' + esc(S.user) + '</div></div>';
  var summary = '<div class="kpi"><div>จำนวนพาเลท<b>' + d.total + '</b></div><div>น้ำหนักรวม<b>' + esc(scrapFmtKg(d.totalKg) || '0 kg') + '</b></div>' +
      '<div>ยังไม่ชั่ง<b>' + d.noWeight + '</b></div><div>เปิด / ปิด / ส่งออก<b>' + (d.byStatus.open || 0) + ' / ' + (d.byStatus.closed || 0) + ' / ' + (d.byStatus.shipped || 0) + '</b></div></div>' +
    '<h2>สรุปตามประเภท</h2><table><tr><th>ประเภท</th><th class="n">พาเลท</th><th class="n">น้ำหนัก (kg)</th><th class="n">สัดส่วน</th></tr>' +
      types.map(function (k) { var t = d.byType[k]; return '<tr><td>' + esc(k) + '</td><td class="n">' + t.n + '</td><td class="n">' + esc(Number(t.kg).toLocaleString('en-US', { maximumFractionDigits: 3 })) + '</td><td class="n">' + (d.totalKg ? Math.round(t.kg / d.totalKg * 1000) / 10 : 0) + '%</td></tr>'; }).join('') +
      '<tr class="tot"><td>รวม</td><td class="n">' + d.total + '</td><td class="n">' + esc(Number(d.totalKg).toLocaleString('en-US', { maximumFractionDigits: 3 })) + '</td><td class="n">100%</td></tr></table>';
  var th = '<tr><th>#</th><th>เลขพาเลท</th><th>ประเภท</th><th>ที่มา</th><th class="n">น้ำหนัก (kg)</th><th>สถานะ</th><th>ผู้สร้าง / เวลา</th><th class="n">รูป</th><th>หมายเหตุ</th></tr>';
  function tr(r, i) {
    return '<tr><td>' + (i + 1) + '</td><td><b>' + esc(r.pallet_id) + '</b></td><td>' + esc(r.scrap_type) + '</td><td>' + esc(r.source) + '</td>' +
      '<td class="n">' + (r.weight_kg === '' ? '<i>ยังไม่ชั่ง</i>' : esc(Number(r.weight_kg).toLocaleString('en-US', { maximumFractionDigits: 3 }))) + '</td>' +
      '<td>' + esc((SCRAP_ST[r.status] || [r.status])[0]) + (r.ship_ref ? '<br>' + esc(r.ship_ref) : '') + '</td><td>' + esc(r.created_by) + '<br><span class="mut">' + esc(r.created_at.slice(0, 16)) + '</span></td>' +
      '<td class="n">' + (r.photos || []).length + '</td><td>' + esc(r.note) + '</td></tr>';
  }
  // แบ่งหน้า: หน้าแรกมีสรุป → ตารางน้อยแถวกว่า
  var chunks = [], first = Math.max(6, 20 - types.length), per = 26;
  chunks.push(rows.slice(0, first));
  for (var i = first; i < rows.length; i += per) chunks.push(rows.slice(i, i + per));
  var photoPages = [];
  if (ph) {
    var withPh = rows.filter(function (r) { return (r.photos || []).some(function (id) { return ph[id]; }); });
    for (var j = 0; j < withPh.length; j += 2) photoPages.push(withPh.slice(j, j + 2));
  }
  var total = chunks.length + photoPages.length + 1, pages = [], idx = 0;
  chunks.forEach(function (c, ci) {
    pages.push('<div class="pdfp">' + (ci === 0 ? head + summary + '<h2>รายการพาเลท (' + rows.length + ')</h2>' : '<h2>รายการพาเลท (ต่อ)</h2>') +
      '<table>' + th + c.map(function (r) { return tr(r, idx++); }).join('') + '</table>' + scrapFoot(pages.length + 1, total) + '</div>');
  });
  pages.push('<div class="pdfp"><h2>สรุปน้ำหนักรวม</h2>' + summary.split('<h2>')[0] +
    '<p>รวมทั้งสิ้น <b>' + d.total + '</b> พาเลท น้ำหนักรวม <b>' + esc(scrapFmtKg(d.totalKg) || '0 kg') + '</b>' + (d.noWeight ? ' (ยังไม่ชั่ง ' + d.noWeight + ' พาเลท)' : '') + '</p>' +
    '<div class="sig"><div>ผู้จัดทำ</div><div>ผู้ตรวจสอบ</div><div>ผู้อนุมัติ</div></div>' + scrapFoot(pages.length + 1, total) + '</div>');
  photoPages.forEach(function (grp) {
    pages.push('<div class="pdfp"><h2>รูปถ่ายพาเลท</h2>' + grp.map(function (r) {
      var imgs = (r.photos || []).filter(function (id) { return ph[id]; }).slice(0, 6);
      return '<div class="blk"><b style="font-size:15px">' + esc(r.pallet_id) + '</b> · ' + esc(r.scrap_type) + ' · ' + esc(scrapFmtKg(r.weight_kg) || 'ยังไม่ชั่ง') +
        (r.source ? ' · ' + esc(r.source) : '') + '<div class="ph">' + imgs.map(function (id) { return '<img src="' + ph[id] + '">'; }).join('') + '</div></div>';
    }).join('') + scrapFoot(pages.length + 1, total) + '</div>');
  });
  return pages;
}

// สแกนด้วยหัวสแกน PDA ในหน้า Scrap (ไม่ได้แตะช่องค้นหา) → ส่งเข้าช่อง "เลขพาเลท" แล้วเปิดพาเลทนั้น
document.addEventListener('keydown', function (e) {
  if (S.view !== 'scrap' || !$('modal').classList.contains('hidden')) return;
  var a = document.activeElement, inp = $('scFind');
  if (!inp || a === inp || (a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.tagName === 'SELECT'))) return;
  if (e.key && e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) { e.preventDefault(); inp.focus({ preventScroll: true }); inp.value += e.key; }
}, true);
