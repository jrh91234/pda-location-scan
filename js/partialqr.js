// อ่าน QR ที่สี่เหลี่ยมมุม (finder) หาย/ขาด 1 มุม: หา finder ที่สมบูรณ์ 2 มุม → เดาตำแหน่งมุมที่ 3 → อ่านตาราง → ให้ Reed-Solomon กู้ส่วนที่ขาด
// ใช้ส่วนภายในของ jsQR (binarize / extract / decode)
(function (root) {
  function findFinders(m) {
    var W = m.width, H = m.height, cands = [];
    function runsOK(r) {
      var tot = r[0] + r[1] + r[2] + r[3] + r[4]; if (tot < 7) return 0;
      var u = tot / 7, v = u * 0.7;
      return Math.abs(r[0] - u) < v && Math.abs(r[1] - u) < v && Math.abs(r[2] - 3 * u) < 3 * v && Math.abs(r[3] - u) < v && Math.abs(r[4] - u) < v ? u : 0;
    }
    // ตรวจแนวตั้งที่ x ผ่านจุด cy
    function crossV(cx, cy, u) {
      var r = [0, 0, 0, 0, 0], y = cy;
      while (y >= 0 && m.get(cx, y)) { r[2]++; y--; }
      while (y >= 0 && !m.get(cx, y)) { r[1]++; y--; }
      while (y >= 0 && m.get(cx, y)) { r[0]++; y--; }
      var top = y + 1; y = cy + 1;
      while (y < H && m.get(cx, y)) { r[2]++; y++; }
      while (y < H && !m.get(cx, y)) { r[3]++; y++; }
      while (y < H && m.get(cx, y)) { r[4]++; y++; }
      var uu = runsOK(r); if (!uu || Math.abs(uu - u) > u * 0.6) return null;
      return { y: top + r[0] + r[1] + r[2] / 2, u: uu };
    }
    function crossH(cx, cy, u) {
      var r = [0, 0, 0, 0, 0], x = cx;
      while (x >= 0 && m.get(x, cy)) { r[2]++; x--; }
      while (x >= 0 && !m.get(x, cy)) { r[1]++; x--; }
      while (x >= 0 && m.get(x, cy)) { r[0]++; x--; }
      var left = x + 1; x = cx + 1;
      while (x < W && m.get(x, cy)) { r[2]++; x++; }
      while (x < W && !m.get(x, cy)) { r[3]++; x++; }
      while (x < W && m.get(x, cy)) { r[4]++; x++; }
      var uu = runsOK(r); if (!uu || Math.abs(uu - u) > u * 0.6) return null;
      return { x: left + r[0] + r[1] + r[2] / 2, u: uu };
    }
    for (var y = 0; y < H; y += 2) {
      var runs = [], cur = m.get(0, y), len = 0, starts = [];
      for (var x = 0; x <= W; x++) {
        var b = x < W ? m.get(x, y) : !cur;
        if (b === cur) { len++; continue; }
        runs.push({ black: cur, len: len, end: x }); cur = b; len = 1;
      }
      for (var i = 0; i + 4 < runs.length; i++) {
        if (!runs[i].black) continue;
        var r = [runs[i].len, runs[i + 1].len, runs[i + 2].len, runs[i + 3].len, runs[i + 4].len];
        var u = runsOK(r); if (!u) continue;
        var cx = Math.round(runs[i + 2].end - runs[i + 2].len / 2);
        var v = crossV(cx, y, u); if (!v) continue;
        var h = crossH(cx, Math.round(v.y), u); if (!h) continue;
        var v2 = crossV(Math.round(h.x), Math.round(v.y), u); if (!v2) continue;
        cands.push({ x: h.x, y: v2.y, u: (u + v.u + h.u + v2.u) / 4 });
      }
    }
    // รวมจุดที่ซ้อนกัน
    var cl = [];
    cands.forEach(function (c) {
      var g = cl.find(function (k) { return Math.hypot(k.x - c.x, k.y - c.y) < k.u * 3; });
      if (g) { g.sx += c.x; g.sy += c.y; g.su += c.u; g.n++; g.x = g.sx / g.n; g.y = g.sy / g.n; g.u = g.su / g.n; }
      else cl.push({ x: c.x, y: c.y, u: c.u, sx: c.x, sy: c.y, su: c.u, n: 1 });
    });
    return cl.filter(function (k) { return k.n >= 2; }).sort(function (a, b) { return b.n - a.n; });
  }


  var MOD = function (dim) { return [{ x: 3.5, y: 3.5 }, { x: dim - 3.5, y: 3.5 }, { x: 3.5, y: dim - 3.5 }]; };
  // affine จาก 3 คู่จุด (พิกัดโมดูล → พิกัดภาพ)
  function affine3(src, dst) {
    var a = src[0], b = src[1], c = src[2];
    var det = a.x * (b.y - c.y) - a.y * (b.x - c.x) + (b.x * c.y - c.x * b.y);
    if (Math.abs(det) < 1e-9) return null;
    function solve(v0, v1, v2) {
      return [(v0 * (b.y - c.y) - a.y * (v1 - v2) + (v1 * c.y - v2 * b.y)) / det,
              (a.x * (v1 - v2) - v0 * (b.x - c.x) + (b.x * v2 - c.x * v1)) / det,
              (a.x * (b.y * v2 - c.y * v1) - a.y * (b.x * v2 - c.x * v1) + v0 * (b.x * c.y - c.x * b.y)) / det];
    }
    var X = solve(dst[0].x, dst[1].x, dst[2].x), Y = solve(dst[0].y, dst[1].y, dst[2].y);
    return function (p) { return { x: X[0] * p.x + X[1] * p.y + X[2], y: Y[0] * p.x + Y[1] * p.y + Y[2] }; };
  }
  // หา alignment pattern (ดำ-ขาว-ดำ-ขาว-ดำ 1:1:1:1:1) รอบจุดที่คาด
  function findAlignment(m, c, u, R) {
    var best = null, x0 = Math.max(0, Math.floor(c.x - R)), x1 = Math.min(m.width - 1, Math.ceil(c.x + R));
    var y0 = Math.max(0, Math.floor(c.y - R)), y1 = Math.min(m.height - 1, Math.ceil(c.y + R));
    function ok(r) { var t = r[0] + r[1] + r[2] + r[3] + r[4], uu = t / 5; if (Math.abs(uu - u) > u * 0.5) return 0;
      for (var i = 0; i < 5; i++) if (Math.abs(r[i] - uu) > uu * 0.75) return 0; return uu; }
    function vcheck(x, y) {
      var r = [0, 0, 0, 0, 0], yy = y;
      while (yy >= 0 && m.get(x, yy)) { r[2]++; yy--; } while (yy >= 0 && !m.get(x, yy)) { r[1]++; yy--; } while (yy >= 0 && m.get(x, yy)) { r[0]++; yy--; }
      var top = yy + 1; yy = y + 1;
      while (yy < m.height && m.get(x, yy)) { r[2]++; yy++; } while (yy < m.height && !m.get(x, yy)) { r[3]++; yy++; } while (yy < m.height && m.get(x, yy)) { r[4]++; yy++; }
      return ok(r) ? top + r[0] + r[1] + r[2] / 2 : null;
    }
    for (var y = y0; y <= y1; y++) {
      var runs = [], cur = m.get(x0 - 1 < 0 ? 0 : x0, y), len = 0, st = x0;
      for (var x = x0; x <= x1 + 1; x++) {
        var b = x <= x1 ? m.get(x, y) : !cur;
        if (b === cur) { len++; continue; }
        runs.push({ k: cur, len: len, end: x }); cur = b; len = 1;
      }
      for (var i = 0; i + 4 < runs.length; i++) {
        if (!runs[i].k) continue;
        var rr = [runs[i].len, runs[i + 1].len, runs[i + 2].len, runs[i + 3].len, runs[i + 4].len];
        if (!ok(rr)) continue;
        var cx = runs[i + 2].end - runs[i + 2].len / 2, cy = vcheck(Math.round(cx), y);
        if (cy == null) continue;
        var dist = Math.hypot(cx - c.x, cy - c.y);
        if (!best || dist < best.d) best = { x: cx, y: cy, d: dist };
      }
    }
    return best;
  }

  // ให้คะแนนตารางที่อ่านได้: ส่วนตายตัวของ QR ตรงกี่ช่อง (0–1)
  function fixedScore(mat, dim) {
    var ok = 0, tot = 0, x, y;
    function chk(x, y, v) { tot++; if (mat.get(x, y) === v) ok++; }
    for (var i = 8; i < dim - 8; i++) { chk(i, 6, i % 2 === 0); chk(6, i, i % 2 === 0); }
    function finder(cx, cy) {
      for (y = -4; y <= 4; y++) for (x = -4; x <= 4; x++) {
        var X = cx + x, Y = cy + y; if (X < 0 || Y < 0 || X >= dim || Y >= dim) continue;
        var d = Math.max(Math.abs(x), Math.abs(y));
        chk(X, Y, d === 4 ? false : d === 3 ? true : d === 2 ? false : true);
      }
    }
    finder(3, 3); finder(dim - 4, 3); finder(3, dim - 4);
    if (dim > 21) for (y = -2; y <= 2; y++) for (x = -2; x <= 2; x++) {
      var dd = Math.max(Math.abs(x), Math.abs(y)); chk(dim - 7 + x, dim - 7 + y, dd !== 1);
    }
    return ok / tot;
  }
  function climb(m, p, fake, als, dim, u, tStarts) {
    var al = als[0];
    var I = root.__jsQR._i, n = 0;
    function score(pp, aa) {
      n++;
      return fixedScore(I.extract(m, { topLeft: pp[0], topRight: pp[1], bottomLeft: pp[2], alignmentPattern: aa, dimension: dim }).matrix, dim);
    }
    var cur = { p: p.slice(), al: { x: al.x, y: al.y } }, cs = score(cur.p, cur.al);
    // ค้นหยาบก่อน: ขยับจุดที่เดา ±3 โมดูล (กันติดค่าเฉพาะที่)
    als.forEach(function (a0) { (tStarts || [p[fake]]).forEach(function (t0) {
      for (var gx = -3; gx <= 3; gx++) for (var gy = -3; gy <= 3; gy++) {
        var gp = p.slice(); gp[fake] = { x: t0.x + gx * u, y: t0.y + gy * u };
        var gs = score(gp, a0); if (gs > cs) { cs = gs; cur = { p: gp, al: { x: a0.x, y: a0.y } }; }
      }
    }); });
    var dirs = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
    [1, 0.5, 0.25].forEach(function (step) {
      var moved = true, guard = 0;
      while (moved && guard++ < 12) {
        moved = false;
        for (var w = 0; w < 2; w++) for (var di = 0; di < dirs.length; di++) {
          var np = cur.p.slice(), na = { x: cur.al.x, y: cur.al.y }, ddx = dirs[di][0] * step * u, ddy = dirs[di][1] * step * u;
          if (w === 0) np[fake] = { x: np[fake].x + ddx, y: np[fake].y + ddy }; else { na.x += ddx; na.y += ddy; }
          var sc = score(np, na);
          if (sc > cs + 1e-9) { cs = sc; cur = { p: np, al: na }; moved = true; }
        }
      }
    });
    return { p: cur.p, al: cur.al, score: cs, n: n };
  }

  // ลองอ่านด้วยรูปทรงหนึ่ง: pts = [TL, TR, BL], fake = index ของจุดที่เดาขึ้น
  function tryGeom(m, pts, fake, dim, u) {
    var I = root.__jsQR._i, mod = MOD(dim), alM = { x: dim - 6.5, y: dim - 6.5 }, n = 0;
    function attempt(p, al) {
      n++;
      var loc = { topLeft: p[0], topRight: p[1], bottomLeft: p[2], alignmentPattern: al, dimension: dim };
      var dec = I.decode(I.extract(m, loc).matrix);
      return dec ? { dec: dec, loc: loc } : null;
    }
    var fwd = affine3(mod, pts); if (!fwd) return { tried: 0 };
    var al0 = fwd(alM), r = attempt(pts, al0);
    if (r) { r.tried = n; return r; }
    // หา alignment จริงในภาพ แล้วคำนวณจุดที่เดาใหม่จาก 2 จุดจริง + alignment
    var alF = findAlignment(m, al0, u, u * 5), al = alF || al0;
    var srcM = [], dstI = [];
    for (var i = 0; i < 3; i++) if (i !== fake) { srcM.push(mod[i]); dstI.push(pts[i]); }
    srcM.push(alM); dstI.push(al);
    var f2 = affine3(srcM, dstI); if (!f2) return { tried: n };
    var p2 = pts.slice(); p2[fake] = f2(mod[fake]);
    r = attempt(p2, al); if (r) { r.tried = n; return r; }
    // ปรับรูปทรงให้รูปแบบตายตัวของ QR (เส้น timing / มุม / alignment) ตรงที่สุด แล้วค่อยถอดรหัส
    var best = climb(m, p2, fake, alF ? [alF, al0] : [al0], dim, u, [p2[fake], pts[fake]]);
    n += best.n;
    r = attempt(best.p, best.al); if (r) { r.tried = n; return r; }
    return { tried: n };
  }

  // จาก finder 2 จุด → สร้างสมมติฐานจุดที่ 3 (มุมฉาก 4 แบบ + ทแยง 2 แบบ) → ลองอ่าน
  function decodePartial(jsQR, rgba, W, H) {
    root.__jsQR = jsQR; var I = jsQR._i, bin = I.binarize(rgba, W, H, true), mats = [bin.binarized, bin.inverted], tried = 0, cands = [];
    for (var mi = 0; mi < mats.length; mi++) {
      var m = mats[mi], fs = findFinders(m).slice(0, 5);
      for (var a = 0; a < fs.length; a++) for (var b = a + 1; b < fs.length; b++) {
        var A = fs[a], B = fs[b], u = (A.u + B.u) / 2;
        if (Math.abs(A.u - B.u) > u * 0.4) continue;
        var dx = B.x - A.x, dy = B.y - A.y, d = Math.hypot(dx, dy);
        if (d < u * 10) continue;
        var px = -dy, py = dx; // ตั้งฉาก ยาวเท่ากัน
        // [มุมฉาก, P, Q, ตัวไหนเป็นจุดที่เดาขึ้น]
        var hyps = [
          [A, B, { x: A.x + px, y: A.y + py }, 2], [A, B, { x: A.x - px, y: A.y - py }, 2], // A = มุมฉาก
          [B, A, { x: B.x + px, y: B.y + py }, 2], [B, A, { x: B.x - px, y: B.y - py }, 2], // B = มุมฉาก
          [{ x: (A.x + B.x) / 2 + px / 2, y: (A.y + B.y) / 2 + py / 2 }, A, B, 0],        // A,B ทแยง
          [{ x: (A.x + B.x) / 2 - px / 2, y: (A.y + B.y) / 2 - py / 2 }, A, B, 0]
        ];
        for (var h = 0; h < hyps.length; h++) {
          var side = Math.hypot(hyps[h][1].x - hyps[h][0].x, hyps[h][1].y - hyps[h][0].y);
          var dim0 = Math.round(side / u) + 7;
          for (var sw = 0; sw < 2; sw++) {
            var pts = [hyps[h][0], sw ? hyps[h][2] : hyps[h][1], sw ? hyps[h][1] : hyps[h][2]]; // TL, TR, BL
            // QR ไม่เคยกลับด้านแบบกระจก: TR อยู่ "ขวา" ของ TL→BL เสมอ (เครื่องหมาย cross product)
            var cr = (pts[1].x - pts[0].x) * (pts[2].y - pts[0].y) - (pts[1].y - pts[0].y) * (pts[2].x - pts[0].x);
            if (cr <= 0) continue;
            for (var dd = -4; dd <= 4; dd++) {
              var dim = dim0 + dd; if ((dim - 17) % 4 !== 0 || dim < 21 || dim > 177) continue;
              cands.push({ m: m, pts: pts, fake: hyps[h][3] === 0 ? 0 : (sw ? 1 : 2), dim: dim, u: u });
            }
          }
        }
      }
    }
    // เรียงสมมติฐานตามคะแนนรูปแบบตายตัว แล้วลองจากที่น่าจะถูกที่สุดก่อน
    cands.forEach(function (c) {
      var f = affine3(MOD(c.dim), c.pts);
      c.al0 = f ? f({ x: c.dim - 6.5, y: c.dim - 6.5 }) : c.pts[0];
      c.sc = fixedScore(I.extract(c.m, { topLeft: c.pts[0], topRight: c.pts[1], bottomLeft: c.pts[2], alignmentPattern: c.al0, dimension: c.dim }).matrix, c.dim);
    });
    cands.sort(function (a, b) { return b.sc - a.sc; });
    for (var ci = 0; ci < cands.length && ci < 8; ci++) {
      var c = cands[ci], r = tryGeom(c.m, c.pts, c.fake, c.dim, c.u);
      tried += r.tried;
      if (r.dec) return { data: r.dec.text, version: r.dec.version, tried: tried, rank: ci, loc: r.loc };
    }
    return { data: null, tried: tried };
  }
  root.decodePartialQR = decodePartial;
  root.findQRFinders = findFinders;
})(typeof window !== 'undefined' ? window : module.exports);
