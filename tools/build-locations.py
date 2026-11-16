# สร้าง js/locations.js จากไฟล์ Excel "Storage Bin-Import Template.xlsx" (Kingdee bd_location)
# ใช้เมื่อมีการเพิ่ม/ลบ Location:  python tools/build-locations.py
# - ชีตหลัก (sheet1): แบบฟอร์ม Kingdee เอาเฉพาะแถวที่สถานะ Available
# - ชีตอื่น (เช่น CA-CJ): รหัส Location อยู่คอลัมน์แรก แถวละ 1 รหัส
import json, os, re, openpyxl
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CODE = re.compile(r'^[A-Z]{2}-\d{2}-\d{2}[A-Z]$')
wb = openpyxl.load_workbook(os.path.join(ROOT, 'Storage Bin-Import Template.xlsx'), read_only=True, data_only=True)
codes, seen = [], set()
def add(c):
    c = str(c or '').strip()
    if CODE.match(c) and c not in seen:
        seen.add(c); codes.append(c)
main = wb.worksheets[0]
for row in main.iter_rows(min_row=5, values_only=True):
    if row and row[0] and str(row[3] or '').strip() == 'Available':
        add(row[0])
for ws in wb.worksheets[1:]:
    for row in ws.iter_rows(values_only=True):
        if row and row[0]:
            add(row[0])
with open(os.path.join(ROOT, 'js', 'locations.js'), 'w', encoding='utf-8') as f:
    f.write('// สร้างอัตโนมัติจาก Storage Bin-Import Template.xlsx ด้วย tools/build-locations.py — ห้ามแก้มือ\n')
    f.write('window.LOCATIONS = ' + json.dumps(codes) + ';\n')
zones = {}
for c in codes: zones[c[:2]] = zones.get(c[:2], 0) + 1
print(len(codes), 'locations', zones)
