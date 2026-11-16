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

  // จาก finder 2 จุด → สร้างสมมติฐานจุดที่ 3 (มุมฉาก 4 แบบ + ทแยง 2 แบบ) → ลองอ่าน
  function decodePartial(jsQR, rgba, W, H) {
    var I = jsQR._i, bin = I.binarize(rgba, W, H, true), mats = [bin.binarized, bin.inverted], tried = 0;
    for (var mi = 0; mi < mats.length; mi++) {
      var m = mats[mi], fs = findFinders(m).slice(0, 5);
      for (var a = 0; a < fs.length; a++) for (var b = a + 1; b < fs.length; b++) {
        var A = fs[a], B = fs[b], u = (A.u + B.u) / 2;
        if (Math.abs(A.u - B.u) > u * 0.4) continue;
        var dx = B.x - A.x, dy = B.y - A.y, d = Math.hypot(dx, dy);
        if (d < u * 10) continue;
        var px = -dy, py = dx; // ตั้งฉาก ยาวเท่ากัน
        var hyps = [
          [A, B, { x: A.x + px, y: A.y + py }], [A, B, { x: A.x - px, y: A.y - py }], // A = มุมฉาก
          [B, A, { x: B.x + px, y: B.y + py }], [B, A, { x: B.x - px, y: B.y - py }], // B = มุมฉาก
          [{ x: (A.x + B.x) / 2 + px / 2, y: (A.y + B.y) / 2 + py / 2 }, A, B],        // A,B ทแยง
          [{ x: (A.x + B.x) / 2 - px / 2, y: (A.y + B.y) / 2 - py / 2 }, A, B]
        ];
        for (var h = 0; h < hyps.length; h++) {
          var C = hyps[h][0], P = hyps[h][1], Q = hyps[h][2]; // C = มุมฉาก (top-left)
          var side = Math.hypot(P.x - C.x, P.y - C.y);
          var dim0 = Math.round(side / u) + 7;
          for (var dd = -4; dd <= 4; dd++) {
            var dim = dim0 + dd; if ((dim - 17) % 4 !== 0 || dim < 21 || dim > 177) continue;
            // ลองทั้งสองแบบ: P = ขวาบน / Q = ซ้ายล่าง และสลับ (เผื่อภาพกลับด้าน)
            for (var sw = 0; sw < 2; sw++) {
              var TR = sw ? Q : P, BL = sw ? P : Q, TL = C;
              var k = (dim - 10) / (dim - 7); // ตำแหน่ง alignment (dim-6.5) เทียบกับระยะ finder (dim-7)
              var al = { x: TL.x + (TR.x - TL.x + BL.x - TL.x) * k, y: TL.y + (TR.y - TL.y + BL.y - TL.y) * k };
              var loc = { topLeft: TL, topRight: TR, bottomLeft: BL, alignmentPattern: al, dimension: dim };
              tried++;
              var ex = I.extract(m, loc), dec = I.decode(ex.matrix);
              if (dec) return { data: dec.text, version: dec.version, finders: fs.length, tried: tried, loc: loc };
            }
          }
        }
      }
    }
    return { data: null, tried: tried };
  }
  root.decodePartialQR = decodePartial;
  root.findQRFinders = findFinders;
})(typeof window !== 'undefined' ? window : module.exports);
