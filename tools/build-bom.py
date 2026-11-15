# สร้าง js/bom.js จาก "BOM Maintenance List.xlsx" (Kingdee Export list_BOM Maintenance List)
# เก็บเฉพาะ รหัส → [Child Item Name, Specification]   ใช้เมื่อ BOM เปลี่ยน:  python tools/build-bom.py
import json, os, warnings, openpyxl
warnings.filterwarnings('ignore')
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ws = openpyxl.load_workbook(os.path.join(ROOT, 'BOM Maintenance List.xlsx'), read_only=True).worksheets[0]
rows = ws.iter_rows(values_only=True)
head = [str(h or '').strip() for h in next(rows)]
ci, ni, si = head.index('Child Item Code'), head.index('Child Item Name'), head.index('Specification')
pi, pn = head.index('Product Code'), head.index('Product Name')
bom, prod = {}, {}
for r in rows:
    code = str(r[ci] or '').strip()
    if code and code not in bom:
        bom[code] = [str(r[ni] or '').strip(), str(r[si] or '').strip()]
    p = str(r[pi] or '').strip()
    if p and p not in prod:
        prod[p] = [str(r[pn] or '').strip(), '']
for p, v in prod.items():  # รหัสสินค้าแม่ที่ไม่เคยเป็นลูก → มีแต่ชื่อ
    bom.setdefault(p, v)
with open(os.path.join(ROOT, 'js', 'bom.js'), 'w', encoding='utf-8') as f:
    f.write('// สร้างอัตโนมัติจาก BOM Maintenance List.xlsx ด้วย tools/build-bom.py — ห้ามแก้มือ\n')
    f.write('// รหัสสินค้า → [Child Item Name, Specification]\n')
    f.write('window.BOM = ' + json.dumps(bom, ensure_ascii=False, separators=(',', ':')) + ';\n')
print(len(bom), 'items')
