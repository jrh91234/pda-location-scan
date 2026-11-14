// ======================= เชื่อมต่อ Apps Script API =======================
// ส่ง POST แบบ text/plain (ไม่เกิด CORS preflight) → Apps Script ตอบ JSON { ok, data | error }

function store(key, value) {
  try {
    if (value === undefined) return localStorage.getItem(key);
    if (value === null) localStorage.removeItem(key); else localStorage.setItem(key, value);
  } catch (e) { return null; }
}

function storeJson(key, value) {
  if (value === undefined) {
    try { return JSON.parse(store(key) || 'null'); } catch (e) { return null; }
  }
  store(key, value === null ? null : JSON.stringify(value));
}

function apiUrl() {
  return store('pda_api_url') || (window.PDA_CONFIG && window.PDA_CONFIG.API_URL) || '';
}

function withNonce(url) {
  return url + (url.indexOf('?') >= 0 ? '&' : '?') + '_r=' + Date.now() + Math.random().toString(36).slice(2, 8);
}

function api(action) {
  var args = Array.prototype.slice.call(arguments, 1);
  var url = apiUrl();
  if (!url) return Promise.reject(new Error('ยังไม่ได้ตั้งค่า API URL (กด ⚙)'));
  var ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
  var timer = ctrl && setTimeout(function () { ctrl.abort(); }, 30000);
  return fetch(withNonce(url), {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify({ action: action, args: args }),
    redirect: 'follow',
    cache: 'no-store',
    signal: ctrl ? ctrl.signal : undefined
  }).then(function (res) {
    return res.text().then(function (text) {
      try { return JSON.parse(text); } catch (e) { throw new Error('เซิร์ฟเวอร์ตอบกลับผิดรูปแบบ (HTTP ' + res.status + ')'); }
    });
  }, function () {
    var err = new Error('เชื่อมต่อเซิร์ฟเวอร์ไม่ได้ ตรวจสอบอินเทอร์เน็ต');
    err.network = true;
    throw err;
  }).then(function (res) {
    if (timer) clearTimeout(timer);
    if (!res.ok) throw new Error(res.error || 'เกิดข้อผิดพลาด');
    return res.data;
  }, function (err) {
    if (timer) clearTimeout(timer);
    throw err;
  });
}
