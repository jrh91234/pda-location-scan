# สร้าง js/bom.js จาก "BOM Maintenance List.xlsx" (Kingdee Export list_BOM Maintenance List)
# รหัส → [Child Item Name, Specification, Issuing Organization (ลำดับใน BOM_ORG), Default Issuing Warehouse (ลำดับใน BOM_WH)]
# ใช้เมื่อ BOM เปลี่ยน:  python tools/build-bom.py
import json, os, warnings, openpyxl
warnings.filterwarnings('ignore')
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ws = openpyxl.load_workbook(os.path.join(ROOT, 'BOM Maintenance List.xlsx'), read_only=True).worksheets[0]
rows = ws.iter_rows(values_only=True)
head = [str(h or '').strip() for h in next(rows)]
ci, ni, si = head.index('Child Item Code'), head.index('Child Item Name'), head.index('Specification')
pi, pn = head.index('Product Code'), head.index('Product Name')
oi, wi = head.index('Issuing Organization'), head.index('Default Issuing Warehouse')
orgs, whs = [''], ['']
def idx(lst, v):
    if v not in lst: lst.append(v)
    return lst.index(v)
bom, prod = {}, {}
for r in rows:
    code = str(r[ci] or '').strip()
    if code:
        org, wh = str(r[oi] or '').strip(), str(r[wi] or '').strip()
        if code not in bom:
            bom[code] = [str(r[ni] or '').strip(), str(r[si] or '').strip(), idx(orgs, org), idx(whs, wh)]
        elif not bom[code][3] and (org or wh):  # แถวแรกว่าง → ใช้แถวที่มีค่า
            bom[code][2], bom[code][3] = idx(orgs, org), idx(whs, wh)
    p = str(r[pi] or '').strip()
    if p and p not in prod:
        prod[p] = [str(r[pn] or '').strip(), '', 0, 0]
for p, v in prod.items():  # รหัสสินค้าแม่ที่ไม่เคยเป็นลูก → มีแต่ชื่อ
    bom.setdefault(p, v)
with open(os.path.join(ROOT, 'js', 'bom.js'), 'w', encoding='utf-8') as f:
    f.write('// สร้างอัตโนมัติจาก BOM Maintenance List.xlsx ด้วย tools/build-bom.py — ห้ามแก้มือ\n')
    f.write('// รหัสสินค้า → [Child Item Name, Specification, Issuing Organization (BOM_ORG), Default Issuing Warehouse (BOM_WH)]\n')
    f.write('window.BOM_ORG = ' + json.dumps(orgs, ensure_ascii=False) + ';\n')
    f.write('window.BOM_WH = ' + json.dumps(whs, ensure_ascii=False) + ';\n')
    f.write('window.BOM = ' + json.dumps(bom, ensure_ascii=False, separators=(',', ':')) + ';\n')
print(len(bom), 'items,', len(orgs) - 1, 'orgs,', len(whs) - 1, 'warehouses')
