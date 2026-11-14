/**
 * PDA Location Scan — สแกน QR สินค้า + บันทึก Location (Zebra TN28 / DataWedge)
 * Backend: Google Apps Script + Google Sheets
 *
 * หน้าเว็บ (GitHub Pages) ส่ง POST { action, args: [...] } แบบ text/plain → ตอบ { ok, data } หรือ { ok:false, error }
 */

// ======================= ค่าคงที่ =======================
const SHEET_NAME = 'Scans';
const HEADERS = ['scan_id', 'scanned_at', 'saved_at', 'location', 'qr_raw', 'part_code', 'lot_no', 'qty', 'unit',
                 'pkg_ref', 'scanned_by', 'device', 'status', 'deleted_by', 'deleted_at', 'delete_reason'];
// คอลัมน์ที่ต้องเก็บเป็นข้อความ (กันเลข 0 นำหน้าหาย / กัน Sheets แปลงเป็นวันที่หรือตัวเลข)
const TEXT_COLS = ['scan_id', 'location', 'qr_raw', 'part_code', 'lot_no', 'pkg_ref', 'scanned_by', 'device'];
const TZ = 'Asia/Bangkok';
const MAX_BATCH = 50;

// ======================= Web App =======================
const API_ACTIONS = { ping: ping, saveScans: saveScans, listScans: listScans, deleteScan: deleteScan };

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
  SpreadsheetApp.getUi().alert('พร้อมใช้งาน: สร้างชีต "' + SHEET_NAME + '" แล้ว');
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
  return sh && sh.getLastRow() > 0 ? sh : setup_();
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
    deleted_at: fmt_(o.deleted_at), delete_reason: String(o.delete_reason || '')
  };
}

function clean_(v, max) {
  return String(v == null ? '' : v).replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, max || 200);
}

function allowDuplicate_() {
  return PropertiesService.getScriptProperties().getProperty('ALLOW_DUPLICATE_QR') === 'true';
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
      const qr = clean_(it.qr_raw, 500);
      const loc = clean_(it.location, 40).toUpperCase();
      if (!id || !qr || !loc) { results.push({ scan_id: id, result: 'invalid', error: 'ข้อมูลไม่ครบ (QR / Location)' }); return; }
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
        status: 'active', deleted_by: '', deleted_at: '', delete_reason: ''
      };
      toAppend.push(HEADERS.map(function (h) { return rec[h]; }));
      byId[id] = rec;
      activeByQr[qr] = rec;
      results.push({ scan_id: id, result: 'saved', record: toClient_(rec) });
    });

    if (toAppend.length) {
      sh.getRange(sh.getLastRow() + 1, 1, toAppend.length, HEADERS.length).setValues(toAppend);
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
  const limit = Math.min(Number(filter.limit) || 300, 2000);
  const loc = clean_(filter.location, 40).toUpperCase();
  const user = clean_(filter.user, 60).toLowerCase();
  const q = clean_(filter.q, 80).toLowerCase();
  const date = clean_(filter.date, 10);
  const rows = readAll_(sheet_()).map(toClient_);
  const out = [];
  let total = 0;
  const locs = {}, parts = {};
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i];
    if (!filter.includeDeleted && r.status === 'deleted') continue;
    if (date && r.scanned_at.slice(0, 10) !== date) continue;
    if (loc && r.location.indexOf(loc) !== 0) continue;
    if (user && r.scanned_by.toLowerCase().indexOf(user) < 0) continue;
    if (q && (r.qr_raw + ' ' + r.part_code + ' ' + r.lot_no).toLowerCase().indexOf(q) < 0) continue;
    if (r.status !== 'deleted') {
      total++;
      locs[r.location] = 1;
      parts[r.part_code] = 1;
    }
    if (out.length < limit) out.push(r);
  }
  return { rows: out, total: total, partCount: Object.keys(parts).length, locationCount: Object.keys(locs).length };
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
    return toClient_(row);
  } finally {
    lock.releaseLock();
  }
}
