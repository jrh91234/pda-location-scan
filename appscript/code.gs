/**
 * PDA Location Scan — สแกน QR สินค้า + บันทึก Location (Zebra TN28 / DataWedge)
 * Backend: Google Apps Script + Google Sheets
 *
 * หน้าเว็บ (GitHub Pages) ส่ง POST { action, args: [...] } แบบ text/plain → ตอบ { ok, data } หรือ { ok:false, error }
 */

// ======================= ค่าคงที่ =======================
const SHEET_NAME = 'Scans';
const HEADERS = ['scan_id', 'scanned_at', 'saved_at', 'location', 'qr_raw', 'part_code', 'lot_no', 'qty', 'unit',
                 'pkg_ref', 'scanned_by', 'device', 'status', 'deleted_by', 'deleted_at', 'delete_reason',
                 'qty_original', 'edited_by', 'edited_at', 'edit_note', 'location_original'];
// คอลัมน์ที่ต้องเก็บเป็นข้อความ (กันเลข 0 นำหน้าหาย / กัน Sheets แปลงเป็นวันที่หรือตัวเลข)
const TEXT_COLS = ['scan_id', 'location', 'location_original', 'qr_raw', 'part_code', 'lot_no', 'pkg_ref', 'scanned_by', 'device'];
const TZ = 'Asia/Bangkok';
const MAX_BATCH = 50;

// ======================= Web App =======================
const API_ACTIONS = { ping: ping, saveScans: saveScans, listScans: listScans, deleteScan: deleteScan, updateQty: updateQty, updateLocation: updateLocation, findByQr: findByQr, getScans: getScans, getTimeline: getTimeline, getPartPackages: getPartPackages, getLocationMap: getLocationMap,
  uploadPhoto: uploadPhoto, getPhoto: getPhoto, deletePhoto: deletePhoto };

function doPost(e) {
  let out;
  try {
    const req = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    const fn = API_ACTIONS[req.action];
    if (!fn) throw new Error('ไม่รู้จักคำสั่ง: ' + req.action);
    out = { ok: true, data: fn.apply(null, Array.isArray(req.args) ? req.args : []) };
  } catch (err) {
    out = { ok: false, error: (err && err.message) || String(err) };
  }
  return ContentService.createTextOutput(JSON.stringify(out)).setMimeType(ContentService.MimeType.JSON);
}

/** เปิด /exec ในเบราว์เซอร์เพื่อเช็คว่า API ทำงาน */
function doGet() {
  return ContentService.createTextOutput(JSON.stringify({ ok: true, app: 'PDA Location Scan API', time: new Date().toISOString() }))
    .setMimeType(ContentService.MimeType.JSON);
}

// ======================= เมนูใน Google Sheet =======================
function onOpen() {
  SpreadsheetApp.getUi().createMenu('PDA Scan')
    .addItem('ตั้งค่าเริ่มต้น (สร้างชีต Scans)', 'setupFromMenu')
    .addToUi();
}

function setupFromMenu() {
  setup_();
  photoSheet_();
  logSheet_();
  const folder = photoFolder_(); // ขอสิทธิ์ Google Drive สำหรับเก็บรูป
  SpreadsheetApp.getUi().alert('พร้อมใช้งาน: ชีต "' + SHEET_NAME + '", "' + PHOTO_SHEET + '" และโฟลเดอร์รูป "' + folder.getName() + '"');
}

// ======================= ชีต =======================
function book_() {
  const id = PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID');
  return id ? SpreadsheetApp.openById(id) : SpreadsheetApp.getActiveSpreadsheet();
}

function setup_() {
  const ss = book_();
  let sh = ss.getSheetByName(SHEET_NAME);
  if (!sh) sh = ss.insertSheet(SHEET_NAME);
  if (sh.getLastRow() === 0) {
    sh.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]);
    sh.setFrozenRows(1);
  }
  TEXT_COLS.forEach(function (col) {
    sh.getRange(1, HEADERS.indexOf(col) + 1, sh.getMaxRows(), 1).setNumberFormat('@');
  });
  return sh;
}

function sheet_() {
  const sh = book_().getSheetByName(SHEET_NAME);
  if (!sh || sh.getLastRow() === 0) return setup_();
  // ชีตที่สร้างจากเวอร์ชันเก่า: เติมหัวคอลัมน์ใหม่ต่อท้าย
  if (sh.getLastColumn() < HEADERS.length) sh.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]);
  return sh;
}

function readAll_(sh) {
  const n = sh.getLastRow() - 1;
  if (n <= 0) return [];
  return sh.getRange(2, 1, n, HEADERS.length).getValues().map(function (r, i) {
    const o = { _row: i + 2 };
    HEADERS.forEach(function (h, j) { o[h] = r[j]; });
    return o;
  });
}

function fmt_(d) {
  return d instanceof Date ? Utilities.formatDate(d, TZ, 'yyyy-MM-dd HH:mm:ss') : String(d || '');
}

function toClient_(o) {
  return {
    scan_id: String(o.scan_id), scanned_at: fmt_(o.scanned_at), saved_at: fmt_(o.saved_at),
    location: String(o.location), qr_raw: String(o.qr_raw), part_code: String(o.part_code),
    lot_no: String(o.lot_no), qty: o.qty === '' ? '' : Number(o.qty), unit: String(o.unit),
    pkg_ref: String(o.pkg_ref), scanned_by: String(o.scanned_by), device: String(o.device),
    status: String(o.status || 'active'), deleted_by: String(o.deleted_by || ''),
    deleted_at: fmt_(o.deleted_at), delete_reason: String(o.delete_reason || ''),
    qty_original: o.qty_original === '' || o.qty_original == null ? '' : Number(o.qty_original),
    edited_by: String(o.edited_by || ''), edited_at: fmt_(o.edited_at), edit_note: String(o.edit_note || ''),
    location_original: String(o.location_original || '')
  };
}

function clean_(v, max) {
  return String(v == null ? '' : v).replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, max || 200);
}

function allowDuplicate_() {
  return PropertiesService.getScriptProperties().getProperty('ALLOW_DUPLICATE_QR') === 'true';
}

/**
 * ตรวจ QR ซ้ำอีกชั้นที่เซิร์ฟเวอร์ (กันเครื่องที่ยังเปิดหน้าเว็บเวอร์ชันเก่า)
 *  - ข้อความเบิ้ล ABCABC → ตัดเหลือ ABC
 *  - ป้าย Warehouse (รหัส*Lot*จำนวน*แพ็กเกจ) ที่มี * เกิน 4 ส่วน = 2 ป้ายติดกัน → ไม่บันทึก
 */
function checkQr_(text) {
  let fixed = false;
  if (text.length >= 6 && text.length % 2 === 0) {
    const h = text.length / 2;
    if (text.slice(0, h) === text.slice(h)) { text = text.slice(0, h); fixed = true; }
  }
  const parts = text.split('*');
  const isQty = function (v) { return String(v || '').trim() !== '' && !isNaN(Number(String(v).replace(/,/g, ''))); };
  if (parts.length > 4 && isQty(parts[2])) {
    return { text: text, fixed: fixed, error: 'QR ผิดรูปแบบ อาจสแกนติดกัน 2 ครั้ง — กรุณาลบแล้วสแกนใหม่' };
  }
  let parsed = null;
  if (parts.length >= 3 && parts.length <= 4 && parts[0] && isQty(parts[2])) {
    const q = Number(String(parts[2]).replace(/,/g, ''));
    parsed = { part_code: parts[0].trim(), lot_no: (parts[1] || '').trim(), qty: q, unit: Math.floor(q) === q ? 'EA' : 'kg', pkg_ref: (parts[3] || '').trim() };
  }
  return { text: text, fixed: fixed, error: '', parsed: parsed };
}

// ======================= API =======================
function ping() {
  return { time: fmt_(new Date()), allowDuplicate: allowDuplicate_() };
}

/**
 * บันทึกหลายรายการในครั้งเดียว — scan_id สร้างจากเครื่อง จึงส่งซ้ำได้โดยไม่เกิดข้อมูลซ้ำ (idempotent)
 * คืนผลรายตัว: { scan_id, result: 'saved' | 'exists' | 'duplicate', existing? }
 */
function saveScans(items) {
  if (!Array.isArray(items) || !items.length) return [];
  if (items.length > MAX_BATCH) throw new Error('ส่งได้ครั้งละไม่เกิน ' + MAX_BATCH + ' รายการ');
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const sh = sheet_();
    const rows = readAll_(sh);
    const byId = {}, activeByQr = {};
    rows.forEach(function (r) {
      byId[String(r.scan_id)] = r;
      if (String(r.status) !== 'deleted') activeByQr[String(r.qr_raw)] = r;
    });
    const allowDup = allowDuplicate_();
    const now = new Date();
    const results = [], toAppend = [];

    items.forEach(function (it) {
      const id = clean_(it.scan_id, 64);
      const loc = clean_(it.location, 40).toUpperCase();
      const chk = checkQr_(clean_(it.qr_raw, 500));
      const qr = chk.text;
      if (!id || !qr || !loc) { results.push({ scan_id: id, result: 'invalid', error: 'ข้อมูลไม่ครบ (QR / Location)' }); return; }
      if (chk.error) { results.push({ scan_id: id, result: 'invalid', error: chk.error }); return; }
      if (chk.fixed && chk.parsed) Object.assign(it, chk.parsed); // ค่าที่เครื่องแยกมาจากข้อความเบิ้ล → ใช้ค่าที่แยกใหม่
      if (byId[id]) { results.push({ scan_id: id, result: 'exists' }); return; }
      const dup = activeByQr[qr];
      if (dup && !allowDup) {
        results.push({ scan_id: id, result: 'duplicate', existing: toClient_(dup) });
        return;
      }
      const scannedAt = it.scanned_at ? new Date(it.scanned_at) : now;
      const qty = it.qty === '' || it.qty == null || isNaN(Number(it.qty)) ? '' : Number(it.qty);
      const rec = {
        scan_id: id, scanned_at: isNaN(scannedAt.getTime()) ? now : scannedAt, saved_at: now,
        location: loc, qr_raw: qr, part_code: clean_(it.part_code, 80), lot_no: clean_(it.lot_no, 80),
        qty: qty, unit: clean_(it.unit, 10), pkg_ref: clean_(it.pkg_ref, 80),
        scanned_by: clean_(it.scanned_by, 60), device: clean_(it.device, 60),
        status: 'active', deleted_by: '', deleted_at: '', delete_reason: '',
        qty_original: '', edited_by: '', edited_at: '', edit_note: '', location_original: ''
      };
      toAppend.push(HEADERS.map(function (h) { return rec[h]; }));
      byId[id] = rec;
      activeByQr[qr] = rec;
      results.push({ scan_id: id, result: 'saved', record: toClient_(rec) });
    });

    if (toAppend.length) {
      sh.getRange(sh.getLastRow() + 1, 1, toAppend.length, HEADERS.length).setValues(toAppend);
      logEvents_(results.filter(function (r) { return r.result === 'saved'; }).map(function (r) {
        const x = r.record;
        return { scan_id: x.scan_id, event: 'create', part_code: x.part_code, qr_raw: x.qr_raw,
                 location_to: x.location, qty_to: x.qty, unit: x.unit, by: x.scanned_by, at: now, note: x.device ? 'เครื่อง ' + x.device : '' };
      }));
    }
    return results;
  } finally {
    lock.releaseLock();
  }
}

/**
 * ดึงรายการ — filter: { date: 'yyyy-MM-dd', location, user, q, includeDeleted, limit }
 */
function listScans(filter) {
  filter = filter || {};
  const limit = Math.min(Number(filter.limit) || 300, filter.export ? 20000 : 2000); // export = ดึงได้มากกว่าหน้าจอ
  const loc = clean_(filter.location, 40).toUpperCase();
  const user = clean_(filter.user, 60).toLowerCase();
  const q = clean_(filter.q, 80).toLowerCase();
  // ช่วงวันทำงาน (ตัดวัน 08:00) + กะ: day = เช้า, night = ดึก — ยังรับ filter.date แบบเดิม (= วันทำงานเดียว)
  let from = clean_(filter.dateFrom || filter.date, 10), to = clean_(filter.dateTo || filter.date, 10);
  if (from && to && from > to) { const t = from; from = to; to = t; }
  const shift = filter.shift === 'day' || filter.shift === 'night' ? filter.shift : '';
  const rows = readAll_(sheet_()).map(toClient_);
  const photos = photosByScan_();
  const out = [];
  let total = 0;
  const locs = {}, parts = {}, users = [];
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i];
    if (r.scanned_by && users.indexOf(r.scanned_by) < 0) users.push(r.scanned_by); // รายชื่อผู้บันทึกทั้งหมด ล่าสุดก่อน (วนจากท้ายชีต)
    if (!filter.includeDeleted && r.status === 'deleted') continue;
    if (from || to || shift) {
      const ws = workShift_(r.scanned_at);
      if (from && ws.date < from) continue;
      if (to && ws.date > to) continue;
      if (shift && ws.shift !== shift) continue;
    }
    if (loc && r.location.indexOf(loc) !== 0) continue;
    if (user && (filter.userExact ? r.scanned_by.toLowerCase() !== user : r.scanned_by.toLowerCase().indexOf(user) < 0)) continue;
    if (q && (r.qr_raw + ' ' + r.part_code + ' ' + r.lot_no).toLowerCase().indexOf(q) < 0) continue;
    if (r.status !== 'deleted') {
      total++;
      locs[r.location] = 1;
      parts[r.part_code] = 1;
    }
    if (out.length < limit) { r.photos = photos[r.scan_id] || []; out.push(r); }
  }
  return { rows: out, total: total, partCount: Object.keys(parts).length, locationCount: Object.keys(locs).length, users: users.slice(0, 200) };
}

/** สรุปต่อ Location สำหรับหน้าผัง: จำนวนกล่องที่ใช้งานอยู่ / สแกนวันนี้ / สแกนล่าสุดเมื่อไหร่ โดยใคร */
function getLocationMap() {
  const today = workShift_(fmt_(new Date())).date; // "วันนี้" = วันทำงาน (ตัดวัน 08:00)
  const rows = readAll_(sheet_()).map(toClient_);
  const map = {};
  rows.forEach(function (r) {
    if (r.status === 'deleted' || !r.location) return;
    const m = map[r.location] || (map[r.location] = { n: 0, today: 0, last: '', by: '' });
    m.n++;
    const at = r.edited_at > r.scanned_at ? r.edited_at : r.scanned_at;
    if (workShift_(at).date === today) m.today++;
    if (at > m.last) { m.last = at; m.by = r.edited_by && r.edited_at === at ? r.edited_by : r.scanned_by; m.ev = r.edited_at === at ? 'qty' : 'create'; m.part = r.part_code; }
  });
  // ความเคลื่อนไหวล่าสุดจาก Log (รวมการย้ายออก / ลบ ซึ่งไม่เหลือในแถวของ Location เดิม)
  const recent = [];
  readLog_().forEach(function (e) {
    const at = fmt_(e.at), ev = String(e.event), from = String(e.location_from || ''), to = String(e.location_to || '');
    if (!at || ev.indexOf('photo') === 0) return; // แนบ/ลบรูป ไม่นับเป็นการเคลื่อนไหวของของ
    const locs = [];
    if (to) locs.push(to);
    if (from && from !== to) locs.push(from);
    if (!locs.length) return;
    locs.forEach(function (loc) {
      const m = map[loc] || (map[loc] = { n: 0, today: 0, last: '', by: '' });
      if (at >= m.last) { m.last = at; m.by = String(e.by || ''); m.ev = ev === 'move' && loc === from ? 'move_out' : ev; m.part = String(e.part_code || ''); }
    });
    recent.push({ at: at, ev: ev, from: from, to: to, part: String(e.part_code || ''), by: String(e.by || '') });
  });
  recent.sort(function (a, b) { return a.at < b.at ? 1 : a.at > b.at ? -1 : 0; });
  return { today: today, map: map, recent: recent.slice(0, 30) };
}

// วันทำงานเริ่ม 08:00 ถึง 07:59 ของอีกวัน · กะเช้า 08:00–19:59 · กะดึก 20:00–07:59
const SHIFT_DAY_START = 8, SHIFT_NIGHT_START = 20;
function workShift_(at) {
  const m = String(at).match(/^(\d{4})-(\d\d)-(\d\d) (\d\d)/);
  if (!m) return { date: '', shift: '' };
  const h = Number(m[4]);
  let date = m[1] + '-' + m[2] + '-' + m[3];
  if (h < SHIFT_DAY_START) {
    const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]) - 1));
    date = d.toISOString().slice(0, 10);
  }
  return { date: date, shift: h >= SHIFT_DAY_START && h < SHIFT_NIGHT_START ? 'day' : 'night' };
}

/** หารายการที่ยังใช้งานอยู่ของ QR นี้ (ใช้ตรวจซ้ำทันทีหลังสแกน ก่อนกดบันทึก) — ไม่พบ = null */
function findByQr(qr) {
  const chk = checkQr_(clean_(qr, 500));
  if (!chk.text) return null;
  const rows = readAll_(sheet_());
  for (let i = rows.length - 1; i >= 0; i--) {
    if (String(rows[i].qr_raw) === chk.text && String(rows[i].status) !== 'deleted') return toClient_(rows[i]);
  }
  return null;
}

/** ดึงสถานะล่าสุดของหลายรายการ (ให้หน้าสแกนในเครื่องตรงกับชีต: ลบ/ย้าย/แก้ยอดจากเครื่องอื่น) */
function getScans(ids) {
  if (!Array.isArray(ids) || !ids.length) return [];
  const want = {};
  ids.slice(0, 500).forEach(function (id) { want[clean_(id, 64)] = 1; });
  return readAll_(sheet_()).filter(function (r) { return want[String(r.scan_id)]; }).map(toClient_);
}

/**
 * แก้ยอดหลังบันทึก — เก็บยอดเดิมครั้งแรกไว้ใน qty_original + ใคร/เมื่อไร/เหตุผล
 */
function updateQty(scanId, qty, editedBy, note) {
  const id = clean_(scanId, 64), by = clean_(editedBy, 60);
  const n = Number(String(qty).replace(/,/g, ''));
  if (!id) throw new Error('ไม่พบรหัสรายการ');
  if (!by) throw new Error('กรุณาระบุชื่อผู้แก้ไข');
  if (String(qty).trim() === '' || isNaN(n) || n < 0) throw new Error('ยอดไม่ถูกต้อง');
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const sh = sheet_();
    const row = readAll_(sh).filter(function (r) { return String(r.scan_id) === id; })[0];
    if (!row) throw new Error('ไม่พบรายการนี้ในระบบ');
    if (String(row.status) === 'deleted') throw new Error('รายการนี้ถูกลบแล้ว แก้ยอดไม่ได้');
    const now = new Date();
    const prevQty = row.qty;
    const orig = row.qty_original === '' || row.qty_original == null ? row.qty : row.qty_original;
    row.qty = n; row.qty_original = orig; row.edited_by = by; row.edited_at = now; row.edit_note = clean_(note, 200);
    sh.getRange(row._row, HEADERS.indexOf('qty') + 1).setValue(n);
    const c = HEADERS.indexOf('qty_original') + 1;
    sh.getRange(row._row, c, 1, 4).setValues([[orig, by, now, row.edit_note]]);
    logEvents_([{ scan_id: id, event: 'qty', part_code: row.part_code, qr_raw: row.qr_raw, location_to: row.location,
                  qty_from: prevQty, qty_to: n, unit: row.unit, by: by, at: now, note: row.edit_note }]);
    return toClient_(row);
  } finally {
    lock.releaseLock();
  }
}

/**
 * ย้าย Location หลังบันทึก — เก็บ Location แรกไว้ใน location_original + ใคร/เมื่อไร/เหตุผล
 * อัปเดตคอลัมน์ location ในชีต Photos ของรายการนี้ด้วย
 */
function updateLocation(scanId, location, editedBy, note) {
  const id = clean_(scanId, 64), by = clean_(editedBy, 60);
  const loc = clean_(location, 40).toUpperCase();
  if (!id) throw new Error('ไม่พบรหัสรายการ');
  if (!by) throw new Error('กรุณาระบุชื่อผู้แก้ไข');
  if (!/^[A-Z0-9][A-Z0-9-]{1,39}$/.test(loc)) throw new Error('Location ไม่ถูกต้อง');
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const sh = sheet_();
    const row = readAll_(sh).filter(function (r) { return String(r.scan_id) === id; })[0];
    if (!row) throw new Error('ไม่พบรายการนี้ในระบบ');
    if (String(row.status) === 'deleted') throw new Error('รายการนี้ถูกลบแล้ว ย้าย Location ไม่ได้');
    if (String(row.location) === loc) return toClient_(row);
    const now = new Date();
    const prevLoc = String(row.location);
    const orig = String(row.location_original || '') || String(row.location);
    const n = clean_(note, 200);
    row.location = loc; row.location_original = orig; row.edited_by = by; row.edited_at = now; row.edit_note = n;
    sh.getRange(row._row, HEADERS.indexOf('location') + 1).setValue(loc);
    sh.getRange(row._row, HEADERS.indexOf('edited_by') + 1, 1, 4).setValues([[by, now, n, orig]]);
    logEvents_([{ scan_id: id, event: 'move', part_code: row.part_code, qr_raw: row.qr_raw, location_from: prevLoc,
                  location_to: loc, qty_to: row.qty, unit: row.unit, by: by, at: now, note: n }]);
    const ps = book_().getSheetByName(PHOTO_SHEET);
    if (ps) readPhotos_(ps).forEach(function (p) {
      if (String(p.scan_id) === id) ps.getRange(p._row, PHOTO_HEADERS.indexOf('location') + 1).setValue(loc);
    });
    return toClient_(row);
  } finally {
    lock.releaseLock();
  }
}

/** ลบแบบ soft delete — แถวยังอยู่ในชีต (status = deleted) เพื่อให้ตรวจสอบย้อนหลังได้ */
function deleteScan(scanId, deletedBy, reason) {
  const id = clean_(scanId, 64);
  const by = clean_(deletedBy, 60);
  if (!id) throw new Error('ไม่พบรหัสรายการ');
  if (!by) throw new Error('กรุณาระบุชื่อผู้ลบ');
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const sh = sheet_();
    const row = readAll_(sh).filter(function (r) { return String(r.scan_id) === id; })[0];
    if (!row) throw new Error('ไม่พบรายการนี้ในระบบ');
    if (String(row.status) === 'deleted') return toClient_(row);
    const c = HEADERS.indexOf('status') + 1;
    const now = new Date();
    sh.getRange(row._row, c, 1, 4).setValues([['deleted', by, now, clean_(reason, 200)]]);
    row.status = 'deleted'; row.deleted_by = by; row.deleted_at = now; row.delete_reason = clean_(reason, 200);
    logEvents_([{ scan_id: id, event: 'delete', part_code: row.part_code, qr_raw: row.qr_raw, location_from: row.location,
                  qty_from: row.qty, unit: row.unit, by: by, at: now, note: row.delete_reason }]);
    return toClient_(row);
  } finally {
    lock.releaseLock();
  }
}

// ======================= รูปถ่าย =======================
// เก็บไฟล์ใน Google Drive (โฟลเดอร์ส่วนตัว ไม่เปิดสาธารณะ) + บันทึกรายการในชีต Photos
// หน้าเว็บโหลดรูปผ่าน getPhoto (Apps Script ส่ง base64 กลับ) จึงไม่ต้องแชร์ไฟล์
const PHOTO_SHEET = 'Photos';
const PHOTO_HEADERS = ['photo_id', 'scan_id', 'location', 'part_code', 'file_id', 'file_url', 'uploaded_at', 'uploaded_by',
                       'status', 'deleted_by', 'deleted_at'];
const PHOTO_TEXT_COLS = ['photo_id', 'scan_id', 'location', 'part_code', 'file_id', 'uploaded_by'];
const MAX_PHOTO_BYTES = 5 * 1024 * 1024;

function photoSheet_() {
  const ss = book_();
  let sh = ss.getSheetByName(PHOTO_SHEET);
  if (!sh) sh = ss.insertSheet(PHOTO_SHEET);
  if (sh.getLastRow() === 0) {
    sh.getRange(1, 1, 1, PHOTO_HEADERS.length).setValues([PHOTO_HEADERS]);
    sh.setFrozenRows(1);
    PHOTO_TEXT_COLS.forEach(function (col) {
      sh.getRange(1, PHOTO_HEADERS.indexOf(col) + 1, sh.getMaxRows(), 1).setNumberFormat('@');
    });
  }
  return sh;
}

function readPhotos_(sh) {
  const n = sh.getLastRow() - 1;
  if (n <= 0) return [];
  return sh.getRange(2, 1, n, PHOTO_HEADERS.length).getValues().map(function (r, i) {
    const o = { _row: i + 2 };
    PHOTO_HEADERS.forEach(function (h, j) { o[h] = r[j]; });
    return o;
  });
}

function photosByScan_() {
  const sh = book_().getSheetByName(PHOTO_SHEET);
  const map = {};
  if (!sh) return map;
  readPhotos_(sh).forEach(function (p) {
    if (String(p.status) === 'deleted') return;
    (map[String(p.scan_id)] = map[String(p.scan_id)] || []).push(String(p.photo_id));
  });
  return map;
}

function photoFolder_() {
  const props = PropertiesService.getScriptProperties();
  const id = props.getProperty('PHOTO_FOLDER_ID');
  if (id) {
    try { return DriveApp.getFolderById(id); } catch (e) { /* โฟลเดอร์ถูกลบ → สร้างใหม่ */ }
  }
  const folder = DriveApp.createFolder('PDA Scan Photos');
  props.setProperty('PHOTO_FOLDER_ID', folder.getId());
  return folder;
}

/** p: { photo_id, scan_id, data (base64 ไม่มี prefix), mime, uploaded_by } — ส่งซ้ำได้ (photo_id เดิมจะไม่สร้างไฟล์ใหม่) */
function uploadPhoto(p) {
  p = p || {};
  const id = clean_(p.photo_id, 64), scanId = clean_(p.scan_id, 64), by = clean_(p.uploaded_by, 60);
  const mime = /^image\/(jpeg|png|webp)$/.test(String(p.mime)) ? String(p.mime) : 'image/jpeg';
  if (!id || !scanId || !p.data) throw new Error('ข้อมูลรูปไม่ครบ');
  const bytes = Utilities.base64Decode(String(p.data));
  if (bytes.length > MAX_PHOTO_BYTES) throw new Error('รูปใหญ่เกิน 5MB');

  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const sh = photoSheet_();
    const existing = readPhotos_(sh).filter(function (r) { return String(r.photo_id) === id; })[0];
    if (existing) return { photo_id: id, scan_id: String(existing.scan_id), result: 'exists' };

    const scan = readAll_(sheet_()).filter(function (r) { return String(r.scan_id) === scanId; })[0];
    const loc = scan ? String(scan.location) : '';
    const part = scan ? String(scan.part_code) : '';
    const now = new Date();
    const name = [loc || 'NOLOC', (part || 'item').replace(/[\/:*?"<>|]/g, '_').slice(0, 40),
                  Utilities.formatDate(now, TZ, 'yyyyMMdd-HHmmss'), id.slice(0, 6)].join('_') + (mime === 'image/png' ? '.png' : '.jpg');
    const file = photoFolder_().createFile(Utilities.newBlob(bytes, mime, name));
    const rec = { photo_id: id, scan_id: scanId, location: loc, part_code: part, file_id: file.getId(), file_url: file.getUrl(),
                  uploaded_at: now, uploaded_by: by, status: 'active', deleted_by: '', deleted_at: '' };
    sh.getRange(sh.getLastRow() + 1, 1, 1, PHOTO_HEADERS.length).setValues([PHOTO_HEADERS.map(function (h) { return rec[h]; })]);
    logEvents_([{ scan_id: scanId, event: 'photo_add', part_code: part, location_to: loc, by: by, at: now, ref: id }]);
    return { photo_id: id, scan_id: scanId, result: 'saved' };
  } finally {
    lock.releaseLock();
  }
}

/** คืนรูปเป็น data URL สำหรับแสดงในหน้าเว็บ */
function getPhoto(photoId) {
  const id = clean_(photoId, 64);
  const sh = book_().getSheetByName(PHOTO_SHEET);
  const row = sh && readPhotos_(sh).filter(function (r) { return String(r.photo_id) === id; })[0];
  if (!row) throw new Error('ไม่พบรูป');
  const blob = DriveApp.getFileById(String(row.file_id)).getBlob();
  return { photo_id: id, data: 'data:' + blob.getContentType() + ';base64,' + Utilities.base64Encode(blob.getBytes()) };
}

/** ลบรูป: ทำเครื่องหมายในชีต + ย้ายไฟล์ไปถังขยะ Drive (กู้คืนได้ภายใน 30 วัน) */
function deletePhoto(photoId, deletedBy) {
  const id = clean_(photoId, 64), by = clean_(deletedBy, 60);
  if (!by) throw new Error('กรุณาระบุชื่อผู้ลบ');
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const sh = photoSheet_();
    const row = readPhotos_(sh).filter(function (r) { return String(r.photo_id) === id; })[0];
    if (!row) throw new Error('ไม่พบรูป');
    if (String(row.status) !== 'deleted') {
      sh.getRange(row._row, PHOTO_HEADERS.indexOf('status') + 1, 1, 3).setValues([['deleted', by, new Date()]]);
      try { DriveApp.getFileById(String(row.file_id)).setTrashed(true); } catch (e) { /* ไฟล์หายไปแล้ว */ }
      logEvents_([{ scan_id: String(row.scan_id), event: 'photo_delete', part_code: String(row.part_code), location_to: String(row.location),
                    by: by, at: new Date(), ref: id }]);
    }
    return { photo_id: id, status: 'deleted' };
  } finally {
    lock.releaseLock();
  }
}

// ======================= ประวัติ (Log) =======================
// ทุกการเปลี่ยนแปลงเพิ่ม 1 แถวในชีต Log (เพิ่มอย่างเดียว ไม่แก้ย้อนหลัง) → ใช้ทำ timeline ของแต่ละรายการ
const LOG_SHEET = 'Log';
const LOG_HEADERS = ['log_id', 'at', 'scan_id', 'event', 'part_code', 'qr_raw', 'location_from', 'location_to',
                     'qty_from', 'qty_to', 'unit', 'by', 'note', 'ref'];
const LOG_TEXT_COLS = ['log_id', 'scan_id', 'event', 'part_code', 'qr_raw', 'location_from', 'location_to', 'unit', 'by', 'ref'];

function logSheet_() {
  const ss = book_();
  let sh = ss.getSheetByName(LOG_SHEET);
  if (!sh) sh = ss.insertSheet(LOG_SHEET);
  if (sh.getLastRow() === 0) {
    sh.getRange(1, 1, 1, LOG_HEADERS.length).setValues([LOG_HEADERS]);
    sh.setFrozenRows(1);
    LOG_TEXT_COLS.forEach(function (col) {
      sh.getRange(1, LOG_HEADERS.indexOf(col) + 1, sh.getMaxRows(), 1).setNumberFormat('@');
    });
  }
  return sh;
}

// เรียกภายใน lock ของคำสั่งที่เปลี่ยนข้อมูลเท่านั้น — ถ้าเขียน log ไม่ได้ ไม่ให้การบันทึกหลักล้มตาม
function logEvents_(events) {
  if (!events || !events.length) return;
  try {
    const sh = logSheet_();
    const rows = events.map(function (e) {
      return LOG_HEADERS.map(function (h) {
        if (h === 'log_id') return Utilities.getUuid();
        if (h === 'at') return e.at || new Date();
        const v = e[h];
        return v === undefined || v === null ? '' : v;
      });
    });
    sh.getRange(sh.getLastRow() + 1, 1, rows.length, LOG_HEADERS.length).setValues(rows);
  } catch (err) {
    console.error('logEvents_ failed: ' + err);
  }
}

function readLog_() {
  const sh = book_().getSheetByName(LOG_SHEET);
  if (!sh || sh.getLastRow() < 2) return [];
  return sh.getRange(2, 1, sh.getLastRow() - 1, LOG_HEADERS.length).getValues().map(function (r) {
    const o = {};
    LOG_HEADERS.forEach(function (h, j) { o[h] = r[j]; });
    return o;
  });
}

function logToClient_(e, legacy) {
  const num = function (v) { return v === '' || v == null ? '' : Number(v); };
  return {
    at: fmt_(e.at), event: String(e.event), location_from: String(e.location_from || ''), location_to: String(e.location_to || ''),
    qty_from: num(e.qty_from), qty_to: num(e.qty_to), unit: String(e.unit || ''), by: String(e.by || ''),
    note: String(e.note || ''), ref: String(e.ref || ''), legacy: !!legacy
  };
}

/**
 * timeline ของ 1 รายการ: { record, events[], legacy }
 * รายการที่บันทึกก่อนเริ่มเก็บ Log → สร้างเหตุการณ์ย้อนหลังจากข้อมูลที่มี (ค่าแรก + แก้ครั้งล่าสุด + ลบ + รูป)
 */
function getTimeline(scanId) {
  const id = clean_(scanId, 64);
  const row = readAll_(sheet_()).filter(function (r) { return String(r.scan_id) === id; })[0];
  if (!row) throw new Error('ไม่พบรายการนี้ในระบบ');
  const rec = toClient_(row);
  const logs = readLog_().filter(function (e) { return String(e.scan_id) === id; });
  const has = function (ev) { return logs.some(function (e) { return String(e.event) === ev; }); };
  const events = logs.map(function (e) { return logToClient_(e, false); });
  const legacy = !has('create');

  if (legacy) {
    const firstLoc = rec.location_original || rec.location;
    const firstQty = rec.qty_original !== '' ? rec.qty_original : rec.qty;
    events.push(logToClient_({ at: row.scanned_at, event: 'create', location_to: firstLoc, qty_to: firstQty, unit: rec.unit,
                               by: rec.scanned_by, note: rec.device ? 'เครื่อง ' + rec.device : '' }, true));
    if (!has('qty') && rec.qty_original !== '' && rec.qty_original !== rec.qty) {
      events.push(logToClient_({ at: row.edited_at, event: 'qty', location_to: rec.location, qty_from: rec.qty_original, qty_to: rec.qty,
                                 unit: rec.unit, by: rec.edited_by, note: rec.edit_note }, true));
    }
    if (!has('move') && rec.location_original && rec.location_original !== rec.location) {
      events.push(logToClient_({ at: row.edited_at, event: 'move', location_from: rec.location_original, location_to: rec.location,
                                 qty_to: rec.qty, unit: rec.unit, by: rec.edited_by, note: rec.edit_note }, true));
    }
    if (!has('delete') && rec.status === 'deleted') {
      events.push(logToClient_({ at: row.deleted_at, event: 'delete', location_from: rec.location, qty_from: rec.qty, unit: rec.unit,
                                 by: rec.deleted_by, note: rec.delete_reason }, true));
    }
    const ps = book_().getSheetByName(PHOTO_SHEET);
    if (ps) {
      const logged = {};
      logs.forEach(function (e) { if (e.ref) logged[String(e.ref)] = 1; });
      readPhotos_(ps).forEach(function (p) {
        if (String(p.scan_id) !== id || logged[String(p.photo_id)]) return;
        events.push(logToClient_({ at: p.uploaded_at, event: 'photo_add', location_to: String(p.location), by: String(p.uploaded_by), ref: String(p.photo_id) }, true));
        if (String(p.status) === 'deleted') {
          events.push(logToClient_({ at: p.deleted_at, event: 'photo_delete', by: String(p.deleted_by), ref: String(p.photo_id) }, true));
        }
      });
    }
  }
  events.sort(function (a, b) { return a.at < b.at ? -1 : a.at > b.at ? 1 : 0; });
  return { record: rec, events: events, legacy: legacy };
}

/** ทุกกล่อง/แพ็กเกจที่ยังใช้งานของรหัสสินค้านี้ + ยอดรวมแยกตามหน่วย */
function getPartPackages(partCode) {
  const part = clean_(partCode, 80).toUpperCase();
  if (!part) throw new Error('ไม่พบรหัสสินค้า');
  const rows = readAll_(sheet_()).map(toClient_).filter(function (r) {
    return r.status !== 'deleted' && r.part_code.toUpperCase() === part;
  });
  rows.sort(function (a, b) { return a.location < b.location ? -1 : a.location > b.location ? 1 : 0; });
  const totals = {}, locs = {};
  rows.forEach(function (r) {
    if (typeof r.qty === 'number') totals[r.unit || '-'] = (totals[r.unit || '-'] || 0) + r.qty;
    locs[r.location] = 1;
  });
  return { part_code: part, rows: rows, totals: totals, locationCount: Object.keys(locs).length };
}
