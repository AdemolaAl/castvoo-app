'use strict';
/*
 * qr.js: a small QR code maker for wallet addresses.
 *   qrSvg('TQ7m...')  -> '<svg ...>' (byte mode, error correction level M, versions 1 to 6, up to 106 characters)
 * Follows the QR code standard (ISO/IEC 18004). Tested against a QR reader.
 */
const QR = (() => {
  // Per version (index = version): total codewords, EC codewords per block, number of blocks (level M).
  const TOTAL = [0, 26, 44, 70, 100, 134, 172];
  const ECC = [0, 10, 16, 26, 18, 24, 16];
  const BLOCKS = [0, 1, 1, 1, 2, 2, 4];
  const ALIGN = [0, 0, 18, 22, 26, 30, 34]; // the single alignment pattern position (versions 2..6)

  function gfMul(x, y) {
    let z = 0;
    for (let i = 7; i >= 0; i--) { z = (z << 1) ^ ((z >>> 7) * 0x11d); z ^= ((y >>> i) & 1) * x; }
    return z & 0xff;
  }
  function rsDivisor(degree) {
    const r = new Array(degree).fill(0); r[degree - 1] = 1;
    let root = 1;
    for (let i = 0; i < degree; i++) {
      for (let j = 0; j < r.length; j++) { r[j] = gfMul(r[j], root); if (j + 1 < r.length) r[j] ^= r[j + 1]; }
      root = gfMul(root, 0x02);
    }
    return r;
  }
  function rsRemainder(data, div) {
    const r = div.map(() => 0);
    for (const b of data) {
      const f = b ^ r.shift(); r.push(0);
      div.forEach((c, i) => { r[i] ^= gfMul(c, f); });
    }
    return r;
  }

  function encode(text) {
    const bytes = [...new TextEncoder().encode(String(text))];
    let ver = 0;
    for (let v = 1; v <= 6; v++) { const cap = TOTAL[v] - ECC[v] * BLOCKS[v]; if (4 + 8 + bytes.length * 8 <= cap * 8) { ver = v; break; } }
    if (!ver) throw new Error('Text too long for this QR maker');
    const dataCw = TOTAL[ver] - ECC[ver] * BLOCKS[ver];
    // Bits: mode (0100 = byte), length (8 bits), data, terminator, padding.
    const bits = [];
    const put = (val, len) => { for (let i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1); };
    put(4, 4); put(bytes.length, 8); bytes.forEach((b) => put(b, 8));
    put(0, Math.min(4, dataCw * 8 - bits.length));
    while (bits.length % 8) bits.push(0);
    const cw = [];
    for (let i = 0; i < bits.length; i += 8) cw.push(bits.slice(i, i + 8).reduce((a, b) => (a << 1) | b, 0));
    for (let p = 0xec; cw.length < dataCw; p ^= 0xec ^ 0x11) cw.push(p);
    // Split into blocks, add error correction, interleave. (All blocks are the same size for these versions.)
    const nb = BLOCKS[ver], per = dataCw / nb, div = rsDivisor(ECC[ver]);
    const blocks = [];
    for (let i = 0; i < nb; i++) { const d = cw.slice(i * per, (i + 1) * per); blocks.push(d.concat(rsRemainder(d, div))); }
    const all = [];
    for (let i = 0; i < blocks[0].length; i++) for (const b of blocks) all.push(b[i]);
    return { ver, all };
  }

  function build(text) {
    const { ver, all } = encode(text);
    const n = ver * 4 + 17;
    const m = Array.from({ length: n }, () => new Array(n).fill(false));
    const fn = Array.from({ length: n }, () => new Array(n).fill(false));
    const set = (x, y, dark) => { m[y][x] = dark; fn[y][x] = true; };
    // Timing patterns
    for (let i = 0; i < n; i++) { set(6, i, i % 2 === 0); set(i, 6, i % 2 === 0); }
    // Finder patterns with separators
    const finder = (cx, cy) => {
      for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
        const x = cx + dx, y = cy + dy;
        if (x < 0 || y < 0 || x >= n || y >= n) continue;
        const d = Math.max(Math.abs(dx), Math.abs(dy));
        set(x, y, d !== 2 && d !== 4);
      }
    };
    finder(3, 3); finder(n - 4, 3); finder(3, n - 4);
    // Alignment pattern
    if (ver >= 2) {
      const a = ALIGN[ver];
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) set(a + dx, a + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    }
    // Reserve format areas (drawn later)
    const format = (mask) => {
      const data = (0 << 3) | mask; // level M = 00
      let rem = data;
      for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
      const b = ((data << 10) | rem) ^ 0x5412;
      const bit = (i) => ((b >>> i) & 1) === 1;
      for (let i = 0; i <= 5; i++) set(8, i, bit(i));
      set(8, 7, bit(6)); set(8, 8, bit(7)); set(7, 8, bit(8));
      for (let i = 9; i < 15; i++) set(14 - i, 8, bit(i));
      for (let i = 0; i < 8; i++) set(n - 1 - i, 8, bit(i));
      for (let i = 8; i < 15; i++) set(8, n - 15 + i, bit(i));
      set(8, n - 8, true); // dark module
    };
    format(0);
    // Place data bits in the zigzag order
    let k = 0;
    for (let right = n - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (let v = 0; v < n; v++) {
        for (let j = 0; j < 2; j++) {
          const x = right - j, up = ((right + 1) & 2) === 0, y = up ? n - 1 - v : v;
          if (!fn[y][x] && k < all.length * 8) { m[y][x] = ((all[k >>> 3] >>> (7 - (k & 7))) & 1) === 1; k++; }
        }
      }
    }
    const MASKS = [
      (x, y) => (x + y) % 2 === 0, (x, y) => y % 2 === 0, (x) => x % 3 === 0, (x, y) => (x + y) % 3 === 0,
      (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0, (x, y) => (x * y) % 2 + (x * y) % 3 === 0,
      (x, y) => ((x * y) % 2 + (x * y) % 3) % 2 === 0, (x, y) => ((x + y) % 2 + (x * y) % 3) % 2 === 0,
    ];
    const applyMask = (mk) => { for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (!fn[y][x] && MASKS[mk](x, y)) m[y][x] = !m[y][x]; };
    const penalty = () => {
      let p = 0;
      const lineScore = (get) => {
        for (let a = 0; a < n; a++) {
          let run = 1;
          for (let b = 1; b <= n; b++) {
            if (b < n && get(a, b) === get(a, b - 1)) run++;
            else { if (run >= 5) p += 3 + (run - 5); run = 1; }
          }
          for (let b = 0; b + 7 <= n; b++) {
            const s = [1, 0, 1, 1, 1, 0, 1].every((v, i) => get(a, b + i) === (v === 1));
            if (!s) continue;
            const before = b >= 4 && [1, 2, 3, 4].every((i) => !get(a, b - i));
            const after = b + 11 <= n && [7, 8, 9, 10].every((i) => !get(a, b + i));
            if (before || after) p += 40;
          }
        }
      };
      lineScore((a, b) => m[a][b]); lineScore((a, b) => m[b][a]);
      let dark = 0;
      for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
        if (m[y][x]) dark++;
        if (x < n - 1 && y < n - 1 && m[y][x] === m[y][x + 1] && m[y][x] === m[y + 1][x] && m[y][x] === m[y + 1][x + 1]) p += 3;
      }
      p += Math.floor(Math.abs(dark * 20 - n * n * 10) / (n * n)) * 10;
      return p;
    };
    let best = 0, bestP = Infinity;
    for (let mk = 0; mk < 8; mk++) { applyMask(mk); format(mk); const s = penalty(); if (s < bestP) { bestP = s; best = mk; } applyMask(mk); }
    applyMask(best); format(best);
    return m;
  }

  function svg(text, opts = {}) {
    const m = build(text), n = m.length, q = 4, size = n + q * 2;
    let d = '';
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (m[y][x]) d += 'M' + (x + q) + ' ' + (y + q) + 'h1v1h-1z';
    return '<svg viewBox="0 0 ' + size + ' ' + size + '" role="img" aria-label="' + (opts.label || 'QR code') + '" shape-rendering="crispEdges" style="width:100%;height:100%;display:block"><rect width="' + size + '" height="' + size + '" fill="#fff"/><path d="' + d + '" fill="' + (opts.color || '#0B1430') + '"/></svg>';
  }
  return { build, svg };
})();
function qrSvg(text, opts) { return QR.svg(text, opts); }
