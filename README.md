# PDA Location Scan

เว็บแอปสำหรับ **Zebra TN28** (Android 13): ใช้หัวสแกนของเครื่องสแกน QR สินค้า แล้วบันทึกว่าสินค้าอยู่ **Location** ไหน และลบรายการที่บันทึกผิดได้

- **หน้าเว็บ:** GitHub Pages (HTML/JS ล้วน ไม่ต้อง build)
- **ฐานข้อมูล:** Google Sheet (ชีต `Scans`)
- **Backend:** Google Apps Script (`appscript/`) ซึ่ง GitHub Actions จะ deploy ให้อัตโนมัติ (ใช้ระบบเดียวกับ WH-part-preparing)

---

## การใช้งานบนเครื่อง

1. เปิดเว็บใน Chromium บน TN28 แล้วใส่ **ชื่อผู้สแกน** (ระบบจำไว้ในเครื่อง)
2. **เลือก Location** ได้ 2 วิธี
   - สแกน QR/บาร์โค้ดของ Location (เช่น `CO-01-05A`) แอปจะรู้เองว่าเป็น Location
   - กดปุ่ม **เลือก Location** แล้วเลือก Zone (CO / CP / CQ) → Rack → ช่อง หรือพิมพ์ค้นหา
3. กดปุ่มสแกนข้างเครื่องเพื่อสแกน QR สินค้า แอปจะบันทึกลง Location ที่เลือกอยู่ทันที พร้อมเสียงและแรงสั่น
   - เสียงสั้นเสียงเดียว = บันทึกสำเร็จ
   - เสียงต่ำสองครั้ง = ผิดพลาด (ยังไม่ได้เลือก Location, สแกนซ้ำ ฯลฯ)
4. Location จะค้างไว้ สแกนสินค้าต่อได้เรื่อยๆ จนกว่าจะเปลี่ยน Location
5. **ลบรายการที่ผิด:** กด **ลบ** ที่รายการล่าสุดในหน้าสแกน หรือที่หน้า **ประวัติ / ลบ** (ค้นหาตามวันที่ Location ผู้สแกน หรือรหัสสินค้าได้) แล้วเลือกเหตุผลก่อนยืนยัน

### กติกาที่ระบบบังคับ
- **ลบแบบ soft delete:** แถวในชีตยังอยู่ แต่ `status = deleted` พร้อมบันทึกว่าใครลบ ลบเมื่อไร และเหตุผล จึงตรวจสอบย้อนหลังได้
- **QR ซ้ำ:** QR เดียวกันบันทึกได้ครั้งเดียว (ป้ายแต่ละถุง/กล่องมีรหัสไม่ซ้ำกัน) ถ้าสแกน QR ที่อยู่ Location อื่นแล้ว จะมีปุ่ม **ย้ายมาที่ …** ให้กด ระบบจะลบรายการเดิมพร้อมเหตุผล "ย้าย Location" แล้วบันทึกใหม่ให้
  ถ้า QR เป็นรหัสสินค้าที่ใช้ซ้ำได้ ให้ตั้ง Script Property `ALLOW_DUPLICATE_QR = true`
- **เน็ตหลุด:** รายการจะเข้าคิว "รอส่ง" ในเครื่อง และส่งให้อัตโนมัติทุก 8 วินาทีเมื่อเน็ตกลับมา (ห้ามล้างข้อมูลเบราว์เซอร์ระหว่างที่ยังมีรายการรอส่ง) แต่ละรายการมี `scan_id` ที่เครื่องสร้างเอง ส่งซ้ำได้โดยไม่เกิดข้อมูลซ้ำ

### รูปแบบ QR ที่แยกข้อมูลให้อัตโนมัติ
| รูปแบบ | ตัวอย่าง |
|---|---|
| ป้าย Warehouse `รหัส*Lot*จำนวน*แพ็กเกจ` | `1005QT00197*2026083001*10*0002-2` |
| JSON | `{"materialCode":"X","lotNumber":"L1","quantity":5}` |
| ข้อความ `ชื่อ: ค่า` คั่นด้วย `\|` | `Material code: X\|Lot: L1\|Qty: 5` |
| อื่นๆ | เก็บข้อความทั้งหมดเป็นรหัสสินค้า |

ข้อความดิบจาก QR เก็บไว้ครบในคอลัมน์ `qr_raw` เสมอ

---

## ตั้งค่า DataWedge บน TN28 (ทำครั้งเดียวต่อเครื่อง)

ให้หัวสแกน "พิมพ์" ค่าที่สแกนลงช่องในหน้าเว็บ แล้วกด Enter ให้เอง

1. เปิดแอป **DataWedge** → เมนู ⋮ → **New profile** → ตั้งชื่อ `PDA Scan Web`
2. **Associated apps** → เพิ่มแอป **Chromium** (เลือก package ของ Chromium ที่มีในรายการ) → Activity `*`
3. **Barcode input** → Enabled → ใน **Decoders** ให้เปิด **QR Code** ไว้ (ถ้าป้าย Location เป็นบาร์โค้ด 1D ให้เปิด Code128 ด้วย)
4. **Keystroke output** → **Enabled**
   - **Basic data formatting** → Enabled → เปิด **Send data** และ **Send ENTER key**
5. **Intent output** → ปิด
6. ถ้าแอป Kingdee มี profile ของตัวเองอยู่แล้วก็ไม่ต้องแก้ เพราะ profile แต่ละตัวผูกกับแอปของตัวเอง

ทดสอบ: เปิดหน้าเว็บ แล้วสแกนป้าย Location ตัวอักษรจะขึ้นเป็น "📍 เปลี่ยน Location เป็น …"
ถ้าตัวอักษรหายบางตัว ให้ตั้ง **Keystroke output → Inter character delay** เป็น 10–20 ms

> ช่องสแกนตั้ง `inputmode="none"` ไว้ คีย์บอร์ดบนจอจึงไม่เด้งขึ้นมาบังหน้าจอ ถ้าป้ายเสียและต้องพิมพ์รหัสเอง ให้กดปุ่ม ⌨ ข้างช่องสแกน

---

## ตั้งค่าครั้งแรก (ผู้ดูแล)

### 1. Google Sheet + Apps Script
1. สร้าง Google Sheet ใหม่ชื่อ `PDA Location Scan`
2. เปิด **ส่วนขยาย → Apps Script** → วางโค้ด `appscript/code.gs` และเปิด "Show appsscript.json" แล้ววางเนื้อหา `appscript/appsscript.json`
3. กลับไปที่ชีตแล้วรีเฟรช จะมีเมนู **PDA Scan** → กด **ตั้งค่าเริ่มต้น** → อนุญาตสิทธิ์ (ขั้นสูง → ไปที่ … → อนุญาต) ระบบจะสร้างชีต `Scans` ให้
4. Apps Script → **Deploy → New deployment → Web app**: Execute as **Me**, Who has access **Anyone** → คัดลอก URL `/exec`
5. นำ URL ไปใส่ใน `js/config.js` (`API_URL`) แล้ว commit
6. Script Properties ที่ใส่เพิ่มได้ (ไม่บังคับ)
   - `SPREADSHEET_ID`: ใช้เมื่อ script ไม่ได้ผูกอยู่กับชีต
   - `ALLOW_DUPLICATE_QR`: `true` = ยอมให้ QR ซ้ำได้

### 2. GitHub (deploy อัตโนมัติ)
1. สร้าง repo (เช่น `jrh91234/pda-location-scan`) แล้ว push โค้ดขึ้น branch `main`
2. **Settings → Pages** → Source: Deploy from branch → `main` / root
3. ตั้ง Secrets 3 ตัวสำหรับ `.github/workflows/deploy-appscript.yml`
   - `APPS_SCRIPT_ID`: ดูได้จาก Apps Script → Project Settings → Script ID
   - `APPS_SCRIPT_DEPLOYMENT_ID`: ดูได้จาก Deploy → Manage deployments (ID ของ deployment ในข้อ 1.4)
   - `CLASPRC_JSON`: ใช้ไฟล์เดียวกับ repo อื่น
     ```bash
     gh secret set CLASPRC_JSON --repo jrh91234/pda-location-scan < ~/.clasprc.json
     ```
4. ต่อไปเมื่อ push การแก้ใน `appscript/` GitHub Actions จะอัปเดต deployment เดิมให้ URL `/exec` คงเดิม

---

## เพิ่ม/แก้ Location

Location มาจาก `Storage Bin-Import Template.xlsx` (Kingdee `bd_location`) โดยใช้เฉพาะรายการที่สถานะ `Available`

1. วางไฟล์ Excel ใหม่ทับไฟล์เดิมในโฟลเดอร์นี้ (ไฟล์ Excel ไม่ขึ้น GitHub)
2. รัน
   ```bash
   python tools/build-locations.py
   ```
3. commit `js/locations.js`

---

## ทดสอบบนเครื่องคอมฯ (ไม่ต้องมี Google)

```bash
node dev/serve.js
```

เปิด http://localhost:5179 ระบบจะจำลอง Apps Script ในเบราว์เซอร์ พิมพ์ข้อความในช่องสแกนแล้วกด Enter แทนการสแกน ปุ่ม `reset mock` มุมขวาล่างใช้ล้างข้อมูลทดสอบ

## โครงสร้าง

```
index.html, css/, js/          หน้าเว็บ (GitHub Pages)
  js/config.js                   URL ของ Apps Script /exec
  js/locations.js                รายการ Location (สร้างจาก Excel)
  js/parser.js                   แยกข้อมูลจาก QR / ตรวจว่าเป็น Location ไหม
  js/app.js                      หน้าจอสแกน / ประวัติ / ลบ / คิวออฟไลน์
appscript/code.gs              API: ping, saveScans, listScans, deleteScan
tools/build-locations.py       Excel → js/locations.js
dev/                           เซิร์ฟเวอร์ + Apps Script จำลองสำหรับทดสอบ
.github/workflows/             deploy Apps Script อัตโนมัติ
```

### คอลัมน์ในชีต `Scans`
`scan_id, scanned_at, saved_at, location, qr_raw, part_code, lot_no, qty, unit, pkg_ref, scanned_by, device, status, deleted_by, deleted_at, delete_reason`
