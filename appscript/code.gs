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
                 'qty_original', 'edited_by', 'edited_at', 'edit_note', 'location_original', 'note'];
// คอลัมน์ที่ต้องเก็บเป็นข้อความ (กันเลข 0 นำหน้าหาย / กัน Sheets แปลงเป็นวันที่หรือตัวเลข)
const TEXT_COLS = ['scan_id', 'location', 'location_original', 'qr_raw', 'part_code', 'lot_no', 'pkg_ref', 'scanned_by', 'device'];
const TZ = 'Asia/Bangkok';
const MAX_BATCH = 50;

// ======================= Web App =======================
const API_ACTIONS = { ping: ping, saveScans: saveScans, listScans: listScans, deleteScan: deleteScan, updateQty: updateQty, updateLocation: updateLocation, findByQr: findByQr, findSamePkg: findSamePkg, getScans: getScans, getTimeline: getTimeline, getPartPackages: getPartPackages, getLocationMap: getLocationMap, getLocationEvents: getLocationEvents,
  uploadPhoto: uploadPhoto, getPhoto: getPhoto, deletePhoto: deletePhoto,
  getCountState: getCountState, setCountRound: setCountRound, markBinCounted: markBinCounted, getKingdeeMoves: getKingdeeMoves,
  getCountProfile: getCountProfile, saveCountProfile: saveCountProfile, saveCountSample: saveCountSample };

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
    location_original: String(o.location_original || ''), note: String(o.note || '')
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
        qty_original: '', edited_by: '', edited_at: '', edit_note: '', location_original: '',
        note: clean_(it.note, 200)
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
                 location_to: x.location, qty_to: x.qty, unit: x.unit, by: x.scanned_by, at: now, note: [x.device ? 'เครื่อง ' + x.device : '', x.note ? 'หมายเหตุ: ' + x.note : ''].filter(String).join(' · ') };
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
  // รหัสสินค้าที่ชื่อ / Specification ใน BOM ตรงกับคำค้น (หน้าเว็บค้นจาก js/bom.js แล้วส่งมา)
  const qParts = {};
  (Array.isArray(filter.qParts) ? filter.qParts.slice(0, 500) : []).forEach(function (c) { qParts[clean_(c, 40)] = 1; });
  // ช่วงวันทำงาน (ตัดวัน 08:00) + กะ: day = เช้า, night = ดึก — ยังรับ filter.date แบบเดิม (= วันทำงานเดียว)
  let from = clean_(filter.dateFrom || filter.date, 10), to = clean_(filter.dateTo || filter.date, 10);
  if (from && to && from > to) { const t = from; from = to; to = t; }
  const shift = filter.shift === 'day' || filter.shift === 'night' ? filter.shift : '';
  const rows = readAll_(sheet_()).map(toClient_);
  const photos = photosByScan_();
  const out = [];
  let total = 0;
  const locs = {}, parts = {}, users = [], lotIdx = {}, lots = [];
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i];
    if (r.scanned_by && users.indexOf(r.scanned_by) < 0) users.push(r.scanned_by); // รายชื่อผู้บันทึกทั้งหมด ล่าสุดก่อน (วนจากท้ายชีต)
    // รายการ Lot ที่มีในระบบ (ล่าสุดก่อน) — ใช้แนะนำตอนพิมพ์ค้นหา: [lot, รหัสสินค้า, จำนวนกล่อง]
    const lotNo = String(r.lot_no || '');
    if (lotNo && r.status !== 'deleted') {
      if (lotNo in lotIdx) lots[lotIdx[lotNo]][2]++;
      else if (lots.length < 3000) { lotIdx[lotNo] = lots.length; lots.push([lotNo, r.part_code, 1]); }
    }
    if (!filter.includeDeleted && r.status === 'deleted') continue;
    if (from || to || shift) {
      const ws = workShift_(r.scanned_at);
      if (from && ws.date < from) continue;
      if (to && ws.date > to) continue;
      if (shift && ws.shift !== shift) continue;
    }
    if (loc && r.location.indexOf(loc) !== 0) continue;
    if (user && (filter.userExact ? r.scanned_by.toLowerCase() !== user : r.scanned_by.toLowerCase().indexOf(user) < 0)) continue;
    if (q && (r.qr_raw + ' ' + r.part_code + ' ' + r.lot_no).toLowerCase().indexOf(q) < 0 && !(qParts[r.part_code])) continue;
    if (r.status !== 'deleted') {
      total++;
      locs[r.location] = 1;
      parts[r.part_code] = 1;
    }
    if (out.length < limit) { r.photos = photos[r.scan_id] || []; out.push(r); }
  }
  return { rows: out, total: total, partCount: Object.keys(parts).length, locationCount: Object.keys(locs).length, users: users.slice(0, 200), lots: lots };
}

/** สรุปต่อ Location สำหรับหน้าผัง: จำนวนกล่องที่ใช้งานอยู่ / สแกนวันนี้ / สแกนล่าสุดเมื่อไหร่ โดยใคร */
function getLocationMap(opt) {
  opt = opt || {};
  const today = workShift_(fmt_(new Date())).date; // "วันนี้" = วันทำงาน (ตัดวัน 08:00)
  const rows = readAll_(sheet_()).map(toClient_);
  const map = {}, items = [];
  rows.forEach(function (r) {
    if (r.status === 'deleted' || !r.location) return;
    items.push([r.location, r.part_code, r.lot_no, String(r.scanned_at).slice(0, 16), r.qty, r.unit, r.scanned_by]); // ใช้ค้นหาบนผัง + FIFO + เทียบ Kingdee (ตัดผู้ทดสอบ)
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
  // 10 Action ล่าสุด (บันทึก / ย้าย / แก้ยอด / ลบ) นับย้อนหลังไม่จำกัดวัน — ใช้วาดลูกศรบนผัง
  // Action ที่ช่องเดียวกันติดกัน (เช่น สแกนหลายกล่องลงช่องเดิม) รวมเป็น 1 จุด (n = จำนวน)
  const actions = [];
  for (let i = 0; i < recent.length && actions.length <= 10; i++) {
    const e = recent[i], loc = e.to || e.from, last = actions[actions.length - 1];
    if (last && last.loc === loc && e.ev !== 'move' && last.ev !== 'move') { last.n++; last.first = e.at; continue; }
    if (actions.length === 10) break;
    actions.push({ at: e.at, first: e.at, ev: e.ev, from: e.from, to: e.to, loc: loc, part: e.part, by: e.by, n: 1 });
  }
  // รายการกล่องทุกช่อง: ส่งเฉพาะเมื่อเปลี่ยนจากที่เครื่องมีอยู่ (เทียบลายเซ็น) เพื่อประหยัดเน็ต
  const sig = hashStr_(JSON.stringify(items)) + '-' + items.length;
  const out = { today: today, map: map, recent: recent.slice(0, 30), actions: actions, sig: sig };
  if (opt.sig !== sig) out.items = items;
  return out;
}
function hashStr_(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(36);
}

/** ลำดับการเคลื่อนไหว (บันทึก / แก้ยอด / ย้าย / ลบ) ของช่วงวันทำงาน + กะ + คน — ใช้เล่นย้อนหลังในหน้าผัง (เก่า → ใหม่) */
function getLocationEvents(filter) {
  filter = filter || {};
  let from = clean_(filter.dateFrom || filter.date, 10), to = clean_(filter.dateTo || filter.date, 10);
  if (from && to && from > to) { const t = from; from = to; to = t; }
  const shift = filter.shift === 'day' || filter.shift === 'night' ? filter.shift : '';
  const user = clean_(filter.user, 60).toLowerCase();
  const out = [];
  readLog_().forEach(function (e) {
    const at = fmt_(e.at), ev = String(e.event);
    if (!at || ev.indexOf('photo') === 0) return;
    const ws = workShift_(at);
    if (from && ws.date < from) return;
    if (to && ws.date > to) return;
    if (shift && ws.shift !== shift) return;
    const by = String(e.by || '');
    if (user && by.toLowerCase() !== user) return;
    const num = function (v) { return v === '' || v == null ? '' : Number(v); };
    out.push({ at: at, ev: ev, from: String(e.location_from || ''), to: String(e.location_to || ''), part: String(e.part_code || ''),
               by: by, qf: num(e.qty_from), qt: num(e.qty_to), unit: String(e.unit || '') });
  });
  out.sort(function (a, b) { return a.at < b.at ? -1 : a.at > b.at ? 1 : 0; });
  return { events: out.slice(0, 5000), total: out.length };
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

/** เลข Package เทียบกัน: ตัด 0 นำหน้า ('0001' = '00001' = '1') */
function pkgKey_(v) { const t = String(v == null ? '' : v).trim().toUpperCase(); return t.replace(/^0+(?=\w)/, ''); }
/**
 * รายการที่ใช้งานอยู่ ซึ่งเป็น รหัส + Lot + Package เดียวกัน แต่ QR ต่างกัน (เช่น ป้ายพิมพ์ใหม่หลังแบ่งกล่อง หรือสแกนกล่องเดิมซ้ำด้วยป้ายใหม่)
 * คืน [] ถ้าไม่มี Package หรือไม่เจอ
 */
function findSamePkg(part, lot, pkg, qr) {
  part = clean_(part, 80).toUpperCase(); lot = clean_(lot, 80); const pk = pkgKey_(clean_(pkg, 80)); qr = clean_(qr, 500);
  if (!part || !pk) return [];
  return readAll_(sheet_()).filter(function (r) {
    return String(r.status) !== 'deleted' && String(r.part_code).toUpperCase() === part && String(r.lot_no) === lot &&
      pkgKey_(r.pkg_ref) === pk && String(r.qr_raw) !== qr;
  }).slice(-10).map(toClient_);
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


// ======================= ตรวจนับเทียบ Kingdee =======================
// รอบนับ (เวลาเริ่ม) เก็บใน Script Properties · เครื่องหมาย "นับช่องนี้เสร็จ" เก็บในชีต CountMarks
// ยอด Kingdee หน้าเว็บดึงเองจาก OnHand-Inventory-Planner (อัปเดตทุก 10 นาที) — ฝั่งนี้ไม่ต้องใช้สิทธิ์ดึง URL ภายนอก
const MARK_SHEET = 'CountMarks';
const MARK_HEADERS = ['at', 'location', 'done', 'by'];

function markSheet_() {
  const ss = book_();
  let sh = ss.getSheetByName(MARK_SHEET);
  if (!sh) sh = ss.insertSheet(MARK_SHEET);
  if (sh.getLastRow() === 0) {
    sh.getRange(1, 1, 1, MARK_HEADERS.length).setValues([MARK_HEADERS]);
    sh.setFrozenRows(1);
    sh.getRange(1, 2, sh.getMaxRows(), 1).setNumberFormat('@');
    sh.getRange(1, 4, sh.getMaxRows(), 1).setNumberFormat('@');
  }
  return sh;
}
function countRound_() {
  try { return JSON.parse(PropertiesService.getScriptProperties().getProperty('COUNT_ROUND') || 'null'); } catch (e) { return null; }
}
/** รอบนับปัจจุบัน + ช่องที่กด "นับเสร็จ" ในรอบนี้ { loc: [at, by] } */
function getCountState() {
  const round = countRound_(), marks = {};
  const sh = book_().getSheetByName(MARK_SHEET);
  if (sh && sh.getLastRow() > 1) {
    sh.getRange(2, 1, sh.getLastRow() - 1, MARK_HEADERS.length).getValues().forEach(function (r) {
      const at = fmt_(r[0]), loc = String(r[1] || '');
      if (!loc || (round && round.start && at < round.start)) return;
      if (String(r[2]) === '1' || r[2] === true || r[2] === 1) marks[loc] = [at, String(r[3] || '')]; else delete marks[loc];
    });
  }
  return { round: round, marks: marks, now: fmt_(new Date()) };
}
/** เริ่มรอบนับใหม่: start = 'yyyy-MM-dd HH:mm' (ว่าง = ตอนนี้) */
function setCountRound(opt, by) {
  opt = opt || {};
  const start = clean_(opt.start, 16) || fmt_(new Date()).slice(0, 16);
  if (!/^\d{4}-\d\d-\d\d \d\d:\d\d$/.test(start)) throw new Error('รูปแบบเวลาไม่ถูกต้อง');
  const round = { start: start + ':00', name: clean_(opt.name, 60), by: clean_(by, 60), at: fmt_(new Date()) };
  PropertiesService.getScriptProperties().setProperty('COUNT_ROUND', JSON.stringify(round));
  return getCountState();
}
/** กด / ยกเลิก "นับช่องนี้เสร็จ" */
function markBinCounted(loc, done, by) {
  loc = clean_(loc, 30);
  if (!/^[A-Z]{2}-\d{2}-\d{2}[A-Z]$/.test(loc)) throw new Error('Location ไม่ถูกต้อง');
  const sh = markSheet_();
  sh.getRange(sh.getLastRow() + 1, 1, 1, MARK_HEADERS.length).setValues([[fmt_(new Date()), loc, done ? 1 : 0, clean_(by, 60)]]);
  return getCountState();
}


// ======================= ความเคลื่อนไหว Kingdee =======================
// ตัวตั้งเวลา (ทุก 10 นาที) ดึงยอด Kingdee จาก OnHand-Inventory-Planner → เทียบกับรอบก่อน → บันทึกส่วนที่เปลี่ยนลงชีต KingdeeMoves
// ครั้งแรก: เปิด Apps Script editor → เลือกฟังก์ชัน setupKingdeeTrigger → Run → อนุญาตสิทธิ์ (ดึง URL ภายนอก + ตั้งเวลา)
const KD_SOURCE_URL = 'https://somrudeebanthao09.github.io/OnHand-Inventory-Planner/OnHandSeed.js';
const KD_SNAP_SHEET = 'KingdeeSnap';
const KD_SNAP_HEADERS = ['key', 'location', 'part_code', 'lot_no', 'qty', 'unit', 'part_name'];
const KD_MOVE_SHEET = 'KingdeeMoves';
const KD_MOVE_HEADERS = ['at', 'type', 'part_code', 'lot_no', 'location_from', 'location_to', 'qty', 'unit', 'part_name', 'detected_at'];
const KD_BIN_RE = /^[A-Z]{2}-\d{2}-\d{2}[A-Z]$/;

/** รันครั้งเดียวจาก editor: ขอสิทธิ์ + ตั้งเวลาดึงทุก 10 นาที + ดึงรอบแรก */
function setupKingdeeTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) { if (t.getHandlerFunction() === 'kingdeePoll') ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('kingdeePoll').timeBased().everyMinutes(10).create();
  return kingdeePoll();
}

function kdSheet_(name, headers) {
  const ss = book_();
  let sh = ss.getSheetByName(name);
  if (!sh) sh = ss.insertSheet(name);
  if (sh.getLastRow() === 0) {
    sh.getRange(1, 1, 1, headers.length).setValues([headers]);
    sh.setFrozenRows(1);
  }
  return sh;
}

/** ดึงยอดล่าสุด → เทียบรอบก่อน → บันทึกความเคลื่อนไหว (ตัวตั้งเวลาเรียกทุก 10 นาที) */
function kingdeePoll() {
  const props = PropertiesService.getScriptProperties();
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) return { skipped: 'busy' };
  try {
    const res = UrlFetchApp.fetch(KD_SOURCE_URL + '?t=' + Date.now(), { muteHttpExceptions: true });
    props.setProperty('KD_LAST_POLL', fmt_(new Date()));
    if (res.getResponseCode() !== 200) throw new Error('HTTP ' + res.getResponseCode());
    const text = res.getContentText();
    const d = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1));
    const snapAt = d.snapshotAt ? fmt_(new Date(d.snapshotAt)) : fmt_(new Date());
    if (snapAt === props.getProperty('KD_SNAP_AT')) { props.deleteProperty('KD_POLL_ERR'); return { skipped: 'same snapshot', snapAt: snapAt }; }
    // ยอดปัจจุบัน: รวมตาม ช่อง|รหัส|Lot
    const cur = {};
    (d.inventory || []).forEach(function (r) {
      const loc = String(r.storage || '').trim(); if (!KD_BIN_RE.test(loc)) return;
      const q = Number(r.onHandQty != null ? r.onHandQty : r.onHand) || 0; if (!q) return;
      const part = String(r.partCode || r.materialCode || '').trim(), lot = String(r.lotNumber || '').trim();
      const k = loc + '|' + part + '|' + lot;
      const e = cur[k] || (cur[k] = { loc: loc, part: part, lot: lot, q: 0, unit: String(r.unit || ''), name: String(r.partName || r.materialName || '') });
      e.q += q;
    });
    // ยอดรอบก่อน
    const snapSh = kdSheet_(KD_SNAP_SHEET, KD_SNAP_HEADERS);
    const prev = {};
    if (snapSh.getLastRow() > 1) snapSh.getRange(2, 1, snapSh.getLastRow() - 1, KD_SNAP_HEADERS.length).getValues().forEach(function (r) {
      if (r[0]) prev[String(r[0])] = { loc: String(r[1]), part: String(r[2]), lot: String(r[3]), q: Number(r[4]) || 0, unit: String(r[5]), name: String(r[6]) };
    });
    const nPrev = Object.keys(prev).length, nCur = Object.keys(cur).length;
    // กันข้อมูลต้นทางผิดปกติ (ไฟล์ว่าง / หายไปเกินครึ่ง) ไม่ให้กลายเป็น "ของออก" ทั้งคลัง
    if (nPrev > 100 && nCur < nPrev * 0.5) throw new Error('ข้อมูลต้นทางลดลงผิดปกติ (' + nPrev + ' → ' + nCur + ') ข้ามรอบนี้');
    const moves = nPrev ? kdDiff_(prev, cur) : [];
    if (moves.length) {
      const mv = kdSheet_(KD_MOVE_SHEET, KD_MOVE_HEADERS), now = fmt_(new Date());
      const rows = moves.map(function (m) { return [snapAt, m.type, m.part, m.lot, m.from, m.to, m.q, m.unit, m.name, now]; });
      mv.getRange(mv.getLastRow() + 1, 1, rows.length, KD_MOVE_HEADERS.length).setNumberFormat('@').setValues(rows.map(function (r) {
        return r.map(function (v, i) { return i === 6 ? v : String(v); });
      }));
    }
    // เก็บยอดรอบนี้ไว้เทียบรอบหน้า
    const out = Object.keys(cur).map(function (k) { const e = cur[k]; return [k, e.loc, e.part, e.lot, e.q, e.unit, e.name]; });
    snapSh.clearContents();
    snapSh.getRange(1, 1, 1, KD_SNAP_HEADERS.length).setValues([KD_SNAP_HEADERS]);
    if (out.length) {
      snapSh.getRange(2, 1, out.length, 4).setNumberFormat('@');
      snapSh.getRange(2, 1, out.length, KD_SNAP_HEADERS.length).setValues(out);
    }
    props.setProperty('KD_SNAP_AT', snapAt);
    props.deleteProperty('KD_POLL_ERR');
    return { snapAt: snapAt, rows: nCur, moves: moves.length, first: !nPrev };
  } catch (err) {
    props.setProperty('KD_POLL_ERR', fmt_(new Date()) + ' ' + ((err && err.message) || err));
    throw err;
  } finally {
    lock.releaseLock();
  }
}

// เทียบ 2 รอบ → in (เข้า) / out (ออก) / move (รหัส+Lot เดียวกัน ลดที่ช่องหนึ่ง เพิ่มอีกช่องในรอบเดียวกัน)
function kdDiff_(prev, cur) {
  const byPL = {}, seen = {};
  Object.keys(prev).concat(Object.keys(cur)).forEach(function (k) {
    if (seen[k]) return; seen[k] = 1;
    const a = prev[k], b = cur[k], e = b || a;
    const delta = Math.round(((b ? b.q : 0) - (a ? a.q : 0)) * 1e6) / 1e6;
    if (!delta) return;
    const pl = e.part + '|' + e.lot, g = byPL[pl] || (byPL[pl] = { dec: [], inc: [] });
    const it = { loc: e.loc, part: e.part, lot: e.lot, q: Math.abs(delta), unit: e.unit, name: e.name };
    (delta < 0 ? g.dec : g.inc).push(it);
  });
  const out = [];
  Object.keys(byPL).forEach(function (pl) {
    const g = byPL[pl];
    g.dec.sort(function (x, y) { return y.q - x.q; }); g.inc.sort(function (x, y) { return y.q - x.q; });
    g.dec.forEach(function (dn) {
      g.inc.forEach(function (up) {
        if (dn.q <= 1e-9 || up.q <= 1e-9) return;
        const q = Math.min(dn.q, up.q);
        out.push({ type: 'move', part: dn.part, lot: dn.lot, from: dn.loc, to: up.loc, q: q, unit: dn.unit, name: dn.name });
        dn.q -= q; up.q -= q;
      });
    });
    g.dec.forEach(function (x) { if (x.q > 1e-9) out.push({ type: 'out', part: x.part, lot: x.lot, from: x.loc, to: '', q: x.q, unit: x.unit, name: x.name }); });
    g.inc.forEach(function (x) { if (x.q > 1e-9) out.push({ type: 'in', part: x.part, lot: x.lot, from: '', to: x.loc, q: x.q, unit: x.unit, name: x.name }); });
  });
  return out;
}

/** ความเคลื่อนไหว Kingdee ล่าสุด (ใหม่ → เก่า) + สถานะตัวดึง */
function getKingdeeMoves(opt) {
  opt = opt || {};
  const props = PropertiesService.getScriptProperties();
  const since = clean_(opt.since, 19), until = clean_(opt.until, 19), loc = clean_(opt.loc, 30), limit = Math.min(Number(opt.limit) || 300, 3000);
  const out = [];
  const sh = book_().getSheetByName(KD_MOVE_SHEET);
  if (sh && sh.getLastRow() > 1) {
    const vals = sh.getRange(2, 1, sh.getLastRow() - 1, KD_MOVE_HEADERS.length).getValues();
    for (let i = vals.length - 1; i >= 0 && out.length < limit; i--) {
      const r = vals[i], at = fmt_(r[0]);
      if (since && at < since) break;
      if (until && at >= until) continue;
      if (loc && String(r[4]) !== loc && String(r[5]) !== loc) continue;
      out.push([at, String(r[1]), String(r[2]), String(r[3]), String(r[4]), String(r[5]), Number(r[6]) || 0, String(r[7]), String(r[8])]);
    }
  }
  // จับคู่กับการสแกนในแอป (วันทำงานเดียวกัน · ไม่นับผู้ทดสอบ)
  const appOnly = [];
  if (out.length || opt.appOnly !== false) {
    const testRe = /test|ทดสอบ/i, today = workShift_(fmt_(new Date())).date, idx = {}, days = {};
    out.forEach(function (m) { days[workShift_(m[0]).date] = 1; });
    days[today] = 1;
    const appMoves = [];
    readLog_().forEach(function (e) {
      const at = fmt_(e.at), ev = String(e.event); if (!at || ev.indexOf('photo') === 0 || testRe.test(String(e.by || ''))) return;
      const day = workShift_(at).date; if (!days[day]) return;
      const part = String(e.part_code || ''), from = String(e.location_from || ''), to = String(e.location_to || '');
      if (to) idx[day + '|' + part + '|to|' + to] = 1;
      if (from) idx[day + '|' + part + '|from|' + from] = 1;
      if (ev === 'move' && day === today) appMoves.push([at, part, from, to, String(e.by || '')]);
    });
    const kdIdx = {};
    out.forEach(function (m) {
      const day = workShift_(m[0]).date, t = m[1], part = m[2], from = m[4], to = m[5];
      if (from) kdIdx[day + '|' + part + '|' + from] = 1;
      if (to) kdIdx[day + '|' + part + '|' + to] = 1;
      const ok = t === 'move' ? !!(idx[day + '|' + part + '|from|' + from] || idx[day + '|' + part + '|to|' + to])
        : t === 'in' ? !!idx[day + '|' + part + '|to|' + to] : !!idx[day + '|' + part + '|from|' + from];
      m.push(ok ? 'ok' : 'kd_only');
    });
    appMoves.forEach(function (a) {
      if (!kdIdx[today + '|' + a[1] + '|' + a[2]] && !kdIdx[today + '|' + a[1] + '|' + a[3]]) appOnly.push(a);
    });
    appOnly.reverse();
  }
  return { moves: out, appOnly: appOnly.slice(0, 100), snapAt: props.getProperty('KD_SNAP_AT') || '', lastPoll: props.getProperty('KD_LAST_POLL') || '', err: props.getProperty('KD_POLL_ERR') || '' };
}


// ======================= นับจากรูป (สอนเองที่หน้างาน) =======================
// CountProfiles: แม่แบบที่สอนแล้วต่อรหัสพาร์ท (ทุกเครื่องใช้ร่วมกัน)
// CountSamples + โฟลเดอร์ "PDA Count Samples": รูป + ตำแหน่งชิ้นงานที่คนยืนยันแล้ว → ใช้เทรนโมเดลภายหลัง
const CNT_PROF_SHEET = 'CountProfiles';
const CNT_PROF_HEADERS = ['part_code', 'updated_at', 'updated_by', 'uses', 'profile_json'];
const CNT_SAMPLE_SHEET = 'CountSamples';
const CNT_SAMPLE_HEADERS = ['at', 'part_code', 'count', 'auto', 'added', 'removed', 'threshold', 'by', 'file_id', 'file_url', 'width', 'height', 'obj_w', 'obj_h', 'points_json'];

function cntSheet_(name, headers, textCols) {
  const ss = book_();
  let sh = ss.getSheetByName(name);
  if (!sh) sh = ss.insertSheet(name);
  if (sh.getLastRow() === 0) {
    sh.getRange(1, 1, 1, headers.length).setValues([headers]);
    sh.setFrozenRows(1);
    (textCols || []).forEach(function (c) { sh.getRange(1, headers.indexOf(c) + 1, sh.getMaxRows(), 1).setNumberFormat('@'); });
  }
  return sh;
}
function cntFolder_() {
  const props = PropertiesService.getScriptProperties();
  const id = props.getProperty('COUNT_FOLDER_ID');
  if (id) { try { return DriveApp.getFolderById(id); } catch (e) { /* ถูกลบ → สร้างใหม่ */ } }
  const folder = DriveApp.createFolder('PDA Count Samples');
  props.setProperty('COUNT_FOLDER_ID', folder.getId());
  return folder;
}

/** แม่แบบที่สอนแล้วของรหัสพาร์ทนี้ (ไม่มี = null) */
function getCountProfile(part) {
  part = clean_(part, 80).toUpperCase(); if (!part) return null;
  const sh = book_().getSheetByName(CNT_PROF_SHEET);
  if (!sh || sh.getLastRow() < 2) return null;
  const vals = sh.getRange(2, 1, sh.getLastRow() - 1, CNT_PROF_HEADERS.length).getValues();
  for (let i = 0; i < vals.length; i++) {
    if (String(vals[i][0]).toUpperCase() === part) {
      let prof = null; try { prof = JSON.parse(String(vals[i][4] || 'null')); } catch (e) { prof = null; }
      return { part: part, updated_at: fmt_(vals[i][1]), updated_by: String(vals[i][2] || ''), uses: Number(vals[i][3]) || 0, profile: prof };
    }
  }
  return null;
}

/** บันทึก/อัปเดตแม่แบบของรหัสพาร์ท */
function saveCountProfile(part, profile, by) {
  part = clean_(part, 80).toUpperCase(); if (!part) throw new Error('ไม่มีรหัสพาร์ท');
  const json = JSON.stringify(profile || {});
  if (json.length > 48000) throw new Error('ข้อมูลการสอนใหญ่เกินไป');
  const lock = LockService.getScriptLock(); lock.waitLock(20000);
  try {
    const sh = cntSheet_(CNT_PROF_SHEET, CNT_PROF_HEADERS, ['part_code', 'profile_json']);
    const n = sh.getLastRow() - 1, now = new Date();
    if (n > 0) {
      const codes = sh.getRange(2, 1, n, 4).getValues();
      for (let i = 0; i < n; i++) {
        if (String(codes[i][0]).toUpperCase() === part) {
          sh.getRange(i + 2, 2, 1, 4).setValues([[now, clean_(by, 60), (Number(codes[i][3]) || 0) + 1, json]]);
          return { part: part, uses: (Number(codes[i][3]) || 0) + 1, updated_at: fmt_(now) };
        }
      }
    }
    sh.getRange(sh.getLastRow() + 1, 1, 1, CNT_PROF_HEADERS.length).setValues([[part, now, clean_(by, 60), 1, json]]);
    return { part: part, uses: 1, updated_at: fmt_(now) };
  } finally { lock.releaseLock(); }
}

/** เก็บรูป + ตำแหน่งชิ้นงานที่ยืนยันแล้ว (ข้อมูลสำหรับเทรน) */
function saveCountSample(p) {
  p = p || {};
  if (!p.data) throw new Error('ไม่มีรูป');
  const bytes = Utilities.base64Decode(String(p.data));
  if (bytes.length > MAX_PHOTO_BYTES) throw new Error('รูปใหญ่เกิน 5MB');
  const part = clean_(p.part, 80).toUpperCase(), now = new Date();
  const name = [(part || 'NOPART').replace(/[\/:*?"<>|]/g, '_'), Utilities.formatDate(now, TZ, 'yyyyMMdd-HHmmss'), 'n' + (Number(p.count) || 0)].join('_') + '.jpg';
  const file = cntFolder_().createFile(Utilities.newBlob(bytes, 'image/jpeg', name));
  let pts = JSON.stringify(Array.isArray(p.points) ? p.points : []);
  if (pts.length > 48000) pts = pts.slice(0, 48000);
  const sh = cntSheet_(CNT_SAMPLE_SHEET, CNT_SAMPLE_HEADERS, ['part_code', 'points_json']);
  sh.getRange(sh.getLastRow() + 1, 1, 1, CNT_SAMPLE_HEADERS.length).setValues([[
    now, part, Number(p.count) || 0, Number(p.auto) || 0, Number(p.added) || 0, Number(p.removed) || 0, Number(p.thr) || 0,
    clean_(p.by, 60), file.getId(), file.getUrl(), Number(p.w) || 0, Number(p.h) || 0, Number(p.objW) || 0, Number(p.objH) || 0, pts]]);
  return { file_id: file.getId(), at: fmt_(now) };
}
