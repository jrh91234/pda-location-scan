/* จำลอง Google Apps Script services แบบง่าย สำหรับทดสอบบนเครื่อง (ไม่ใช้ตอนใช้งานจริง) */
(function () {
  var KEY = 'gasmock_book_v1';
  function revive(v) { return v && typeof v === 'object' && v.__d ? new Date(v.__d) : v; }
  function pack(v) { return v instanceof Date ? { __d: v.toISOString() } : v; }
  var saved = null;
  try { saved = JSON.parse(localStorage.getItem(KEY) || 'null'); } catch (e) {}
  var sheets = {};
  if (saved) Object.keys(saved).forEach(function (n) { sheets[n] = saved[n].map(function (r) { return r.map(revive); }); });
  function persist() {
    var o = {}; Object.keys(sheets).forEach(function (n) { o[n] = sheets[n].map(function (r) { return r.map(pack); }); });
    localStorage.setItem(KEY, JSON.stringify(o));
  }

  function Range(sh, r, c, nr, nc) { this.sh = sh; this.r = r; this.c = c; this.nr = nr; this.nc = nc; }
  Range.prototype.getValues = function () {
    var d = sheets[this.sh.name], out = [];
    for (var i = 0; i < this.nr; i++) { var row = []; for (var j = 0; j < this.nc; j++) row.push(((d[this.r - 1 + i] || [])[this.c - 1 + j]) ?? ''); out.push(row); }
    return out;
  };
  Range.prototype.setValues = function (vals) {
    var d = sheets[this.sh.name];
    if (vals.length !== this.nr || vals[0].length !== this.nc) throw new Error('mock: range size mismatch');
    for (var i = 0; i < this.nr; i++) {
      var ri = this.r - 1 + i; while (d.length <= ri) d.push([]);
      for (var j = 0; j < this.nc; j++) d[ri][this.c - 1 + j] = vals[i][j];
    }
    persist(); return this;
  };
  Range.prototype.setNumberFormat = function () { return this; };
  Range.prototype.setValue = function (v) { return this.setValues([[v]]); };

  function Sheet(name) { this.name = name; }
  Sheet.prototype.getDataRange = function () { var d = sheets[this.name]; var nc = d.reduce(function (m, r) { return Math.max(m, r.length); }, 0); return new Range(this, 1, 1, Math.max(d.length, 1), Math.max(nc, 1)); };
  Sheet.prototype.getName = function () { return this.name; };
  Sheet.prototype.getLastRow = function () { return sheets[this.name].length; };
  Sheet.prototype.getMaxRows = function () { return 1000; };
  Sheet.prototype.getRange = function (r, c, nr, nc) { return new Range(this, r, c, nr || 1, nc || 1); };
  Sheet.prototype.setFrozenRows = function () {};
  Sheet.prototype.clearContents = function () { sheets[this.name] = []; persist(); return this; };
  Sheet.prototype.deleteRow = function (r) { sheets[this.name].splice(r - 1, 1); persist(); };
  Sheet.prototype.deleteColumn = function (c) { sheets[this.name].forEach(function (row) { row.splice(c - 1, 1); }); persist(); };
  Sheet.prototype.getLastColumn = function () { return sheets[this.name].reduce(function (m, r) { return Math.max(m, r.length); }, 0); };

  var book = {
    getId: function () { return 'mock-book'; },
    getSheetByName: function (n) { return sheets[n] ? new Sheet(n) : null; },
    insertSheet: function (n) { sheets[n] = []; persist(); return new Sheet(n); }
  };
  window.SpreadsheetApp = { getActiveSpreadsheet: function () { return book; }, openById: function () { return book; } };

  function store(prefix) {
    return {
      getProperty: function (k) { return localStorage.getItem(prefix + k); },
      setProperty: function (k, v) { localStorage.setItem(prefix + k, v); },
      deleteProperty: function (k) { localStorage.removeItem(prefix + k); },
      getProperties: function () { var o = {}; for (var i = 0; i < localStorage.length; i++) { var k = localStorage.key(i); if (k.indexOf(prefix) === 0) o[k.slice(prefix.length)] = localStorage.getItem(k); } return o; }
    };
  }
  var props = store('gasmock_prop_');
  window.PropertiesService = { getScriptProperties: function () { return props; } };
  // ดึง URL ภายนอกแบบ synchronous (เหมือน UrlFetchApp) — ใช้ทดสอบ kingdeePoll
  window.UrlFetchApp = { fetch: function (url, opt) {
    var x = new XMLHttpRequest(); x.open((opt && opt.method) || 'GET', url, false); x.send();
    var heads = {}; x.getAllResponseHeaders().trim().split(/\r?\n/).forEach(function (l) { var i = l.indexOf(':'); if (i > 0) heads[l.slice(0, i).trim()] = l.slice(i + 1).trim(); });
    return { getResponseCode: function () { return x.status; }, getContentText: function () { return x.responseText; }, getHeaders: function () { return heads; } };
  } };
  var mockTriggers = [];
  window.ScriptApp = {
    getProjectTriggers: function () { return mockTriggers; },
    deleteTrigger: function (t) { mockTriggers.splice(mockTriggers.indexOf(t), 1); },
    newTrigger: function (fn) { var b = { timeBased: function () { return b; }, everyMinutes: function () { return b; },
      create: function () { var t = { getHandlerFunction: function () { return fn; } }; mockTriggers.push(t); return t; } }; return b; }
  };
  var cache = {};
  window.CacheService = { getScriptCache: function () { return { get: function (k) { return cache[k] || null; }, put: function (k, v) { cache[k] = v; }, remove: function (k) { delete cache[k]; } }; } };
  window.LockService = { getScriptLock: function () { return { tryLock: function () { return true; }, waitLock: function () {}, releaseLock: function () {} }; } };

  function fmt(d, pattern) {
    var p = {}; new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Bangkok', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })
      .formatToParts(d).forEach(function (x) { p[x.type] = x.value; });
    return pattern.replace('yyyy', p.year).replace('yy', p.year.slice(2)).replace('MM', p.month).replace('dd', p.day)
      .replace('HH', p.hour === '24' ? '00' : p.hour).replace('mm', p.minute).replace('ss', p.second);
  }
  window.Utilities = {
    DigestAlgorithm: { SHA_256: 'sha256' }, Charset: { UTF_8: 'utf8' },
    getUuid: function () { return crypto.randomUUID(); },
    computeDigest: function (alg, s) { // ไม่ใช่ SHA จริง ใช้แค่ทดสอบ
      var h = []; for (var i = 0; i < 32; i++) h.push(0);
      for (var j = 0; j < s.length; j++) { var c = s.charCodeAt(j); for (var k = 0; k < 32; k++) h[k] = (h[k] * 31 + c + k) % 256; }
      return h.map(function (b) { return b > 127 ? b - 256 : b; });
    },
    formatDate: function (d, tz, pattern) { return fmt(d, pattern); },
    parseCsv: function (text) { // CSV แบบง่าย (รองรับ "…" และ "" ภายใน)
      var out = [], row = [], cur = '', q = false;
      for (var i = 0; i < text.length; i++) {
        var ch = text[i];
        if (q) { if (ch === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += ch; }
        else if (ch === '"') q = true; else if (ch === ',') { row.push(cur); cur = ''; }
        else if (ch === '\n' || ch === '\r') { if (ch === '\r' && text[i + 1] === '\n') i++; row.push(cur); out.push(row); row = []; cur = ''; }
        else cur += ch;
      }
      if (cur !== '' || row.length) { row.push(cur); out.push(row); }
      return out;
    },
    // ไบต์จำลอง: เก็บ base64 ไว้ตรงๆ (length ≈ ขนาดไฟล์)
    base64Decode: function (s) { var o = { __b64: s, length: Math.floor(String(s).length * 3 / 4) }; return o; },
    base64Encode: function (bytes) { return bytes && bytes.__b64 || ''; },
    newBlob: function (bytes, mime, name) { return { bytes: bytes, mime: mime, name: name }; }
  };
  window.MimeType = { GOOGLE_DOCS: 'application/vnd.google-apps.document' };
  // ไฟล์จำลองเก็บใน localStorage (gasmock_files)
  var FKEY = 'gasmock_files';
  function files() { try { return JSON.parse(localStorage.getItem(FKEY) || '{}'); } catch (e) { return {}; } }
  function saveFiles(f) { localStorage.setItem(FKEY, JSON.stringify(f)); }
  function fileObj(id) {
    return {
      getId: function () { return id; },
      getUrl: function () { return 'https://drive.google.com/file/d/' + id + '/view'; },
      setTrashed: function (t) { var f = files(); if (f[id]) { f[id].trashed = t; saveFiles(f); } },
      setSharing: function (a, p) { var f = files(); if (f[id]) { f[id].sharing = a + ':' + p; saveFiles(f); } },
      moveTo: function (folder) { var f = files(); if (f[id]) { f[id].folder = folder.getId(); saveFiles(f); } },
      getBlob: function () { var r = files()[id]; if (!r) throw new Error('mock: no file'); return { getContentType: function () { return r.mime; }, getBytes: function () { return { __b64: r.b64 }; } }; }
    };
  }
  function folderObj(fid) {
    return {
      getId: function () { return fid; }, getName: function () { return 'PDA Scan Photos'; },
      createFile: function (blob) { var id = 'mockfile-' + Math.random().toString(36).slice(2, 10); var f = files(); f[id] = { mime: blob.mime, name: blob.name, b64: blob.bytes.__b64, folder: fid }; saveFiles(f); return fileObj(id); },
      createFolder: function (name) { return folderObj('mock-folder-' + name.replace(/\s+/g, '-')); },
      setSharing: function (a, p) { localStorage.setItem('gasmock_share_' + fid, a + ':' + p); }
    };
  }
  window.DriveApp = {
    Access: { ANYONE_WITH_LINK: 'ANYONE_WITH_LINK', DOMAIN_WITH_LINK: 'DOMAIN_WITH_LINK' }, Permission: { VIEW: 'VIEW' },
    createFolder: function () { return folderObj('mock-folder'); },
    getFolderById: function (id) { return folderObj(id); },
    getRootFolder: function () { return folderObj('root'); },
    getFileById: function (id) { if (!files()[id]) throw new Error('mock: no file ' + id); return fileObj(id); }
  };
  window.Drive = { Files: { insert: function () { return { id: 'mock-doc' }; } } };
  window.DocumentApp = { openById: function () { return { getBody: function () { return { getText: function () {
    // ข้อมูลสมมติสำหรับทดสอบเท่านั้น
    return '直接调拨单\n单据编号：ZJDB-000000-000001 业务类型：普通调拨\n业务日期：2026-01-01\n' +
      '9999TS00001 SAMPLE PART A TS-0001 2026010101 100.000 TEST-WH AA-01-01A TEST-LINE\n' +
      '9999TS00002 SAMPLE PART B TS-0002 2026010102 50.000 TEST-WH 公共区域 TEST-LINE\n';
  } }; } }; } };

  // ----- google.script.run: เรียกฟังก์ชันใน Code.gs + ตรวจว่าค่าที่ส่งกลับ serialize ได้ (ห้ามมี Date) -----
  function checkSerializable(v, path) {
    if (v instanceof Date) throw new Error('mock: return value contains Date at ' + path + ' (Apps Script จะส่งกลับเป็น null)');
    if (v && typeof v === 'object') Object.keys(v).forEach(function (k) { checkSerializable(v[k], path + '.' + k); });
  }
  function runner(ok, fail) {
    return new Proxy({}, { get: function (_, name) {
      if (name === 'withSuccessHandler') return function (f) { return runner(f, fail); };
      if (name === 'withFailureHandler') return function (f) { return runner(ok, f); };
      return function () {
        var args = JSON.parse(JSON.stringify(Array.prototype.slice.call(arguments)));
        setTimeout(function () {
          try {
            if (typeof window[name] !== 'function' || /_$/.test(name)) throw new Error('mock: no public server function ' + name);
            var res = window[name].apply(null, args);
            checkSerializable(res, name);
            ok && ok(res === undefined ? null : JSON.parse(JSON.stringify(res)));
          } catch (e) { console.warn('[server]', name, e.message); fail && fail(e); }
        }, 250);
      };
    } });
  }
  window.google = { script: { get run() { return runner(null, null); } } };

  // ----- ContentService + จำลอง fetch ไปที่ /exec → เรียก doPost(e) ของจริง -----
  window.ContentService = {
    MimeType: { JSON: 'application/json' },
    createTextOutput: function (s) { return { setMimeType: function () { return this; }, getContent: function () { return s; } }; }
  };
  window.MOCK_API_URL = 'https://script.google.com/macros/s/MOCK/exec';
  var realFetch = window.fetch.bind(window);
  window.fetch = function (url, opts) {
    if (String(url).indexOf(window.MOCK_API_URL) !== 0) return realFetch(url, opts);
    return new Promise(function (resolve) {
      setTimeout(function () {
        var body = window.doPost({ postData: { contents: opts && opts.body } }).getContent();
        try { checkSerializable(JSON.parse(body), 'response'); } catch (e) { console.warn(e.message); }
        resolve(new Response(body, { status: 200, headers: { 'Content-Type': 'application/json' } }));
      }, 300);
    });
  };

  window.gasMockReset = function () {
    Object.keys(localStorage).filter(function (k) { return k.indexOf('gasmock_') === 0 || k.indexOf('pda_') === 0; }).forEach(function (k) { localStorage.removeItem(k); });
    location.reload();
  };
})();
