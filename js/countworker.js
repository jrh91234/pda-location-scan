// ตัวนับชิ้นงานจากรูป (Web Worker) — หา "ชิ้นที่หน้าตาเหมือนตัวอย่าง" ทั้งรูปด้วย masked NCC + หมุนได้รอบทิศ
// ข้อความเข้า:
//   { op:'count', id, gray?:{w,h,data:Uint8Array}, boxes?:[{x,y,w,h}], tpls?:[{w,h,data}], negs?:[{w,h,data}], rot, minScore }
//   { op:'crop',  id, items:[{x,y,w,h}] }   → ตัดรูปชิ้นงาน (ไว้สอนเพิ่ม: ชิ้นที่คนเพิ่ม/ลบ)
// ตอบ: { id, cands:[{x,y,s,a}] (พิกัดรูป gray · เรียงคะแนนมาก→น้อย · ผ่าน NMS แล้ว), objW, objH, tplsOut, ms } หรือ { id, error }
'use strict';
var G = null;          // รูปขาวดำล่าสุด { w, h, d: Float32Array }
var TN = 16;           // ขนาดด้านสั้นของแม่แบบที่เก็บ (px)
var AREA_CAP = 1.0e6;  // พื้นที่รูปทำงานสูงสุด
var NANG = 12;         // จำนวนมุมหมุน (ทุก 30°)

self.onmessage = function (e) {
  var m = e.data, t0 = Date.now(), out;
  try {
    if (m.gray) G = { w: m.gray.w, h: m.gray.h, d: toF(m.gray.data) };
    if (!G) throw new Error('ยังไม่มีรูป');
    if (m.op === 'count') out = count(m);
    else if (m.op === 'crop') out = { patches: m.items.map(function (it) { return toU8(cropPatch(G, it.x, it.y, it.w, it.h)); }) };
    else throw new Error('op?');
    out.id = m.id; out.ms = Date.now() - t0;
    self.postMessage(out);
  } catch (err) { self.postMessage({ id: m.id, error: String((err && err.message) || err) }); }
};

function toF(u8) { var f = new Float32Array(u8.length); for (var i = 0; i < u8.length; i++) f[i] = u8[i]; return f; }
function toU8(P) { var u = new Uint8Array(P.d.length); for (var i = 0; i < u.length; i++) u[i] = Math.max(0, Math.min(255, Math.round(P.d[i]))); return { w: P.w, h: P.h, data: u }; }
function fromU8(t) { return { w: t.w, h: t.h, d: toF(t.data) }; }

function bil(src, x, y) {
  var W = src.w, H = src.h, d = src.d;
  if (x < 0) x = 0; if (y < 0) y = 0; if (x > W - 1) x = W - 1; if (y > H - 1) y = H - 1;
  var x0 = x | 0, y0 = y | 0, x1 = x0 + 1 < W ? x0 + 1 : x0, y1 = y0 + 1 < H ? y0 + 1 : y0, ax = x - x0, ay = y - y0;
  return (d[y0 * W + x0] * (1 - ax) + d[y0 * W + x1] * ax) * (1 - ay) + (d[y1 * W + x0] * (1 - ax) + d[y1 * W + x1] * ax) * ay;
}
// ย่อ/ขยายส่วน (sx,sy,sw,sh) ของ src เป็น ow×oh (ย่อ = เฉลี่ยพื้นที่, ขยาย = bilinear)
function resample(src, sx, sy, sw, sh, ow, oh) {
  ow = Math.max(1, Math.round(ow)); oh = Math.max(1, Math.round(oh));
  var out = new Float32Array(ow * oh), fx = sw / ow, fy = sh / oh, W = src.w, H = src.h, d = src.d;
  for (var y = 0; y < oh; y++) {
    var y0 = sy + y * fy, y1 = y0 + fy;
    for (var x = 0; x < ow; x++) {
      var x0 = sx + x * fx, x1 = x0 + fx, v;
      if (fx <= 1.5 && fy <= 1.5) v = bil(src, (x0 + x1) / 2 - 0.5, (y0 + y1) / 2 - 0.5);
      else {
        var ia = Math.max(0, Math.floor(x0)), ib = Math.min(W, Math.ceil(x1)), ja = Math.max(0, Math.floor(y0)), jb = Math.min(H, Math.ceil(y1)), s = 0, n = 0;
        for (var j = ja; j < jb; j++) { var r = j * W; for (var i = ia; i < ib; i++) { s += d[r + i]; n++; } }
        v = n ? s / n : 0;
      }
      out[y * ow + x] = v;
    }
  }
  return { w: ow, h: oh, d: out };
}
// ขยายขอบรูป m px (ใช้สีขอบเดิม) → หาชิ้นที่อยู่ชิดขอบได้
function pad(src, m) {
  var W = src.w + 2 * m, H = src.h + 2 * m, d = new Float32Array(W * H), sw = src.w, sh = src.h, sd = src.d;
  for (var y = 0; y < H; y++) {
    var yy = Math.min(sh - 1, Math.max(0, y - m)) * sw;
    for (var x = 0; x < W; x++) d[y * W + x] = sd[yy + Math.min(sw - 1, Math.max(0, x - m))];
  }
  return { w: W, h: H, d: d, m: m };
}
function diagR(base, k) { var r = 0; base.forEach(function (P) { r = Math.max(r, Math.sqrt(P.w * P.w + P.h * P.h) * k / 2); }); return Math.ceil(r) + 2; }
function scaleImg(src, f) { return resample(src, 0, 0, src.w, src.h, src.w * f, src.h * f); }
// ตัดชิ้นงานกลาง (cx,cy) ขนาด w×h → ปรับเป็นแม่แบบด้านสั้น TN
function cropPatch(src, cx, cy, w, h) {
  var k = TN / Math.min(w, h);
  return resample(src, cx - w / 2, cy - h / 2, w, h, w * k, h * k);
}

// แม่แบบหมุนมุม ang จาก patch P (P ขยาย/ย่อด้วย k ก่อน) สำหรับรูปกว้าง W
function makeTpl(P, k, ang, W) {
  var pw = P.w * k, ph = P.h * k, c = Math.cos(ang), s = Math.sin(ang);
  var R = Math.ceil(Math.sqrt(pw * pw + ph * ph) / 2);
  var vals = [], dx = [], dy = [];
  for (var v = -R; v <= R; v++) for (var u = -R; u <= R; u++) {
    var x = c * u + s * v, y = -s * u + c * v; // พิกัดในชิ้นงานที่ยังไม่หมุน (หน่วยรูปทำงาน)
    if (x < -pw / 2 || x > pw / 2 || y < -ph / 2 || y > ph / 2) continue;
    vals.push(bil(P, (x + pw / 2) / k - 0.5, (y + ph / 2) / k - 0.5)); dx.push(u); dy.push(v);
  }
  var n = vals.length; if (n < 12) return null;
  var m = 0, i; for (i = 0; i < n; i++) m += vals[i]; m /= n;
  var ss = 0; for (i = 0; i < n; i++) { vals[i] -= m; ss += vals[i] * vals[i]; }
  if (ss < n * 9) return null; // แม่แบบเรียบเกินไป (ไม่มีลาย)
  var kk = 1 / Math.sqrt(ss), t = new Float32Array(n), o = new Int32Array(n);
  for (i = 0; i < n; i++) { t[i] = vals[i] * kk; o[i] = dy[i] * W + dx[i]; }
  return { t: t, o: o, n: n, R: R };
}
function ncc(d, p, T) {
  var o = T.o, t = T.t, n = T.n, s = 0, s2 = 0, c = 0;
  for (var k = 0; k < n; k++) { var v = d[p + o[k]]; s += v; s2 += v * v; c += t[k] * v; }
  var vr = s2 - s * s / n;
  return vr > n * 6 ? c / Math.sqrt(vr) : 0;
}
// ส่วนเบี่ยงเบนในกรอบ r รอบจุด (ข้ามพื้นเรียบเร็วๆ)
function stdMap(I, r) {
  var W = I.w, H = I.h, d = I.d, S = new Float64Array((W + 1) * (H + 1)), S2 = new Float64Array((W + 1) * (H + 1));
  for (var y = 0; y < H; y++) { var a = 0, b = 0; for (var x = 0; x < W; x++) { var v = d[y * W + x]; a += v; b += v * v; S[(y + 1) * (W + 1) + x + 1] = S[y * (W + 1) + x + 1] + a; S2[(y + 1) * (W + 1) + x + 1] = S2[y * (W + 1) + x + 1] + b; } }
  return function (x, y) {
    var x0 = Math.max(0, x - r), y0 = Math.max(0, y - r), x1 = Math.min(W, x + r + 1), y1 = Math.min(H, y + r + 1), n = (x1 - x0) * (y1 - y0);
    var s = S[y1 * (W + 1) + x1] - S[y0 * (W + 1) + x1] - S[y1 * (W + 1) + x0] + S[y0 * (W + 1) + x0];
    var s2 = S2[y1 * (W + 1) + x1] - S2[y0 * (W + 1) + x1] - S2[y1 * (W + 1) + x0] + S2[y0 * (W + 1) + x0];
    return Math.sqrt(Math.max(0, s2 / n - (s / n) * (s / n)));
  };
}
function angles(rot) { var a = []; for (var i = 0; i < (rot ? NANG : 1); i++) a.push(i * 2 * Math.PI / NANG); return a; }

// สแกนทั้งรูป: คืนจุดสูงสุดเฉพาะที่ (score ≥ minS) พร้อมแม่แบบ/มุมที่ดีที่สุด
function scan(I, T, stride, minS) {
  var W = I.w, H = I.h, d = I.d, R = 0, i;
  T.forEach(function (row) { row.forEach(function (t) { if (t && t.R > R) R = t.R; }); });
  var sd = stdMap(I, Math.max(2, R >> 1));
  var gw = Math.ceil(W / stride), gh = Math.ceil(H / stride), sc = new Float32Array(gw * gh), bt = new Int16Array(gw * gh), ba = new Int16Array(gw * gh);
  for (var y = R; y < H - R; y += stride) for (var x = R; x < W - R; x += stride) {
    if (sd(x, y) < 4) continue;
    var p = y * W + x, best = 0, bti = 0, bai = 0;
    for (var ti = 0; ti < T.length; ti++) for (var ai = 0; ai < T[ti].length; ai++) {
      var tt = T[ti][ai]; if (!tt) continue;
      var v = ncc(d, p, tt); if (v > best) { best = v; bti = ti; bai = ai; }
    }
    var g = (y / stride | 0) * gw + (x / stride | 0); sc[g] = best; bt[g] = bti; ba[g] = bai;
  }
  var peaks = [];
  for (var gy = 1; gy < gh - 1; gy++) for (var gx = 1; gx < gw - 1; gx++) {
    var gi = gy * gw + gx, s = sc[gi]; if (s < minS) continue;
    var isMax = true;
    for (var yy = -1; yy <= 1 && isMax; yy++) for (var xx = -1; xx <= 1; xx++) { if ((yy || xx) && sc[gi + yy * gw + xx] > s) { isMax = false; break; } }
    if (isMax) peaks.push({ x: gx * stride, y: gy * stride, s: s, t: bt[gi], a: ba[gi] });
  }
  peaks.sort(function (a, b) { return b.s - a.s; });
  return peaks;
}
function nms(list, dist) {
  var cell = Math.max(1, dist), grid = {}, out = [], d2 = dist * dist;
  list.forEach(function (p) {
    var cx = Math.floor(p.x / cell), cy = Math.floor(p.y / cell);
    for (var yy = cy - 1; yy <= cy + 1; yy++) for (var xx = cx - 1; xx <= cx + 1; xx++) {
      var g = grid[xx + ',' + yy]; if (!g) continue;
      for (var k = 0; k < g.length; k++) { var q = g[k], dx = q.x - p.x, dy = q.y - p.y; if (dx * dx + dy * dy < d2) return; }
    }
    (grid[cx + ',' + cy] = grid[cx + ',' + cy] || []).push(p); out.push(p);
  });
  return out;
}

// หาขนาดชิ้นงาน (ด้านสั้น หน่วย px ของรูป gray) จากแม่แบบที่เคยสอน
// ลองหลายขนาด (ถ้ามีขนาดครั้งก่อน → ลองแค่ 0.5–2 เท่าของขนาดนั้น) · หาจุดเด่นแบบหยาบ แล้วตรวจซ้ำด้วยแม่แบบละเอียด
function findScale(P, rot, hint) {
  var W = G.w, H = G.h, L = 8, best = null, A = angles(rot), nA = A.length, P2 = P.slice(0, 2);
  var Smin = Math.max(10, L * Math.sqrt(W * H / 2.5e5)), Smax = Math.min(W, H) / 2.5;
  if (hint > 0) { Smin = Math.max(Smin, hint / 2); Smax = Math.min(Smax, hint * 2); }
  function evalS(S) {
    var f = L / S, k = L / TN, I = pad(scaleImg(G, f), diagR(P2, k));
    var T = P2.map(function (B) { return A.map(function (a) { return makeTpl(B, k, a, I.w); }); });
    var pk = nms(scan(I, T, 2, 0.3), L * 0.6).slice(0, 8);
    if (pk.length < 2) return;
    // ตรวจซ้ำที่ความละเอียดเต็ม (ด้านสั้น = TN)
    var fF = Math.min(1, TN / S), kF = S * fF / TN, IF = pad(scaleImg(G, fF), diagR(P2, kF));
    var TF = P2.map(function (B) { return A.map(function (a) { return makeTpl(B, kF, a, IF.w); }); }), sum = 0;
    pk.forEach(function (c) {
      var gx = (c.x - I.m) / f, gy = (c.y - I.m) / f, cx = Math.round(gx * fF) + IF.m, cy = Math.round(gy * fF) + IF.m, bs = 0;
      for (var da = -1; da <= 1; da++) {
        if (nA === 1 && da) continue;
        var tt = TF[c.t] && TF[c.t][(c.a + da + nA) % nA]; if (!tt) continue;
        for (var dy = -2; dy <= 2; dy++) for (var dx = -2; dx <= 2; dx++) {
          var x = cx + dx, y = cy + dy; if (x < tt.R || y < tt.R || x >= IF.w - tt.R || y >= IF.h - tt.R) continue;
          var v = ncc(IF.d, y * IF.w + x, tt); if (v > bs) bs = v;
        }
      }
      sum += bs;
    });
    var m = sum / 8; // หารด้วย 8 เสมอ → ขนาดที่เจอน้อยชิ้นได้คะแนนต่ำ
    if (!best || m > best.m) best = { S: S, m: m };
  }
  for (var S = Smin; S <= Smax * 1.001; S *= (hint > 0 ? 1.15 : 1.25)) evalS(S);
  if (best) { var b0 = best.S; evalS(b0 * 1.07); evalS(b0 / 1.07); }
  return best ? best.S : null;
}

function count(m) {
  var rot = m.rot !== false, minS = m.minScore || 0.3, W = G.w, H = G.h;
  var base = [], objMin;
  if (m.boxes && m.boxes.length) {
    m.boxes.forEach(function (b) { base.push(cropPatch(G, b.x + b.w / 2, b.y + b.h / 2, b.w, b.h)); });
    var mins = m.boxes.map(function (b) { return Math.min(b.w, b.h); }).sort(function (a, b) { return a - b; });
    objMin = mins[mins.length >> 1];
  }
  (m.tpls || []).forEach(function (t) { if (base.length < 8) base.push(fromU8(t)); });
  if (!base.length) throw new Error('ต้องลากกรอบตัวอย่างอย่างน้อย 1 ชิ้น');
  if (!objMin) { objMin = findScale(base, rot, m.objHint); if (!objMin) throw new Error('หาชิ้นงานในรูปไม่เจอ — ลองลากกรอบตัวอย่าง 1 ชิ้น'); }
  // ขนาดรูปทำงาน: ให้ชิ้นงานด้านสั้น ≈ TN px (ไม่ขยายเกินรูปจริง · ไม่เกิน AREA_CAP)
  var f = Math.min(1, TN / objMin, Math.sqrt(AREA_CAP / (W * H)));
  var L = objMin * f; // ด้านสั้นชิ้นงานในรูปทำงาน
  if (L < 7) throw new Error('ชิ้นงานเล็กเกินไปในรูปนี้ — ถ่ายใกล้ขึ้นหรือถ่ายทีละส่วน');
  var I0 = scaleImg(G, f), C0 = scaleImg(I0, 0.5), A = angles(rot);
  var kF = L / TN, kC = L / 2 / TN;
  var I = pad(I0, diagR(base, kF)), C = pad(C0, diagR(base.slice(0, 2), kC)), mF = I.m, mC = C.m;
  // ขั้นหยาบ (ครึ่งขนาด) ใช้แม่แบบ 2 ตัวแรก
  var TC = base.slice(0, 2).map(function (P) { return A.map(function (a) { return makeTpl(P, kC, a, C.w); }); });
  var TF = base.map(function (P) { return A.map(function (a) { return makeTpl(P, kF, a, I.w); }); });
  var coarse = scan(C, TC, 1, Math.max(0.2, minS - 0.12)).slice(0, 2500);
  var RF = 0; TF.forEach(function (r) { r.forEach(function (t) { if (t && t.R > RF) RF = t.R; }); });
  var nA = A.length, cands = [];
  coarse.forEach(function (c) {
    var bx = 0, by = 0, bs = -1, ba = c.a, bt = c.t;
    for (var da = -1; da <= 1; da++) {
      if (nA === 1 && da) continue;
      var ai = (c.a + da + nA) % nA, tt = TF[c.t] && TF[c.t][ai]; if (!tt) continue;
      for (var dy = -2; dy <= 2; dy++) for (var dx = -2; dx <= 2; dx++) {
        var x = (c.x - mC) * 2 + mF + dx, y = (c.y - mC) * 2 + mF + dy;
        if (x < RF || y < RF || x >= I.w - RF || y >= I.h - RF) continue;
        var s = ncc(I.d, y * I.w + x, tt); if (s > bs) { bs = s; bx = x; by = y; ba = ai; }
      }
    }
    if (bs < 0) return;
    for (var ti = 0; ti < TF.length; ti++) { var t2 = TF[ti][ba]; if (!t2) continue; var s2 = ncc(I.d, by * I.w + bx, t2); if (s2 > bs) { bs = s2; bt = ti; } }
    var ox = bx - mF, oy = by - mF;
    if (bs >= minS && ox >= -1 && oy >= -1 && ox <= I0.w && oy <= I0.h) cands.push({ x: bx, y: by, s: bs, a: ba, t: bt });
  });
  cands.sort(function (a, b) { return b.s - a.s; });
  cands = nms(cands, L * 0.55);
  // ตัวอย่าง "ไม่ใช่" ที่เคยสอน: ถ้าเหมือนตัวที่ไม่ใช่มากกว่า → ตัดทิ้ง
  if (m.negs && m.negs.length) {
    var TN_ = m.negs.slice(0, 16).map(function (t) { var P = fromU8(t); return A.map(function (a) { return makeTpl(P, kF, a, I.w); }); });
    cands = cands.filter(function (c) {
      var p = c.y * I.w + c.x, nb = 0;
      TN_.forEach(function (row) { row.forEach(function (t) { if (t && c.x >= t.R && c.y >= t.R && c.x < I.w - t.R && c.y < I.h - t.R) { var v = ncc(I.d, p, t); if (v > nb) nb = v; } }); });
      return nb < c.s;
    });
  }
  var b0 = base[0], ow = b0.w * objMin / Math.min(b0.w, b0.h), oh = b0.h * objMin / Math.min(b0.w, b0.h);
  return {
    cands: cands.map(function (c) { return { x: Math.round((c.x - mF) / f * 10) / 10, y: Math.round((c.y - mF) / f * 10) / 10, s: Math.round(c.s * 1000) / 1000, a: Math.round(A[c.a] * 180 / Math.PI) }; }),
    objW: ow, objH: oh, objMin: objMin, work: [I0.w, I0.h],
    tplsOut: m.boxes && m.boxes.length ? base.slice(0, m.boxes.length).map(toU8) : []
  };
}
