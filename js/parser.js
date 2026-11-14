// ======================= แยกข้อมูลจาก QR =======================
// รองรับ:
//  1) ป้าย Warehouse  MaterialCode*LotNumber*Quantity*PackageRef  เช่น 1005QT00197*2026083001*10*0002-2
//  2) JSON  {"materialCode":"...","lotNumber":"...","quantity":10,"unit":"EA"}
//  3) ข้อความ  Material code: X|Lot: Y|Qty: 10
//  4) อย่างอื่น → เก็บข้อความเดิมเป็นรหัสสินค้า

var LOCATION_SET = {};
(window.LOCATIONS || []).forEach(function (c) { LOCATION_SET[c] = true; });

function normalizeScan(text) {
  // DataWedge อาจส่ง CR/LF/TAB ติดมา — ตัดออก
  return String(text || '').replace(/[\r\n\t]+/g, '').trim();
}

// ตรวจค่าที่สแกนก่อนใช้งาน
//  - อ่านซ้ำ 2 รอบติดกัน (ABCABC) → ตัดเหลือ ABC  (fixed = true)
//  - ป้าย Warehouse ที่มี * เกิน 4 ส่วน = QR 2 อันติดกัน → error ไม่ให้บันทึก (ไม่เดาว่าตัดตรงไหน)
function checkScan(raw) {
  var text = normalizeScan(raw), fixed = false;
  if (text.length >= 6 && text.length % 2 === 0) {
    var h = text.length / 2;
    if (text.slice(0, h) === text.slice(h)) { text = text.slice(0, h); fixed = true; }
  }
  var parts = text.split('*');
  if (parts.length > 4 && toQty(parts[2]) !== '') {
    return { text: text, fixed: fixed, error: 'QR ผิดรูปแบบ อาจสแกนติดกัน 2 ครั้ง — กรุณาสแกนใหม่' };
  }
  if (text.length > 300) return { text: text, fixed: fixed, error: 'ข้อความยาวผิดปกติ — กรุณาสแกนใหม่' };
  return { text: text, fixed: fixed, error: '' };
}

function asLocation(text) {
  var t = normalizeScan(text).toUpperCase();
  return LOCATION_SET[t] ? t : null;
}

var FIELD_KEYS = {
  part_code: ['materialcode', 'material', 'partcode', 'partno', 'partnumber', 'itemcode', 'code', 'รหัสพาร์ท', 'รหัสวัสดุ', 'รหัสสินค้า'],
  lot_no: ['lotnumber', 'lotno', 'lot', 'batch', 'batchno', 'ล็อต'],
  qty: ['quantity', 'qty', 'จำนวน'],
  unit: ['unit', 'uom', 'หน่วย'],
  pkg_ref: ['package', 'packageref', 'pkg', 'box', 'boxno']
};

function keyOf(k) {
  var n = String(k).toLowerCase().replace(/[\s_\-.]/g, '');
  for (var f in FIELD_KEYS) if (FIELD_KEYS[f].indexOf(n) >= 0) return f;
  return null;
}

function toQty(v) {
  var s = String(v == null ? '' : v).replace(/,/g, '').trim();
  return s !== '' && !isNaN(Number(s)) ? Number(s) : '';
}

function parseQr(raw) {
  var text = normalizeScan(raw);
  var out = { qr_raw: text, part_code: '', lot_no: '', qty: '', unit: '', pkg_ref: '', format: 'text' };
  if (!text) return out;

  // JSON
  if (text.charAt(0) === '{') {
    try {
      var obj = JSON.parse(text);
      Object.keys(obj).forEach(function (k) { var f = keyOf(k); if (f && out[f] === '') out[f] = String(obj[k]); });
      out.qty = toQty(out.qty);
      out.format = 'json';
      if (out.part_code) return finish(out);
    } catch (e) { /* ไม่ใช่ JSON */ }
  }

  // ป้าย Warehouse คั่นด้วย *
  var parts = text.split('*');
  if (parts.length >= 3 && parts.length <= 5 && parts[0] && toQty(parts[2]) !== '') {
    out.part_code = parts[0].trim();
    out.lot_no = (parts[1] || '').trim();
    out.qty = toQty(parts[2]);
    out.pkg_ref = (parts[3] || '').trim();
    out.format = 'warehouse';
    return finish(out);
  }

  // key: value | key: value
  if (/[:=]/.test(text) && /[|;\n]/.test(String(raw))) {
    String(raw).split(/[|;\n]/).forEach(function (seg) {
      var m = seg.match(/^\s*([^:=]+?)\s*[:=]\s*(.*?)\s*$/);
      if (!m) return;
      var f = keyOf(m[1]);
      if (f && out[f] === '') out[f] = m[2];
    });
    out.qty = toQty(out.qty);
    if (out.part_code) { out.format = 'fields'; return finish(out); }
  }

  out.part_code = text.slice(0, 80);
  return out;
}

function finish(out) {
  if (!out.unit && out.qty !== '') out.unit = Math.floor(out.qty) === out.qty ? 'EA' : 'kg';
  return out;
}
