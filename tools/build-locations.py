# สร้าง js/locations.js จากไฟล์ Excel "Storage Bin-Import Template.xlsx" (Kingdee bd_location)
# ใช้เมื่อมีการเพิ่ม/ลบ Location:  python tools/build-locations.py
import json, os, openpyxl
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ws = openpyxl.load_workbook(os.path.join(ROOT, 'Storage Bin-Import Template.xlsx')).active
codes = []
for row in ws.iter_rows(min_row=5, values_only=True):
    code, status = (row[0] or '').strip(), (row[3] or '').strip()
    if code and status == 'Available' and code not in codes:
        codes.append(code)
with open(os.path.join(ROOT, 'js', 'locations.js'), 'w', encoding='utf-8') as f:
    f.write('// สร้างอัตโนมัติจาก Storage Bin-Import Template.xlsx ด้วย tools/build-locations.py — ห้ามแก้มือ\n')
    f.write('window.LOCATIONS = ' + json.dumps(codes) + ';\n')
print(len(codes), 'locations')
