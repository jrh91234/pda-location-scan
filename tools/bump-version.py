# ตั้งเลขเวอร์ชันใหม่ก่อน push ทุกครั้งที่แก้หน้าเว็บ:  python tools/bump-version.py
# - version.json        → เครื่องที่เปิดเว็บค้างไว้จะเห็นว่ามีเวอร์ชันใหม่ แล้วโหลดใหม่เอง
# - js/app.js APP_VERSION
# - index.html ?v=...   → บังคับให้เบราว์เซอร์โหลดไฟล์ js/css ใหม่ (ไม่ใช้ cache เก่า)
import datetime, json, os, re
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
v = datetime.datetime.now().strftime('%Y%m%d-%H%M')

def edit(rel, fn):
    p = os.path.join(ROOT, rel)
    s = open(p, encoding='utf-8').read()
    open(p, 'w', encoding='utf-8', newline='').write(fn(s))

edit('index.html', lambda s: re.sub(r'\.(js|css)(\?v=[\w-]+)?"', lambda m: '.' + m.group(1) + '?v=' + v + '"', s))
edit('js/app.js', lambda s: re.sub(r"var APP_VERSION = '[^']*';", "var APP_VERSION = '" + v + "';", s))
with open(os.path.join(ROOT, 'version.json'), 'w', encoding='utf-8') as f:
    json.dump({'version': v}, f)
    f.write('\n')
print('version', v)
