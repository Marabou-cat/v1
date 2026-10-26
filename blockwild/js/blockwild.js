// BLOCKWILD — 方块荒野
// 单页体素生存：程序化地形（草/土/石/沙/水/树）、挖掘与放置、合成、第一人称手臂、昼夜与夜行怪。
import * as THREE from '../vendor/three.module.js';

/* ============================================================ CFG */
const CFG = {
  CH: 16, WH: 64, SEA: 26,
  LOAD_R: 5, UNLOAD_R: 8,
  GRAV: 27, JUMP: 8.5, WALK: 4.7, SPRINT: 6.9,
  REACH: 6, DAY: 300, MAX_MOBS: 6, SAVE_KEY: 'blockwild_save_v1',
  EYE: 1.62, HW: 0.3, PH: 1.78,
};

/* ============================================================ 噪声 */
let SEED = (Math.random() * 1e6) | 0;
const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
const clamp01 = v => clamp(v, 0, 1);
const lerp = (a, b, t) => a + (b - a) * t;
const smooth = (e0, e1, x) => { const t = clamp01((x - e0) / (e1 - e0)); return t * t * (3 - 2 * t); };

// 32 位整型混合（必须用 Math.imul：直接乘法会超出 2^53，哈希退化成一团，地形高度几乎没有起伏）
function h2(x, y) {
  let n = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ Math.imul(SEED, 144665);
  n = Math.imul(n ^ (n >>> 13), 1274126177);
  n = n ^ (n >>> 16);
  return (n >>> 0) / 4294967296;
}
function h3(x, y, z) {
  let n = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ Math.imul(z | 0, 1013904223) ^ Math.imul(SEED, 97653);
  n = Math.imul(n ^ (n >>> 13), 1274126177);
  n = n ^ (n >>> 16);
  return (n >>> 0) / 4294967296;
}
function n2(x, y) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const u = smooth(0, 1, x - xi), v = smooth(0, 1, y - yi);
  const a = h2(xi, yi), b = h2(xi + 1, yi), c = h2(xi, yi + 1), d = h2(xi + 1, yi + 1);
  return lerp(lerp(a, b, u), lerp(c, d, u), v);
}
function fbm2(x, y, oct) {
  let s = 0, a = 0.5, f = 1, norm = 0;
  for (let i = 0; i < oct; i++) { s += a * n2(x * f, y * f); norm += a; f *= 2; a *= 0.5; }
  return s / norm;
}
function n3(x, y, z) {
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
  const u = smooth(0, 1, x - xi), v = smooth(0, 1, y - yi), w = smooth(0, 1, z - zi);
  const c00 = lerp(h3(xi, yi, zi), h3(xi + 1, yi, zi), u);
  const c10 = lerp(h3(xi, yi + 1, zi), h3(xi + 1, yi + 1, zi), u);
  const c01 = lerp(h3(xi, yi, zi + 1), h3(xi + 1, yi, zi + 1), u);
  const c11 = lerp(h3(xi, yi + 1, zi + 1), h3(xi + 1, yi + 1, zi + 1), u);
  return lerp(lerp(c00, c10, v), lerp(c01, c11, v), w);
}
function heightAt(x, z) {
  // fbm 会把方差压得很小，先以 0.5 为中心放大对比度，才能得到真正起伏的地形
  const cont = clamp01(0.5 + (fbm2(x * 0.011, z * 0.011, 4) - 0.5) * 2.8);
  const hill = clamp01(0.5 + (fbm2(x * 0.047 + 13.7, z * 0.047 - 7.1, 3) - 0.5) * 2.4);
  return Math.floor(15 + cont * 30 + hill * 7);
}


/* ============================================================ 洞穴 / 矿洞 */
// 洞穴两层：大空腔（cheese）+ 细长隧道（ridged 噪声的等值壳）
function caveCarve(wx, y, wz, h) {
  if (y < 2 || y > 52) return false;
  const depth = h - y;
  const cheese = n3(wx * 0.026, y * 0.05, wz * 0.026);
  // 地表附近只有极少数地方被掏开 → 形成天然洞口（阈值已按实测分布标定）
  if (cheese > (depth <= 2 ? 0.92 : 0.76)) return true;
  if (depth <= 1) return false;
  const ridge = n3(wx * 0.043 + 31.7, y * 0.019, wz * 0.043 + 11.3);
  const r = 1 - Math.abs(ridge - 0.5) * 2;          // 0.5 附近 → 细长的隧道壳
  return r > 0.99;
}

// ── 废弃矿洞：按 96×96 的格子确定性生成，跨区块用 byChunk 拼接 ──
const MS_CELL = 96;
const msCache = new Map();
function mulberry32(a) {
  return function () {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
// 矿洞构件：巷道 / 房间 / 通地表的楼梯 / 矿脉
function msPush(ops, x, y, z, t) { ops.push({ x, y, z, t }); }
function msGallery(ops, x0, y0, z0, dx, dz, len, spacing, W = 1, H = 3) {
  const px = -dz, pz = dx;
  for (let i = 0; i < len; i++) {
    const bx = x0 + dx * i, bz = z0 + dz * i;
    for (let w = -W; w <= W; w++) {
      const x = bx + px * w, z = bz + pz * w;
      for (let y = y0; y < y0 + H; y++) msPush(ops, x, y, z, 0);
      msPush(ops, x, y0 - 1, z, 8);
    }
    if (i % spacing === 0) {
      for (const w of [-W - 1, W + 1]) for (let y = y0; y < y0 + H; y++) msPush(ops, bx + px * w, y, bz + pz * w, 6);
      for (let w = -W - 1; w <= W + 1; w++) msPush(ops, bx + px * w, y0 + H, bz + pz * w, 8);
    }
  }
}
function msRoom(ops, cx, y0, cz, rw, rd, h) {
  for (let dx = -rw; dx <= rw; dx++) for (let dz = -rd; dz <= rd; dz++) {
    for (let y = y0; y < y0 + h; y++) msPush(ops, cx + dx, y, cz + dz, 0);
    msPush(ops, cx + dx, y0 - 1, cz + dz, 8);
  }
  for (const [sx, sz] of [[-rw, -rd], [rw, -rd], [-rw, rd], [rw, rd]]) {
    for (let y = y0; y < y0 + h; y++) msPush(ops, cx + sx, y, cz + sz, 6);
    msPush(ops, cx + sx, y0 + h, cz + sz, 8);
  }
  // 房间中央偶尔来个矿堆
}
function msOreBlob(ops, cx, y0, cz, kind, rnd) {
  const w = 1 + Math.floor(rnd() * 2), h = 1 + Math.floor(rnd() * 2);
  for (let dx = -w; dx <= w; dx++) for (let dz = -w; dz <= w; dz++) for (let dy = 0; dy <= h; dy++) {
    if (rnd() < 0.35) continue;
    msPush(ops, cx + dx, y0 + dy, cz + dz, kind);
  }
}
function msStairs(ops, x0, y0, z0, dx, dz, maxLen = 170) {
  let lvl = y0;
  for (let k = 1; k <= maxLen; k++) {
    const x = x0 - dx * k, z = z0 - dz * k;
    if (k % 3 === 0) lvl++;
    for (let w = -1; w <= 1; w++) {
      const xx = x - dz * w, zz = z + dx * w;
      for (let y = lvl; y < lvl + 3; y++) msPush(ops, xx, y, zz, 0);
      msPush(ops, xx, lvl - 1, zz, 8);
    }
    const surf = heightAt(x, z);
    if (surf <= CFG.SEA + 2) return false;
    if (lvl >= surf - 1) {
      for (let w = -1; w <= 1; w++) for (let y = surf - 1; y < lvl + 3; y++) msPush(ops, x - dz * w, y, z + dx * w, 0);
      return true;
    }
  }
  return false;
}

function mineshaftFor(cellX, cellZ) {
  const key = cellX + ',' + cellZ;
  if (msCache.has(key)) return msCache.get(key);
  let out = null;
  const roll = h2(cellX * 37.13 + 5.7, cellZ * 61.7 - 3.1);
  if (roll > 0.42) {                                  // 约 58% 的格子有矿洞
    const rnd = mulberry32((Math.floor(roll * 1e9) ^ Math.imul(cellX, 73856093) ^ Math.imul(cellZ, 19349663)) | 0);
    const ox = cellX * MS_CELL + 18 + Math.floor(rnd() * (MS_CELL - 36));
    const oz = cellZ * MS_CELL + 18 + Math.floor(rnd() * (MS_CELL - 36));
    const surfHere = heightAt(ox, oz);
    const baseY = Math.max(7, Math.min(11 + Math.floor(rnd() * 15), surfHere - 13));
    const skip = surfHere <= CFG.SEA + 4 && rnd() < 0.5;
    const ops = [];
    const spacing = 3 + Math.floor(rnd() * 3);        // 支架间距也随机
    const shapeRoll = rnd();
    let entrance = false, kindName = 'gallery', corridors = 0;
    const dirX = rnd() < 0.5 ? 1 : -1;
    const dirZ = rnd() < 0.5 ? 1 : -1;

    if (shapeRoll < 0.3) {                            // ① 长廊 + 支巷
      kindName = 'gallery';
      const len = 20 + Math.floor(rnd() * 28);
      msGallery(ops, ox, baseY, oz, dirX, 0, len, spacing);
      corridors++;
      const side = 1 + Math.floor(rnd() * 2);
      for (let i = 0; i < side; i++) {
        const at = 4 + Math.floor(rnd() * Math.max(1, len - 8));
        const sgn = rnd() < 0.5 ? 1 : -1;
        msGallery(ops, ox + dirX * at, baseY, oz, 0, sgn, 8 + Math.floor(rnd() * 12), spacing);
        corridors++;
      }
      entrance = msStairs(ops, ox, baseY, oz, dirX, 0);
    } else if (shapeRoll < 0.55) {                    // ② L 形拐弯
      kindName = 'L';
      const l1 = 14 + Math.floor(rnd() * 16), l2 = 12 + Math.floor(rnd() * 16);
      msGallery(ops, ox, baseY, oz, dirX, 0, l1, spacing);
      msGallery(ops, ox + dirX * (l1 - 1), baseY, oz, 0, dirZ, l2, spacing);
      corridors += 2;
      msRoom(ops, ox + dirX * (l1 - 1), baseY, oz + dirZ * (l2 - 1), 2, 2, 4);  // 拐角小厅
      entrance = msStairs(ops, ox, baseY, oz, dirX, 0);
    } else if (shapeRoll < 0.75) {                     // ③ 十字矿口（中央大厅 + 四向）
      kindName = 'cross';
      msRoom(ops, ox, baseY, oz, 3, 3, 5);
      const l = 10 + Math.floor(rnd() * 10);
      msGallery(ops, ox + 4, baseY, oz, 1, 0, l, spacing, 1, 4);
      msGallery(ops, ox - 4, baseY, oz, -1, 0, l, spacing, 1, 4);
      msGallery(ops, ox, baseY, oz + 4, 0, 1, l, spacing, 1, 4);
      msGallery(ops, ox, baseY, oz - 4, 0, -1, l, spacing, 1, 4);
      corridors += 4;
      entrance = msStairs(ops, ox + 4, baseY, oz, 1, 0);
    } else {                                          // ④ 房间群（矿工营地）
      kindName = 'rooms';
      const n = 2 + Math.floor(rnd() * 2);
      let cx = ox, cz = oz;
      for (let i = 0; i < n; i++) {
        const rw = 2 + Math.floor(rnd() * 3), rd = 2 + Math.floor(rnd() * 3);
        msRoom(ops, cx, baseY, cz, rw, rd, 4 + Math.floor(rnd() * 2));
        const dxs = rnd() < 0.5 ? 1 : -1, dzs = rnd() < 0.5 ? 1 : -1;
        msGallery(ops, cx + dxs * (rw + 1), baseY, cz, dxs, 0, 6 + Math.floor(rnd() * 6), spacing);
        cx += dxs * (rw * 2 + 6); cz += dzs * 2;
      }
      corridors += n;
      entrance = msStairs(ops, cx, baseY, cz, 1, 0);
    }
    // 随机矿脉：走廊两侧塞煤/铁
    const ores = 2 + Math.floor(rnd() * 4);
    for (let i = 0; i < ores; i++) {
      const px2 = ox + Math.floor(rnd() * 40 - 20), pz2 = oz + Math.floor(rnd() * 40 - 20);
      msOreBlob(ops, px2, baseY + Math.floor(rnd() * 2), pz2, rnd() < 0.65 ? 13 : 15, rnd);
    }
    const byChunk = new Map();
    if (!skip) for (const op of ops) {
      const k2 = (op.x >> 4) + ',' + (op.z >> 4);
      let arr = byChunk.get(k2);
      if (!arr) byChunk.set(k2, arr = []);
      arr.push(op);
    }
    out = { cellX, cellZ, ox, oz, baseY, kind: kindName, corridors, ops: ops.length, byChunk, entrance };
  }
  msCache.set(key, out);
  return out;
}

/* ============================================================ 方块 / 图集 */
// tiles: 4x4 atlas
// 0 草顶 1 草侧 2 土 3 石 4 沙 5 木侧 6 木顶 7 叶 8 木板 9 圆石 10 水 11 台顶 12 台侧 13 煤矿
const BLOCKS = {
  1: { name: '草地', top: 0, side: 1, bottom: 2, hard: 0.55, drop: 2 },
  2: { name: '泥土', top: 2, side: 2, bottom: 2, hard: 0.5, drop: 2 },
  3: { name: '石头', top: 3, side: 3, bottom: 3, hard: 1.7, drop: 9, pick: true },
  4: { name: '沙子', top: 4, side: 4, bottom: 4, hard: 0.45, drop: 4 },
  5: { name: '水', water: true, hard: 0, top: 10, side: 10, bottom: 10 },
  6: { name: '原木', top: 6, side: 5, bottom: 6, hard: 0.8, drop: 6 },
  7: { name: '树叶', top: 7, side: 7, bottom: 7, hard: 0.22, drop: 0, leaf: true },
  8: { name: '木板', top: 8, side: 8, bottom: 8, hard: 0.65, drop: 8 },
  9: { name: '圆石', top: 9, side: 9, bottom: 9, hard: 1.9, drop: 9, pick: true },
  10: { name: '工作台', top: 11, side: 12, bottom: 8, hard: 0.8, drop: 10 },
  13: { name: '煤矿石', top: 13, side: 13, bottom: 13, hard: 2.2, drop: 13, pick: true },
  14: { name: '床', top: 14, side: 15, bottom: 8, hard: 0.6, drop: 14, bed: true },
  15: { name: '铁矿石', top: 16, side: 16, bottom: 16, hard: 2.6, drop: 106, pick: true, stonePick: true },
};
const ITEMS = {
  100: { name: '木镐', kind: 'pick' },
  101: { name: '石镐', kind: 'pick' },
  102: { name: '木剑', kind: 'sword', dmg: 5 },
  103: { name: '石剑', kind: 'sword', dmg: 7 },
  104: { name: '木棍', kind: 'mat' },
  105: { name: '苹果', kind: 'food', food: 4 },
  106: { name: '铁锭', kind: 'mat' },
  110: { name: '铁头盔', kind: 'armor', slot: 'head', ap: 2 },
  111: { name: '铁胸甲', kind: 'armor', slot: 'chest', ap: 6 },
  112: { name: '铁护腿', kind: 'armor', slot: 'legs', ap: 5 },
  113: { name: '铁靴', kind: 'armor', slot: 'feet', ap: 2 },
  120: { name: '铁镐', kind: 'pick', fast: 1.7 },
  121: { name: '铁剑', kind: 'sword', dmg: 9 },
};
const isItem = id => !!BLOCKS[id] || !!ITEMS[id];
const defOf = id => BLOCKS[id] || ITEMS[id];
const nameOf = id => (defOf(id) || { name: '?' }).name;

let atlasCanvas = null, atlasTex = null;
const ATLAS_COLS = 4, ATLAS_ROWS = 8;
function makeAtlas() {
  const S = 16, N = ATLAS_COLS, cv = document.createElement('canvas');
  cv.width = S * ATLAS_COLS; cv.height = S * ATLAS_ROWS;
  const g = cv.getContext('2d');
  g.imageSmoothingEnabled = false;
  const px = (col, row, x, y, c) => { g.fillStyle = c; g.fillRect(col * S + x, row * S + y, 1, 1); };
  const shade = (hex, k) => {
    const n = parseInt(hex.slice(1), 16);
    const r = clamp(((n >> 16) & 255) * k, 0, 255) | 0;
    const gg = clamp(((n >> 8) & 255) * k, 0, 255) | 0;
    const b = clamp((n & 255) * k, 0, 255) | 0;
    return `rgb(${r},${gg},${b})`;
  };
  const noiseTile = (col, row, base, vari, extra) => {
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
      const k = 1 + (Math.random() * 2 - 1) * vari;
      px(col, row, x, y, shade(base, k));
    }
    if (extra) extra(col, row);
  };
  // ⚠ 瓦片序号 → 4x4 图集的 (col,row)。之前直接把序号当列号用，>=4 的全画到画布外，
  // 于是沙子/木头/树叶/木板/圆石/水/工作台/煤矿一律变成纯黑方块。
  const T = (n, base, vari, extra) => noiseTile(n % N, (n / N) | 0, base, vari, extra);
  // 0 草顶
  T(0, '#6fae47', 0.13, (c, r) => {
    for (let i = 0; i < 16; i++) px(c, r, (Math.random() * 16) | 0, (Math.random() * 16) | 0, shade('#7fc456', 1));
  });
  // 1 草侧
  T(1, '#8a5a33', 0.12, (c, r) => {
    for (let x = 0; x < S; x++) {
      const e = 3 + ((Math.random() * 3) | 0);
      for (let y = 0; y < e; y++) px(c, r, x, y, shade('#6fae47', 1 + (Math.random() * 0.24 - 0.12)));
      px(c, r, x, e, shade('#5f9540', 0.95));
    }
  });
  // 2 土
  T(2, '#8a5a33', 0.16);
  // 3 石
  T(3, '#8d8d8d', 0.14);
  // 4 沙
  T(4, '#e3d3a0', 0.09);
  // 5 木侧
  T(5, '#6d4a2a', 0.1, (c, r) => {
    for (let x = 0; x < S; x += 3) for (let y = 0; y < S; y++) px(c, r, x, y, shade('#5b3d22', 1));
  });
  // 6 木顶
  T(6, '#8a6134', 0.08, (c, r) => {
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
      const d = Math.hypot(x - 7.5, y - 7.5);
      if (Math.abs(d % 3 - 1.5) < 0.55) px(c, r, x, y, shade('#6a4826', 1));
    }
  });
  // 7 树叶
  T(7, '#3d7a2e', 0.2, (c, r) => {
    for (let i = 0; i < 40; i++) px(c, r, (Math.random() * 16) | 0, (Math.random() * 16) | 0, shade('#2c5b21', 1));
    for (let i = 0; i < 12; i++) px(c, r, (Math.random() * 16) | 0, (Math.random() * 16) | 0, shade('#4f9439', 1));
  });
  // 8 木板
  T(8, '#b98a4e', 0.08, (c, r) => {
    for (let y = 0; y < S; y += 5) for (let x = 0; x < S; x++) px(c, r, x, y, shade('#8d6534', 1));
    for (let y = 0; y < S; y++) { px(c, r, 5, y, shade('#8d6534', 0.96)); px(c, r, 11, y, shade('#8d6534', 0.96)); }
  });
  // 9 圆石
  T(9, '#878787', 0.1, (c, r) => {
    for (let i = 0; i < 9; i++) {
      const bx = (Math.random() * 14) | 0, by = (Math.random() * 14) | 0, s = 2 + ((Math.random() * 3) | 0);
      for (let y = by; y < Math.min(16, by + s); y++) for (let x = bx; x < Math.min(16, bx + s); x++)
        px(c, r, x, y, shade(Math.random() < .5 ? '#a4a4a4' : '#6f6f6f', 1));
    }
  });
  // 10 水
  T(10, '#2f6fd0', 0.07, (c, r) => {
    for (let i = 0; i < 5; i++) {
      const y = (Math.random() * 16) | 0;
      for (let x = 0; x < 16; x++) px(c, r, x, (y + Math.round(Math.sin(x * 0.7) * 1.4) + 16) % 16, shade('#5b96e8', 1));
    }
  });
  // 11 台顶
  T(11, '#b98a4e', 0.07, (c, r) => {
    for (let i = 0; i < 16; i++) { px(c, r, i, 4, '#6f4d24'); px(c, r, i, 11, '#6f4d24'); px(c, r, 4, i, '#6f4d24'); px(c, r, 11, i, '#6f4d24'); }
  });
  // 12 台侧
  T(12, '#a97c45', 0.07, (c, r) => {
    for (let i = 0; i < 16; i++) { px(c, r, i, 2, '#6f4d24'); px(c, r, i, 13, '#6f4d24'); }
    for (let x = 3; x < 13; x++) for (let y = 6; y < 10; y++) px(c, r, x, y, shade('#7a5528', 1));
  });
  // 14 床顶：木框 + 红被 + 白枕
  T(14, '#b8423f', 0.05, (c, r) => {
    for (let x = 0; x < S; x++) { px(c, r, x, 0, '#6f4d24'); px(c, r, x, 1, '#7d5a2c'); px(c, r, x, 15, '#6f4d24'); }
    for (let y = 0; y < S; y++) { px(c, r, 0, y, '#7d5a2c'); px(c, r, 15, y, '#7d5a2c'); }
    for (let y = 3; y < 7; y++) for (let x = 3; x < 13; x++) px(c, r, x, y, y === 3 || y === 6 ? '#d9d5cc' : '#efeae0');
    for (let y = 8; y < 14; y++) for (let x = 3; x < 13; x++) if ((x + y) % 4 === 0) px(c, r, x, y, '#a33633');
  });
  // 15 床侧：木框 + 红被沿
  T(15, '#8d6534', 0.07, (c, r) => {
    for (let y = 4; y < 9; y++) for (let x = 0; x < S; x++) px(c, r, x, y, y === 4 ? '#d4d0c7' : '#b8423f');
    for (let x = 0; x < S; x++) { px(c, r, x, 9, '#6b4a26'); px(c, r, x, 3, '#6b4a26'); }
  });
  // 16 铁矿石：石头 + 橙褐色矿斑
  T(16, '#8d8d8d', 0.13, (c, r) => {
    for (let i = 0; i < 8; i++) {
      const bx = 2 + Math.floor(Math.random() * 12), by = 2 + Math.floor(Math.random() * 12);
      for (let y = 0; y < 3; y++) for (let x = 0; x < 3; x++) {
        if (x === 2 && y === 2) continue;
        px(c, r, Math.min(15, bx + x), Math.min(15, by + y), shade(Math.random() < 0.5 ? '#d99a63' : '#b97a45', 1));
      }
    }
  });
  // 13 煤矿
  T(13, '#8d8d8d', 0.13, (c, r) => {
    for (let i = 0; i < 7; i++) {
      const bx = (Math.random() * 13) | 0, by = (Math.random() * 13) | 0;
      for (let y = 0; y < 3; y++) for (let x = 0; x < 3; x++) px(c, r, bx + x, by + y, shade('#20242a', 1));
    }
  });
  atlasCanvas = cv;
  atlasTex = new THREE.CanvasTexture(cv);
  atlasTex.magFilter = THREE.NearestFilter;
  atlasTex.minFilter = THREE.NearestFilter;
  atlasTex.generateMipmaps = false;
  atlasTex.colorSpace = THREE.SRGBColorSpace;
  return atlasTex;
}

/* ---------- 图标（快捷栏 / 背包） ---------- */
const iconCache = new Map();
function iconURL(id) {
  if (iconCache.has(id)) return iconCache.get(id);
  const S = 32, cv = document.createElement('canvas');
  cv.width = cv.height = S;
  const g = cv.getContext('2d');
  g.imageSmoothingEnabled = false;
  const b = BLOCKS[id];
  if (b) {
    const t = b.side ?? b.top;
    g.drawImage(atlasCanvas, (t % ATLAS_COLS) * 16, ((t / ATLAS_COLS) | 0) * 16, 16, 16, 0, 0, S, S);
  } else if (id === 104) { // 木棍
    g.strokeStyle = '#b98a4e'; g.lineWidth = 5; g.lineCap = 'round';
    g.beginPath(); g.moveTo(7, 26); g.lineTo(24, 6); g.stroke();
    g.strokeStyle = '#8d6534'; g.lineWidth = 2;
    g.beginPath(); g.moveTo(8, 25); g.lineTo(23, 7); g.stroke();
  } else if (id === 105) { // 苹果
    g.fillStyle = '#d33b3b'; g.beginPath(); g.arc(16, 19, 9, 0, 7); g.fill();
    g.fillStyle = '#ef5f5f'; g.beginPath(); g.arc(12, 16, 3.4, 0, 7); g.fill();
    g.strokeStyle = '#6a4a2a'; g.lineWidth = 2.4; g.beginPath(); g.moveTo(16, 11); g.lineTo(17, 5); g.stroke();
    g.fillStyle = '#4c9a3a'; g.beginPath(); g.ellipse(21, 6, 5, 2.6, -0.4, 0, 7); g.fill();
  } else if (ITEMS[id] && ITEMS[id].kind === 'pick') { // 镐
    const metal = id === 101 ? '#9a9a9a' : id === 120 ? '#d9dee5' : '#c8a06a';
    g.strokeStyle = '#b98a4e'; g.lineWidth = 4; g.lineCap = 'round';
    g.beginPath(); g.moveTo(9, 27); g.lineTo(21, 12); g.stroke();
    g.strokeStyle = metal; g.lineWidth = 5;
    g.beginPath(); g.moveTo(9, 9); g.quadraticCurveTo(20, 5, 27, 13); g.stroke();
  } else if (ITEMS[id] && ITEMS[id].kind === 'sword') { // 剑
    const metal = id === 103 ? '#b9b9b9' : id === 121 ? '#e3e8ef' : '#c8a06a';
    g.strokeStyle = metal; g.lineWidth = 5; g.lineCap = 'round';
    g.beginPath(); g.moveTo(10, 25); g.lineTo(24, 7); g.stroke();
    g.strokeStyle = '#8d6534'; g.lineWidth = 4;
    g.beginPath(); g.moveTo(7, 21); g.lineTo(14, 28); g.stroke();
  } else if (id === 106) { // 铁锭
    g.fillStyle = '#c9d0d8'; g.beginPath();
    g.moveTo(8, 21); g.lineTo(24, 21); g.lineTo(21, 12); g.lineTo(11, 12); g.closePath(); g.fill();
    g.fillStyle = '#e8eef4'; g.beginPath();
    g.moveTo(10, 19); g.lineTo(22, 19); g.lineTo(20, 14); g.lineTo(12, 14); g.closePath(); g.fill();
  } else if (ITEMS[id] && ITEMS[id].kind === 'armor') { // 铁盔甲
    const steel = '#d3dae2', dark = '#8c98a6';
    g.fillStyle = steel; g.strokeStyle = dark; g.lineWidth = 2;
    if (ITEMS[id].slot === 'head') {                 // 头盔
      g.beginPath(); g.arc(16, 17, 9, Math.PI, 0); g.lineTo(25, 21); g.lineTo(7, 21); g.closePath(); g.fill(); g.stroke();
      g.fillStyle = '#2a3340'; g.fillRect(11, 16, 10, 4);
    } else if (ITEMS[id].slot === 'chest') {         // 胸甲
      g.beginPath(); g.moveTo(10, 8); g.lineTo(22, 8); g.lineTo(25, 13); g.lineTo(22, 25);
      g.lineTo(10, 25); g.lineTo(7, 13); g.closePath(); g.fill(); g.stroke();
      g.fillStyle = dark; g.fillRect(15, 10, 2, 13);
    } else if (ITEMS[id].slot === 'legs') {          // 护腿
      g.beginPath(); g.moveTo(9, 7); g.lineTo(23, 7); g.lineTo(23, 25); g.lineTo(18, 25); g.lineTo(16, 14);
      g.lineTo(14, 25); g.lineTo(9, 25); g.closePath(); g.fill(); g.stroke();
    } else {                                          // 靴子
      g.beginPath(); g.moveTo(7, 12); g.lineTo(13, 12); g.lineTo(13, 22); g.lineTo(9, 22); g.closePath(); g.fill(); g.stroke();
      g.beginPath(); g.moveTo(17, 12); g.lineTo(23, 12); g.lineTo(23, 22); g.lineTo(19, 22); g.closePath(); g.fill(); g.stroke();
    }
  } else {
    g.fillStyle = '#7b8ea6'; g.fillRect(4, 4, 24, 24);
  }
  const url = cv.toDataURL();
  iconCache.set(id, url);
  return url;
}

/* ============================================================ 世界 */
const chunks = new Map();
const edits = new Map();      // "x,y,z" -> id
const dirty = new Set();

function ckey(cx, cz) { return cx + ',' + cz; }
function markDirty(cx, cz) { const c = chunks.get(ckey(cx, cz)); if (c) dirty.add(c); }

// 树的形态参数（全部由坐标哈希决定 → 同一世界任何时候生成都一样，跨区块也不会变样）
// 三种形态：阔叶橡树(圆冠) / 针叶高杉(锥形) / 细弱小树，冠幅半径、树高、冠心偏移各自随机
function treeParams(wx, wz) {
  if (h2(wx * 2.17 + 91, wz * 3.31 - 17) < 0.977) return null;
  const g = heightAt(wx, wz);
  if (g <= CFG.SEA + 1 || g >= 45) return null;
  const k = h2(wx * 7.13 + 3.7, wz * 5.71 - 9.1);
  let kind, trunkH, r;
  if (k < 0.52) {                                   // 阔叶：矮壮、圆而饱满
    kind = 'oak';
    trunkH = 3 + ((h2(wx * 3.1, wz * 4.7) * 4) | 0);  // 3..6
    r = 2 + ((h2(wx * 9.3, wz * 1.7) * 2) | 0);       // 2..3
  } else if (k < 0.83) {                            // 高杉：细高、锥形
    kind = 'pine';
    trunkH = 6 + ((h2(wx * 5.9, wz * 2.3) * 4) | 0);  // 6..9（细高）
    r = 1 + ((h2(wx * 4.1, wz * 8.9) * 2) | 0);       // 1..2（窄冠）
  } else {                                          // 细弱小树：矮、冠小
    kind = 'bush';
    trunkH = 2 + ((h2(wx * 6.7, wz * 3.3) * 3) | 0);  // 2..4
    r = 1 + ((h2(wx * 2.9, wz * 7.7) * 2) | 0);       // 1..2
  }
  const ox = ((h2(wx * 11.3 + 5, wz * 6.1) * 3) | 0) - 1;   // 冠心横向偏移 -1..1
  const oz = ((h2(wx * 5.7, wz * 12.7 + 2) * 3) | 0) - 1;
  return { g, kind, trunkH, r, ox, oz };
}

// 把一棵树写进当前区块（越界的方块由 put 丢弃；padding 保证跨区块树冠完整）
function putTree(put, lx, lz, wx, wz, t) {
  const topY = t.g + t.trunkH;
  for (let y = 1; y <= t.trunkH; y++) put(lx, t.g + y, lz, 6, false);
  if (t.kind === 'pine') {
    // 自下而上逐层收窄的锥形冠（树干下部露出来，顶部收成尖）
    for (let dy = -3; dy <= 1; dy++) {
      const rr = Math.max(0, Math.round(t.r * (1 - (dy + 3) / 5.2)));
      for (let dx = -rr; dx <= rr; dx++) for (let dz = -rr; dz <= rr; dz++) {
        if (Math.abs(dx) + Math.abs(dz) > rr + 1) continue;
        if (rr > 0 && Math.abs(dx) === rr && Math.abs(dz) === rr) continue;
        if (rr === 0 && Math.abs(dx) + Math.abs(dz) > 1) continue;
        put(lx + dx, topY + dy, lz + dz, 7, true);
      }
    }
    put(lx, topY + 2, lz, 7, true);
    put(lx, topY + 1, lz, 7, true);
  } else {
    const R = t.kind === 'bush' ? t.r * 0.85 : t.r;
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -t.r - 1; dx <= t.r + 1; dx++) for (let dz = -t.r - 1; dz <= t.r + 1; dz++) {
        if (Math.abs(dx) > t.r + 1 || Math.abs(dz) > t.r + 1) continue;
        const ddx = dx - t.ox, ddz = dz - t.oz;
        const d = Math.sqrt(ddx * ddx + ddz * ddz * 0.9) + Math.abs(dy + 0.4) * 1.3;
        const jit = (h2((wx + dx) * 3.7 + 11, (wz + dz) * 5.3 + dy * 7) - 0.5) * 1.6;
        if (d + jit > R + 0.5) continue;
        put(lx + dx, topY + dy, lz + dz, 7, true);
      }
    }
    put(lx, topY + 2, lz, 7, true);
  }
}

function genChunk(cx, cz) {
  const CH = CFG.CH, WH = CFG.WH, SEA = CFG.SEA;
  const b = new Uint8Array(CH * WH * CH);
  const idx = (x, y, z) => (y * CH + z) * CH + x;
  const ox = cx * CH, oz = cz * CH;
  const put = (lx, y, lz, id, onlyAir) => {
    if (lx < 0 || lx >= CH || lz < 0 || lz >= CH || y < 0 || y >= WH) return;
    const i = idx(lx, y, lz);
    if (onlyAir && b[i] !== 0) return;
    b[i] = id;
  };
  for (let lx = 0; lx < CH; lx++) for (let lz = 0; lz < CH; lz++) {
    const wx = ox + lx, wz = oz + lz;
    const h = heightAt(wx, wz);
    const beach = h <= SEA + 1;
    for (let y = 0; y <= Math.min(h, WH - 2); y++) {
      const d = h - y;
      let id;
      if (beach) id = d <= 3 ? 4 : 3;
      else if (h >= 45) id = 3;
      else id = d === 0 ? 1 : (d <= 3 ? 2 : 3);
      if (id === 3 && h3(wx, y, wz) > 0.982) id = 13;                              // 煤矿
      else if (id === 3 && y < 34 && h3(wx + 77, y * 3, wz - 31) > 0.992) id = 15; // 铁矿（更深更少）
      if (id !== 4 && caveCarve(wx, y, wz, h)) id = 0;                             // 洞穴（含天然洞口）
      if (id) b[idx(lx, y, lz)] = id;
    }
    for (let y = Math.max(h + 1, 0); y <= SEA && y < WH; y++) b[idx(lx, y, lz)] = 5;  // 水
  }
  // 树（含 5 格 padding：最大冠幅半径 3 + 冠心偏移 1 + 1，跨区块不会断枝）
  const PAD = 5;
  for (let lx = -PAD; lx < CH + PAD; lx++) for (let lz = -PAD; lz < CH + PAD; lz++) {
    const wx = ox + lx, wz = oz + lz;
    const t = treeParams(wx, wz);
    if (t) putTree(put, lx, lz, wx, wz, t);
  }
  // 废弃矿洞：只取落在本区块内的片段
  const selfKey = cx + ',' + cz;
  const cellX = Math.floor(ox / MS_CELL), cellZ = Math.floor(oz / MS_CELL);
  for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
    const ms = mineshaftFor(cellX + dx, cellZ + dz);
    if (!ms) continue;
    const arr = ms.byChunk.get(selfKey);
    if (!arr) continue;
    for (const op of arr) {
      if (op.x < ox || op.x >= ox + CH || op.z < oz || op.z >= oz + CH) continue;
      if (op.y < 0 || op.y >= WH) continue;
      const i = (op.y * CH + (op.z - oz)) * CH + (op.x - ox);
      if (op.t === 0) {
        if (b[i] !== 0 && b[i] !== 5) b[i] = 0;        // 只挖固体，别把水挖穿
      } else if (op.t === 13 || op.t === 15) {
        if (b[i] !== 0 && b[i] !== 5) b[i] = op.t;     // 矿脉只嵌在岩层里，不堵巷道
      } else if (b[i] !== 5) {
        b[i] = op.t;
      }
    }
  }
  return b;
}

function getChunk(cx, cz) {
  const k = ckey(cx, cz);
  let c = chunks.get(k);
  if (!c) {
    const blocks = genChunk(cx, cz);
    c = { cx, cz, blocks, mesh: null, water: null, ready: false };
    // 应用存档里对该区块的改动
    for (const [k2, id] of edits) {
      const p = k2.split(',');
      const x = +p[0], y = +p[1], z = +p[2];
      if ((x >> 4) === cx && (z >> 4) === cz && y >= 0 && y < CFG.WH) {
        blocks[(y * CFG.CH + (z & 15)) * CFG.CH + (x & 15)] = id;
      }
    }
    chunks.set(k, c);
  }
  return c;
}
function getBlock(x, y, z) {
  if (y < 0) return 3;
  if (y >= CFG.WH) return 0;
  const c = getChunk(x >> 4, z >> 4);
  return c.blocks[(y * CFG.CH + (z & 15)) * CFG.CH + (x & 15)];
}
const isSolid = id => id !== 0 && id !== 5;

function setBlock(x, y, z, id, record = true) {
  if (y < 0 || y >= CFG.WH) return;
  const cx = x >> 4, cz = z >> 4;
  const c = getChunk(cx, cz);
  c.blocks[(y * CFG.CH + (z & 15)) * CFG.CH + (x & 15)] = id;
  if (record) {
    if (edits.size > 40000) edits.clear();
    edits.set(x + ',' + y + ',' + z, id);
  }
  dirty.add(c);
  const lx = x & 15, lz = z & 15;
  if (lx === 0) markDirty(cx - 1, cz);
  if (lx === 15) markDirty(cx + 1, cz);
  if (lz === 0) markDirty(cx, cz - 1);
  if (lz === 15) markDirty(cx, cz + 1);
}
// 出生点：从 (8,8) 向外找一块高于海面的陆地，别让玩家出生就泡在水里
function findSpawn() {
  for (let r = 0; r < 80; r++) {
    for (let dx = -r; dx <= r; dx++) for (let dz = -r; dz <= r; dz++) {
      if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
      const x = 8 + dx, z = 8 + dz, h = heightAt(x, z);
      if (h > CFG.SEA + 3 && h < 42) return { x: x + 0.5, y: h + 1.05, z: z + 0.5 };
    }
  }
  return { x: 8.5, y: 55, z: 8.5 };
}
function surfaceY(x, z) {
  for (let y = CFG.WH - 2; y > 0; y--) { const id = getBlock(x, y, z); if (isSolid(id)) return y; }
  return 1;
}

/* ============================================================ 渲染 */
const app = document.getElementById('app');
const renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance', preserveDrawingBuffer: true });
renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.autoClear = false;
app.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(74, innerWidth / innerHeight, 0.08, 420);
camera.rotation.order = 'YXZ';
scene.fog = new THREE.Fog(0x8fc9ff, 34, 92);
// 方块本身是 MeshBasicMaterial（光照烘在顶点色里），但怪物用 Lambert → 主场景必须有灯，否则全黑
const worldLight = new THREE.HemisphereLight(0xffffff, 0x4a5568, 1.0);
const worldDir = new THREE.DirectionalLight(0xffffff, 0.5);
worldDir.position.set(0.6, 1, 0.35);
scene.add(worldLight, worldDir);

makeAtlas();
const solidMat = new THREE.MeshBasicMaterial({ map: atlasTex, vertexColors: true, fog: true });
const waterMat = new THREE.MeshBasicMaterial({
  map: atlasTex, vertexColors: true, transparent: true, opacity: 0.74,
  depthWrite: false, side: THREE.DoubleSide, fog: true,
});

const FACES = [
  { n: [1, 0, 0], v: [[1, 0, 1], [1, 0, 0], [1, 1, 0], [1, 1, 1]], sh: 0.82 },
  { n: [-1, 0, 0], v: [[0, 0, 0], [0, 0, 1], [0, 1, 1], [0, 1, 0]], sh: 0.82 },
  { n: [0, 1, 0], v: [[0, 1, 1], [1, 1, 1], [1, 1, 0], [0, 1, 0]], sh: 1.0 },
  { n: [0, -1, 0], v: [[0, 0, 0], [1, 0, 0], [1, 0, 1], [0, 0, 1]], sh: 0.52 },
  { n: [0, 0, 1], v: [[0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]], sh: 0.7 },
  { n: [0, 0, -1], v: [[1, 0, 0], [0, 0, 0], [0, 1, 0], [1, 1, 0]], sh: 0.7 },
];
const CORNERS = [[0, 0], [1, 0], [1, 1], [0, 1]];
function faceTile(def, fi) {
  if (fi === 2) return def.top;
  if (fi === 3) return def.bottom ?? def.top;
  return def.side ?? def.top;
}

function buildChunk(chunk) {
  const CH = CFG.CH, WH = CFG.WH;
  const ox = chunk.cx * CH, oz = chunk.cz * CH;
  const P = [], U = [], C = [], I = [];
  const P2 = [], U2 = [], C2 = [], I2 = [];
  let vc = 0, vw = 0;
  for (let y = 0; y < WH; y++) for (let z = 0; z < CH; z++) for (let x = 0; x < CH; x++) {
    const id = chunk.blocks[(y * CH + z) * CH + x];
    if (!id) continue;
    const def = BLOCKS[id];
    if (!def) continue;
    const wx = ox + x, wz = oz + z;
    const water = id === 5;
    for (let fi = 0; fi < 6; fi++) {
      const f = FACES[fi];
      const nb = getBlock(wx + f.n[0], y + f.n[1], wz + f.n[2]);
      if (water) { if (nb !== 0) continue; }
      else if (nb !== 0 && nb !== 5) continue;
      const t = faceTile(def, fi);
      const u0 = (t % ATLAS_COLS) / ATLAS_COLS + 0.0015;
      const v0 = 1 - (((t / ATLAS_COLS) | 0) + 1) / ATLAS_ROWS + 0.0015;
      const iu = 1 / ATLAS_COLS - 0.003, iv = 1 / ATLAS_ROWS - 0.003;
      const jit = 0.95 + h3(wx * 3 + fi, y * 7, wz * 5) * 0.1;
      const s = f.sh * jit;
      const base = water ? vw : vc;
      for (let k = 0; k < 4; k++) {
        const V = f.v[k];
        (water ? P2 : P).push(x + V[0], y + V[1], z + V[2]);
        (water ? U2 : U).push(u0 + CORNERS[k][0] * iu, v0 + CORNERS[k][1] * iv);
        (water ? C2 : C).push(s, s, s);
      }
      (water ? I2 : I).push(base, base + 1, base + 2, base, base + 2, base + 3);
      if (water) vw += 4; else vc += 4;
    }
  }
  const mk = (P_, U_, C_, I_, mat) => {
    if (!P_.length) return null;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(P_, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(U_, 2));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(C_, 3));
    geo.setIndex(I_);
    geo.computeBoundingSphere();
    const m = new THREE.Mesh(geo, mat);
    m.position.set(ox, 0, oz);
    m.frustumCulled = true;
    return m;
  };
  const nm = mk(P, U, C, I, solidMat);
  const nw = mk(P2, U2, C2, I2, waterMat);
  if (chunk.mesh) { scene.remove(chunk.mesh); chunk.mesh.geometry.dispose(); }
  if (chunk.water) { scene.remove(chunk.water); chunk.water.geometry.dispose(); }
  chunk.mesh = nm; chunk.water = nw;
  if (nm) scene.add(nm);
  if (nw) { nw.renderOrder = 2; scene.add(nw); }
  chunk.ready = true;
}

/* ============================================================ 玩家 */
const player = {
  p: new THREE.Vector3(8, 40, 8), v: new THREE.Vector3(),
  yaw: 0, pitch: 0, onGround: false,
  hp: 20, hunger: 20, alive: true,
  swing: 0, walkPhase: 0, fallFrom: null, inWater: false,
  sel: 0, mining: 0, mineTarget: null, atkCd: 0, hits: 0, kills: 0,
  spawn: null, stepUp: true,
  armor: { head: null, chest: null, legs: null, feet: null },
};
const ARMOR_SLOTS = ['head', 'chest', 'legs', 'feet'];
const ARMOR_SLOT_NAME = { head: '头盔', chest: '胸甲', legs: '护腿', feet: '靴子' };
function armorPoints() {
  let ap = 0;
  for (const s of ARMOR_SLOTS) { const a = player.armor[s]; if (a && ITEMS[a]) ap += ITEMS[a].ap || 0; }
  return ap;
}
function equipArmor(itemId) {
  const def = ITEMS[itemId];
  if (!def || def.kind !== 'armor') return false;
  const prev = player.armor[def.slot];
  player.armor[def.slot] = itemId;
  takeItem(itemId, 1);
  if (prev) addItem(prev, 1);
  sfx('craft');
  toast(`装备 ${def.name}（护甲 ${armorPoints()}）`, 1.5);
  renderHotbar(); renderInventoryPanel(); saveSoon();
  return true;
}
let inv = [];   // [{id,n}]
const SLOTS = 27;

function addItem(id, n = 1) {
  if (!isItem(id)) return false;
  for (const s of inv) if (s.id === id && s.n < 64) { const add = Math.min(64 - s.n, n); s.n += add; n -= add; if (!n) return true; }
  while (n > 0 && inv.length < SLOTS) { const add = Math.min(64, n); inv.push({ id, n: add }); n -= add; }
  return n === 0;
}
function countOf(id) { let n = 0; for (const s of inv) if (s.id === id) n += s.n; return n; }
function takeItem(id, n) {
  for (let i = 0; i < inv.length && n > 0; i++) {
    if (inv[i].id !== id) continue;
    const take = Math.min(inv[i].n, n);
    inv[i].n -= take; n -= take;
    if (inv[i].n <= 0) inv.splice(i--, 1);
  }
  return n === 0;
}
const held = () => inv[player.sel] || null;
const heldKind = () => { const h = held(); return h ? (defOf(h.id) || {}).kind : null; };
const hasPick = () => inv.some(s => (defOf(s.id) || {}).kind === 'pick');

function collides(px, py, pz) {
  const hw = CFG.HW, h = CFG.PH;
  const x0 = Math.floor(px - hw), x1 = Math.floor(px + hw);
  const y0 = Math.floor(py + 0.001), y1 = Math.floor(py + h - 0.001);
  const z0 = Math.floor(pz - hw), z1 = Math.floor(pz + hw);
  for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++)
    if (isSolid(getBlock(x, y, z))) return true;
  return false;
}
// 逐轴移动 + 碰撞（分小步，避免高速穿墙）
function moveBody(ent, dx, dy, dz) {
  const old = ent.p.clone();
  const steps = Math.max(1, Math.ceil(Math.max(Math.abs(dx), Math.abs(dy), Math.abs(dz)) / 0.22));
  const wasGround = ent.onGround;
  ent.onGround = false;
  const tryStep = (ax, az) => {                       // 走到 1 格高的台阶前自动抬腿
    if (!ent.stepUp || !wasGround) return false;
    const upY = ent.p.y + 1.02;
    if (collides(ent.p.x + ax, upY, ent.p.z + az)) return false;
    ent.p.y = upY; ent.p.x += ax; ent.p.z += az;
    return true;
  };
  for (let i = 0; i < steps; i++) {
    const sx = dx / steps, sy = dy / steps, sz = dz / steps;
    if (sx) {
      ent.p.x += sx;
      if (collides(ent.p.x, ent.p.y, ent.p.z)) {
        ent.p.x -= sx;
        if (!tryStep(sx, 0)) ent.v.x = 0;
      }
    }
    if (sz) {
      ent.p.z += sz;
      if (collides(ent.p.x, ent.p.y, ent.p.z)) {
        ent.p.z -= sz;
        if (!tryStep(0, sz)) ent.v.z = 0;
      }
    }
    if (sy) {
      ent.p.y += sy;
      if (collides(ent.p.x, ent.p.y, ent.p.z)) {
        ent.p.y -= sy;
        if (sy < 0) ent.onGround = true;
        ent.v.y = 0;
      }
    }
  }
  ent.lastDelta = { dx: ent.p.x - old.x, dy: ent.p.y - old.y, dz: ent.p.z - old.z };
}
function blockBoxBlocks(x, y, z) {
  const hw = CFG.HW, h = CFG.PH, p = player.p;
  return (x + 1 > p.x - hw && x < p.x + hw && y + 1 > p.y && y < p.y + h && z + 1 > p.z - hw && z < p.z + hw);
}

/* ============================================================ 射线选块 */
function raycastVoxel(origin, dir, maxDist) {
  let x = Math.floor(origin.x), y = Math.floor(origin.y), z = Math.floor(origin.z);
  const stepX = dir.x > 0 ? 1 : dir.x < 0 ? -1 : 0;
  const stepY = dir.y > 0 ? 1 : dir.y < 0 ? -1 : 0;
  const stepZ = dir.z > 0 ? 1 : dir.z < 0 ? -1 : 0;
  const invX = dir.x !== 0 ? 1 / Math.abs(dir.x) : Infinity;
  const invY = dir.y !== 0 ? 1 / Math.abs(dir.y) : Infinity;
  const invZ = dir.z !== 0 ? 1 / Math.abs(dir.z) : Infinity;
  let tMaxX = stepX === 0 ? Infinity : ((stepX > 0 ? x + 1 - origin.x : origin.x - x)) * invX;
  let tMaxY = stepY === 0 ? Infinity : ((stepY > 0 ? y + 1 - origin.y : origin.y - y)) * invY;
  let tMaxZ = stepZ === 0 ? Infinity : ((stepZ > 0 ? z + 1 - origin.z : origin.z - z)) * invZ;
  let nx = 0, ny = 0, nz = 0, t = 0;
  for (let i = 0; i < 200; i++) {
    const id = getBlock(x, y, z);
    if (id !== 0 && id !== 5) return { x, y, z, nx, ny, nz, id, dist: t };
    if (tMaxX < tMaxY && tMaxX < tMaxZ) { x += stepX; t = tMaxX; tMaxX += invX; nx = -stepX; ny = 0; nz = 0; }
    else if (tMaxY < tMaxZ) { y += stepY; t = tMaxY; tMaxY += invY; nx = 0; ny = -stepY; nz = 0; }
    else { z += stepZ; t = tMaxZ; tMaxZ += invZ; nx = 0; ny = 0; nz = -stepZ; }
    if (t > maxDist) return null;
    if (y < -2 || y > CFG.WH + 1) return null;
  }
  return null;
}

/* ============================================================ 第一人称手臂 */
const handScene = new THREE.Scene();
const handCam = new THREE.PerspectiveCamera(72, innerWidth / innerHeight, 0.02, 12);
handScene.add(new THREE.HemisphereLight(0xffffff, 0x556677, 1.15));
const dl = new THREE.DirectionalLight(0xffffff, 0.75);
dl.position.set(0.4, 1, 0.8);
handScene.add(dl);

const SKIN = 0xd99f6c, SLEEVE = 0x3f7f8c, SLEEVE2 = 0x2f6672;
function makeArm(side) {
  const g = new THREE.Group();
  const sleeveMat = new THREE.MeshLambertMaterial({ color: side > 0 ? SLEEVE : SLEEVE2 });
  const skinMat = new THREE.MeshLambertMaterial({ color: SKIN });
  const arm = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.12, 0.46), skinMat);
  arm.position.z = -0.3;
  const sleeve = new THREE.Mesh(new THREE.BoxGeometry(0.148, 0.148, 0.17), sleeveMat);
  sleeve.position.z = -0.11;
  const cuff = new THREE.Mesh(new THREE.BoxGeometry(0.155, 0.155, 0.04), new THREE.MeshLambertMaterial({ color: 0x244f5a }));
  cuff.position.z = -0.215;
  const hand = new THREE.Mesh(new THREE.BoxGeometry(0.145, 0.145, 0.13), new THREE.MeshLambertMaterial({ color: 0xe0aa77 }));
  hand.position.z = -0.56;
  g.add(arm, sleeve, cuff, hand);
  return g;
}
const armR = makeArm(1), armL = makeArm(-1);
armR.position.set(0.3, -0.3, -0.26);
armR.rotation.set(-0.2, -0.34, 0.12);
armL.position.set(-0.28, -0.26, -0.25);
armL.rotation.set(-0.26, 0.4, -0.12);
handScene.add(armR, armL);

// ── 手持物：方块立方体 / 工具模型（镐、剑、木棍、苹果）都握在右手里 ──
const heldGroup = new THREE.Group();
heldGroup.position.set(0.01, -0.02, -0.54);
armR.add(heldGroup);
let heldMesh = null, heldFor = -2, heldKindNow = null;
const faceTexCache = new Map();
function blockFaceMat(tile) {
  if (faceTexCache.has(tile)) return faceTexCache.get(tile);
  const tx = atlasTex.clone();
  tx.needsUpdate = true;
  tx.repeat.set(1 / ATLAS_COLS, 1 / ATLAS_ROWS);
  tx.offset.set((tile % ATLAS_COLS) / ATLAS_COLS, 1 - (((tile / ATLAS_COLS) | 0) + 1) / ATLAS_ROWS);
  const m = new THREE.MeshLambertMaterial({ map: tx });
  faceTexCache.set(tile, m);
  return m;
}
// 工具模型：原点在握把处，沿 +Y 伸出；母材质在 handScene 里是有灯的
function makeToolModel(id) {
  const g = new THREE.Group();
  const wood = new THREE.MeshLambertMaterial({ color: 0xb08348 });
  const woodDark = new THREE.MeshLambertMaterial({ color: 0x8a6134 });
  const stoneM = new THREE.MeshLambertMaterial({ color: 0xa9a9a9 });
  const stoneD = new THREE.MeshLambertMaterial({ color: 0x8b8b8b });
  if (id === 100 || id === 101) {              // 镐
    const head = id === 101 ? stoneM : wood;
    const handle = new THREE.Mesh(new THREE.BoxGeometry(0.042, 0.52, 0.042), woodDark);
    handle.position.y = -0.1;
    const bar = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.085, 0.075), head);
    bar.position.y = 0.17;
    const tipL = new THREE.Mesh(new THREE.BoxGeometry(0.13, 0.075, 0.07), head);
    tipL.position.set(-0.19, 0.13, 0);
    tipL.rotation.z = -0.42;
    const tipR = new THREE.Mesh(new THREE.BoxGeometry(0.13, 0.075, 0.07), head);
    tipR.position.set(0.19, 0.13, 0);
    tipR.rotation.z = 0.42;
    g.add(handle, bar, tipL, tipR);
  } else if (id === 102 || id === 103) {       // 剑
    const bladeMat = id === 103 ? stoneD : new THREE.MeshLambertMaterial({ color: 0xd9c49b });
    const blade = new THREE.Mesh(new THREE.BoxGeometry(0.058, 0.44, 0.018), bladeMat);
    blade.position.y = 0.3;
    const tip = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.07, 0.018), bladeMat);
    tip.position.y = 0.55;
    const guard = new THREE.Mesh(new THREE.BoxGeometry(0.19, 0.032, 0.05), woodDark);
    guard.position.y = 0.07;
    const grip = new THREE.Mesh(new THREE.BoxGeometry(0.044, 0.16, 0.044), wood);
    grip.position.y = -0.02;
    const pommel = new THREE.Mesh(new THREE.BoxGeometry(0.055, 0.045, 0.055), woodDark);
    pommel.position.y = -0.11;
    g.add(blade, tip, guard, grip, pommel);
  } else if (id === 104) {                     // 木棍
    const s = new THREE.Mesh(new THREE.BoxGeometry(0.032, 0.44, 0.032), wood);
    s.position.y = 0.12;
    g.add(s);
  } else if (id === 105) {                     // 苹果
    const a = new THREE.Mesh(new THREE.BoxGeometry(0.115, 0.11, 0.115), new THREE.MeshLambertMaterial({ color: 0xd33b3b }));
    a.position.y = 0.1;
    const leaf = new THREE.Mesh(new THREE.BoxGeometry(0.075, 0.022, 0.045), new THREE.MeshLambertMaterial({ color: 0x4c9a3a }));
    leaf.position.set(0.035, 0.17, 0);
    const stem = new THREE.Mesh(new THREE.BoxGeometry(0.014, 0.05, 0.014), woodDark);
    stem.position.set(0, 0.16, 0);
    g.add(a, leaf, stem);
  }
  return g;
}
// 握持姿势：方块是斜着摆在掌心，工具是斜举（镐头/剑尖朝前上）
const HOLD_POSE = {
  block: { rx: 0.2, ry: 0.6, rz: 0.1, py: 0, pz: 0, s: 1 },
  pick: { rx: -0.32, ry: 0.95, rz: 0.36, py: 0.07, pz: -0.12, s: 0.95 },
  sword: { rx: -0.5, ry: 0.45, rz: -0.15, py: 0.07, pz: -0.12, s: 0.92 },
  mat: { rx: -0.45, ry: 0.45, rz: -0.25, py: 0.06, pz: -0.1, s: 0.95 },
  food: { rx: 0.1, ry: 0.45, rz: 0.18, py: 0.06, pz: -0.1, s: 1.0 },
};
function refreshHeld() {
  const h = held();
  const id = h ? h.id : -1;
  if (id === heldFor) return;
  heldFor = id;
  if (heldMesh) {
    heldGroup.remove(heldMesh);
    heldMesh.traverse(o => { if (o.geometry) o.geometry.dispose(); });
    heldMesh = null;
  }
  const b = id > 0 ? BLOCKS[id] : null;
  const it = id > 0 ? ITEMS[id] : null;
  let kind = null;
  if (b) {
    kind = 'block';
    const mats = [b.side, b.side, b.top, b.bottom ?? b.top, b.side, b.side].map(blockFaceMat);
    heldMesh = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.2, 0.2), mats);
  } else if (it && (it.kind === 'pick' || it.kind === 'sword' || it.kind === 'mat' || it.kind === 'food')) {
    kind = it.kind;
    heldMesh = makeToolModel(id);
  }
  heldKindNow = kind;
  if (!heldMesh) { heldGroup.visible = false; return; }
  const pose = HOLD_POSE[kind] || HOLD_POSE.block;
  heldGroup.position.set(0.01, pose.py, -0.54 + pose.pz);
  heldGroup.rotation.set(pose.rx, pose.ry, pose.rz);
  heldGroup.scale.setScalar(pose.s || 1);
  heldGroup.add(heldMesh);
  heldGroup.visible = true;
}

/* ── 手部动画：抬腕 → 加速下砸 → 缓慢回收，带视角拖尾/走路摆动/切枪/落地缓冲 ── */
const easeOutCubic = t => 1 - Math.pow(1 - clamp01(t), 3);
const easeInQuad = t => { const x = clamp01(t); return x * x; };
// p: 0..1 的循环进度；windEnd 抬到位、hitEnd 砸到位 → 返回 -1(抬起) .. +1(砸下)
function swingCurve(p, windEnd, hitEnd) {
  if (p < windEnd) return -easeOutCubic(p / windEnd);
  if (p < hitEnd) return -1 + 2 * easeInQuad((p - windEnd) / (hitEnd - windEnd));
  return 1 - easeOutCubic((p - hitEnd) / (1 - hitEnd));
}
const anim = {
  swing: 0, swingDur: 0.5, swingType: 'attack', swingA: 0,
  equip: 0, equipDur: 0.32,
  mineW: 0, mineT: 0,
  swayX: 0, swayY: 0, lastYaw: 0, lastPitch: 0,
  land: 0, lastSel: -1, lastGround: true,
};
const BASE_POSE = { x: 0.27, y: -0.22, z: -0.27, rx: -0.2, ry: -0.34, rz: 0.12 };
function startSwing(type = 'attack', dur = 0.5) {
  anim.swingType = type;
  anim.swingDur = dur;
  anim.swing = dur;
}
function updateHandPose(dt, now) {
  // 切换物品 → 从下方抬上来的装备动画
  if (anim.lastSel !== player.sel) {
    if (anim.lastSel >= 0) anim.equip = anim.equipDur;
    anim.lastSel = player.sel;
  }
  // 视角拖尾：手比镜头慢半拍（Action & Stuff 的核心手感）
  const dyaw = player.yaw - anim.lastYaw, dpitch = player.pitch - anim.lastPitch;
  anim.lastYaw = player.yaw; anim.lastPitch = player.pitch;
  const smoothK = Math.min(1, dt * 11);
  const wantX = clamp(-dyaw * 2.6, -0.15, 0.15);
  const wantY = clamp(dpitch * 2.6, -0.15, 0.15);
  anim.swayX += (wantX - anim.swayX) * smoothK;
  anim.swayY += (wantY - anim.swayY) * smoothK;
  if (Math.abs(dyaw) < 1e-6) anim.swayX *= 1 - Math.min(1, dt * 2.5);
  if (Math.abs(dpitch) < 1e-6) anim.swayY *= 1 - Math.min(1, dt * 2.5);

  let px = BASE_POSE.x + anim.swayX;
  let py = BASE_POSE.y + anim.swayY;
  let pz = BASE_POSE.z;
  let rx = BASE_POSE.rx, ry = BASE_POSE.ry + anim.swayX * 0.4, rz = BASE_POSE.rz;

  // 呼吸 + 走路摆动（速度越大摆得越明显）
  const t = now / 1000;
  const spd = Math.hypot(player.v.x, player.v.z);
  const walkAmt = clamp01(spd / CFG.WALK);
  py += Math.sin(t * 1.5) * 0.0045 + Math.sin(player.walkPhase * 2) * 0.014 * walkAmt;
  px += Math.cos(player.walkPhase) * 0.008 * walkAmt;
  rz += Math.sin(player.walkPhase) * 0.022 * walkAmt;

  // 挖掘：0.5 秒一轮的缓慢抬砸（旧版是 0.18 秒猛抖，眼睛会花）
  const mining = mineHeld && player.alive && !!player.mineTarget;
  anim.mineW += ((mining ? 1 : 0) - anim.mineW) * Math.min(1, dt * 9);
  if (mining) anim.mineT += dt; else anim.mineT = 0;
  let aTotal = 0;
  if (anim.mineW > 0.01) {
    const p = (anim.mineT % 0.5) / 0.5;
    const a = swingCurve(p, 0.52, 0.70);
    aTotal += a * anim.mineW;
  }
  // 单次挥击（攻击 / 放置）
  if (anim.swing > 0) {
    anim.swing = Math.max(0, anim.swing - dt);
    const p = 1 - anim.swing / anim.swingDur;
    const a = anim.swingType === 'attack' ? swingCurve(p, 0.3, 0.52)
            : Math.sin(clamp01(p) * Math.PI);      // 放置 = 轻轻一推
    anim.swingA = a;
    aTotal += a * (anim.swingType === 'attack' ? 1 : 0.55);
  } else anim.swingA = 0;

  rx += aTotal * 0.62;
  pz += -0.05 * Math.max(0, aTotal);
  rz += aTotal * 0.1;

  // 装备动画
  if (anim.equip > 0) {
    anim.equip = Math.max(0, anim.equip - dt);
    const dip = 1 - easeOutCubic(1 - anim.equip / anim.equipDur);
    py -= 0.34 * dip;
    rz += 0.3 * dip;
    rx += 0.22 * dip;
  }
  // 落地缓冲
  anim.land = Math.max(0, anim.land - dt * 3.2);
  py -= anim.land * 0.035;

  armR.position.set(px, py, pz);
  armR.rotation.set(rx, ry, rz);
  armL.position.set(-0.28 - anim.swayX * 0.5, -0.26 + anim.swayY * 0.6 - anim.land * 0.03, -0.25);
  armL.rotation.set(-0.26 + aTotal * 0.12, 0.4, -0.12);

  // 手里的东西也跟着挥
  if (heldMesh) {
    const pose = HOLD_POSE[heldKindNow] || HOLD_POSE.block;
    heldGroup.rotation.set(pose.rx + aTotal * 0.3, pose.ry - aTotal * 0.1, pose.rz + aTotal * 0.18);
    heldGroup.position.set(0.01, pose.py - Math.max(0, aTotal) * 0.02, -0.54 + pose.pz - Math.max(0, aTotal) * 0.05);
  }
}

/* ============================================================ 音效 */
let AC = null, sfxBus = null, wetGain = null;
let underground = false, echoTimer = 0.4, dripTimer = 3, caveMix = 0;
// 回声总线：干声 + 一条带反馈的延迟（洞窟混响）
function initAudioChain() {
  if (!AC || sfxBus) return;
  sfxBus = AC.createGain();
  const dry = AC.createGain(); dry.gain.value = 1;
  const wet = AC.createGain(); wet.gain.value = 0.05;
  const delay = AC.createDelay(0.6); delay.delayTime.value = 0.17;
  const fb = AC.createGain(); fb.gain.value = 0.34;
  const lp = AC.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 1500;
  sfxBus.connect(dry); dry.connect(AC.destination);
  sfxBus.connect(delay); delay.connect(lp);
  lp.connect(fb); fb.connect(delay);
  lp.connect(wet); wet.connect(AC.destination);
  wetGain = wet;
}
// 头顶一直到世界顶有没有实体方块 —— 有就是地下（原来是只扫 24 格，大洞窟会漏判成"地表"）
function isSkyLit(x, y, z) {
  for (let yy = y; yy < CFG.WH; yy++) if (isSolid(getBlock(x, yy, z))) return false;
  return true;
}
function isUnderground() {
  return !isSkyLit(Math.floor(player.p.x), Math.floor(player.p.y + 1.8), Math.floor(player.p.z));
}
// 该位置是否够暗（能被刷怪）：有顶 → 暗；露天 → 只有夜里暗
function isDarkAt(x, y, z) {
  if (!isSkyLit(x, y, z)) return true;
  return lightLevel < 0.35;
}
function playDrip() {
  if (!AC || !sfxBus) return;
  const t = AC.currentTime;
  const o = AC.createOscillator(), g = AC.createGain();
  o.type = 'sine';
  o.frequency.setValueAtTime(1400 + Math.random() * 900, t);
  o.frequency.exponentialRampToValueAtTime(400, t + 0.14);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(0.05, t + 0.012);
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.32);
  o.connect(g); g.connect(sfxBus);
  o.start(t); o.stop(t + 0.34);
}
function sfx(kind) {
  if (!AC) return;
  if (!sfxBus) initAudioChain();
  const t = AC.currentTime;
  const o = AC.createOscillator(), g = AC.createGain();
  o.connect(g); g.connect(sfxBus);
  if (kind === 'dig') { o.type = 'square'; o.frequency.setValueAtTime(150, t); o.frequency.exponentialRampToValueAtTime(70, t + 0.11); g.gain.setValueAtTime(0.10, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.12); o.start(t); o.stop(t + 0.13); }
  else if (kind === 'place') { o.type = 'triangle'; o.frequency.setValueAtTime(320, t); o.frequency.exponentialRampToValueAtTime(180, t + 0.08); g.gain.setValueAtTime(0.10, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.1); o.start(t); o.stop(t + 0.11); }
  else if (kind === 'hit') { o.type = 'sawtooth'; o.frequency.setValueAtTime(220, t); o.frequency.exponentialRampToValueAtTime(90, t + 0.14); g.gain.setValueAtTime(0.12, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.15); o.start(t); o.stop(t + 0.16); }
  else if (kind === 'hurt') { o.type = 'square'; o.frequency.setValueAtTime(120, t); o.frequency.exponentialRampToValueAtTime(55, t + 0.2); g.gain.setValueAtTime(0.16, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.22); o.start(t); o.stop(t + 0.23); }
  else if (kind === 'craft') { o.type = 'triangle'; o.frequency.setValueAtTime(420, t); o.frequency.exponentialRampToValueAtTime(720, t + 0.1); g.gain.setValueAtTime(0.1, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.14); o.start(t); o.stop(t + 0.15); }
  else if (kind === 'eat') { o.type = 'sine'; o.frequency.setValueAtTime(250, t); o.frequency.linearRampToValueAtTime(160, t + 0.18); g.gain.setValueAtTime(0.12, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.2); o.start(t); o.stop(t + 0.21); }
}

/* ============================================================ 时间 / 天空 */
let worldTime = CFG.DAY * 0.02;   // 从清晨开始
let lightLevel = 1;
const skyDay = new THREE.Color(0x8fc9ff), skyNight = new THREE.Color(0x0a1024), skySet = new THREE.Color(0xff9a5a);
const caveCol = new THREE.Color(0x0a0f15);
const skyNow = new THREE.Color();
function updateSky() {
  const f = ((worldTime / CFG.DAY) % 1 + 1) % 1;
  const sunAlt = Math.sin(f * Math.PI * 2); // f=0 黎明, .25 正午, .5 黄昏, .75 午夜
  const day = smooth(-0.12, 0.3, sunAlt);
  lightLevel = 0.22 + 0.78 * day;
  skyNow.copy(skyNight).lerp(skyDay, day);
  const sunset = clamp01(1 - Math.abs(sunAlt) / 0.32) * clamp01(day * 3 + 0.2);
  skyNow.lerp(skySet, sunset * 0.55);
  // 在地下：把"天空"换成洞窟暗色（否则洞穴空腔会被画成一片蓝天，像露天地沟）
  if (caveMix > 0.002) skyNow.lerp(caveCol, caveMix);
  scene.background = skyNow;
  scene.fog.color.copy(skyNow);
  scene.fog.near = 34 - 20 * caveMix;
  scene.fog.far = 92 - 40 * caveMix;
  const f2 = (0.4 + 0.6 * lightLevel) * (underground ? 0.62 : 1);
  worldLight.intensity = 0.45 + 0.55 * lightLevel;
  worldDir.intensity = 0.22 + 0.45 * lightLevel;
  solidMat.color.setScalar(f2);
  waterMat.color.setScalar(f2 * 1.05);
  dl.intensity = 0.25 + 0.75 * lightLevel;
  return day;
}
const isNight = () => lightLevel < 0.5;
function clockText() {
  const f = ((worldTime / CFG.DAY) % 1 + 1) % 1;
  const hours = (6 + f * 24) % 24;
  const hh = Math.floor(hours), mm = Math.floor((hours - hh) * 60);
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

/* ============================================================ 怪物 */
let MINE_PIN = null;
const mobs = [];
const MOB_MAXHP = 20;
const MOB_NAME = '夜行怪';

// 每只怪单独克隆材质，才能单独闪红；附带头顶血条（面向相机的 billboard）
function makeGrunt() {
  const bodyMat = new THREE.MeshLambertMaterial({ color: 0x2f5d5a });
  const headMat = new THREE.MeshLambertMaterial({ color: 0x9fd8c8 });
  const eyeMat = new THREE.MeshBasicMaterial({ color: 0xff4d4d });
  const g = new THREE.Group();
  // core 是"身体中心"，绕它倒地方便（直接绕脚底转会插进地里）
  const core = new THREE.Group();
  core.position.y = 0.62;
  const body = new THREE.Mesh(new THREE.BoxGeometry(0.62, 0.86, 0.44), bodyMat);
  body.position.y = -0.18;
  const head = new THREE.Mesh(new THREE.BoxGeometry(0.46, 0.42, 0.44), headMat);
  head.position.y = 0.46;
  const e1 = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.08, 0.03), eyeMat);
  e1.position.set(-0.11, 0.5, 0.23);
  const e2 = e1.clone(); e2.position.x = 0.11;
  const arm1 = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.5, 0.16), bodyMat);
  arm1.position.set(-0.39, 0.0, 0);
  const arm2 = arm1.clone(); arm2.position.x = 0.39;
  core.add(body, head, e1, e2, arm1, arm2);
  const barBg = new THREE.Mesh(new THREE.PlaneGeometry(0.8, 0.11), new THREE.MeshBasicMaterial({ color: 0x140c0c }));
  const barFg = new THREE.Mesh(new THREE.PlaneGeometry(0.72, 0.055), new THREE.MeshBasicMaterial({ color: 0x7fe06b }));
  barFg.position.set(0, 0, 0.004);
  const bar = new THREE.Group();
  bar.position.y = 1.44;
  bar.add(barBg, barFg);
  g.add(core, bar);
  return { g, core, bodyMat, headMat, arm1, arm2, bar, barFg };
}

// 找一个"黑暗的空腔"：地下（玩家上下 8 格范围内）或夜里露天地面
function findSpawnSpot() {
  const okSpot = (x, y, z) =>
    getBlock(x, y, z) === 0 && getBlock(x, y + 1, z) === 0 &&     // 脚下/头部要空
    isSolid(getBlock(x, y - 1, z)) &&                            // 要有地板
    isDarkAt(x, y, z);                                          // 必须够暗
  for (let t = 0; t < 14; t++) {
    const ang = Math.random() * Math.PI * 2, dist = 8 + Math.random() * 14;
    const x = Math.floor(player.p.x + Math.cos(ang) * dist);
    const z = Math.floor(player.p.z + Math.sin(ang) * dist);
    if (Math.random() < 0.75) {
      // 地下：从玩家上方往下扫，找第一个能站的暗空腔（矿道/洞穴地面）
      const yTop = Math.min(CFG.WH - 3, Math.floor(player.p.y) + 5);
      const yBot = Math.max(3, Math.floor(player.p.y) - 10);
      for (let y = yTop; y >= yBot; y--) if (okSpot(x, y, z)) return { x, y, z };
    } else {
      const y = surfaceY(x, z) + 1;
      if (okSpot(x, y, z)) return { x, y, z };
    }
  }
  return null;
}
function spawnMob(offset) {
  let x, y, z;
  if (offset) {
    x = Math.floor(player.p.x + offset[0]);
    z = Math.floor(player.p.z + offset[1]);
    y = surfaceY(x, z) + 1;
  } else {
    const spot = findSpawnSpot();
    if (!spot) return null;
    x = spot.x; y = spot.y; z = spot.z;
  }
  if (getBlock(x, y, z) !== 0 || getBlock(x, y + 1, z) !== 0) return null;
  const parts = makeGrunt();
  const m = {
    p: new THREE.Vector3(x + 0.5, y + 0.02, z + 0.5), v: new THREE.Vector3(),
    hp: MOB_MAXHP, onGround: false, atkCd: 0, phase: Math.random() * 9,
    wander: 0, dir: new THREE.Vector2(), flash: 0, aggro: 0,
    dying: false, dieT: 0, stepUp: true,
    obj: parts.g, parts,
  };
  m.obj.position.copy(m.p);
  scene.add(m.obj);
  mobs.push(m);
  return m;
}

const aliveMobs = () => mobs.filter(m => !m.dying).length;
// 死亡：先瘫软倒地（0.55s），躺 5 秒，然后缩小消失（1.1s）
const MOB_DEATH_HOLD = 5, MOB_DEATH_FADE = 1.1;
function startMobDeath(m) {
  m.dying = true;
  m.dieT = 0;
  m.hp = 0;
  m.aggro = 0;
  m.v.set(0, 0, 0);
  m.parts.bar.visible = false;
  m.parts.bodyMat.emissive.setHex(0x000000);
  m.parts.headMat.emissive.setHex(0x000000);
  sfx('hurt');
}
function killMob(m) {
  scene.remove(m.obj);
  m.obj.traverse(o => {
    if (o.geometry) o.geometry.dispose();
    if (o.material) { if (Array.isArray(o.material)) o.material.forEach(x => x.dispose()); else o.material.dispose(); }
  });
}

function updateMobs(dt) {
  const night = isNight();
  for (let i = mobs.length - 1; i >= 0; i--) {
    const m = mobs[i];
    const dx = player.p.x - m.p.x, dz = player.p.z - m.p.z;
    const dist = Math.hypot(dx, dz);
    // —— 死亡流程：瘫软倒地 → 躺 5 秒 → 缩小消失 ——
    if (m.dying) {
      m.dieT += dt;
      const fall = easeOutCubic(clamp01(m.dieT / 0.55));
      m.parts.core.rotation.x = -1.42 * fall;
      m.parts.core.rotation.z = 0.32 * fall;
      m.parts.core.position.y = 0.62 - 0.28 * fall;
      m.parts.arm1.rotation.x = -0.5 * fall;
      m.parts.arm2.rotation.x = 0.35 * fall;
      m.parts.bar.visible = false;
      if (m.dieT > MOB_DEATH_HOLD) {
        const k = clamp01((m.dieT - MOB_DEATH_HOLD) / MOB_DEATH_FADE);
        const s = 1 - k;
        m.obj.scale.setScalar(Math.max(0.001, s));
        m.obj.position.y = m.p.y - 0.3 * k;
        if (s <= 0.03 || dist > 40) { killMob(m); mobs.splice(i, 1); }
      }
      continue;
    }
    const hostile = night || m.aggro > 0;
    m.flash = Math.max(0, m.flash - dt);
    m.aggro = Math.max(0, m.aggro - dt);
    if (m.hp <= 0) { startMobDeath(m); continue; }
    if (dist > 70 || (!hostile && dist > 30)) {
      killMob(m);
      mobs.splice(i, 1);
      continue;
    }
    let mx = 0, mz = 0;
    const chase = hostile && dist < 26 && player.alive;
    if (chase) {
      mx = dx / (dist || 1); mz = dz / (dist || 1);
    } else {
      m.wander -= dt;
      if (m.wander <= 0) { m.wander = 1.5 + Math.random() * 2.5; const a = Math.random() * Math.PI * 2; m.dir.set(Math.cos(a), Math.sin(a)); }
      mx = m.dir.x * 0.4; mz = m.dir.y * 0.4;
    }
    const spd = chase ? 2.9 : 1.2;
    m.v.x = mx * spd; m.v.z = mz * spd;
    m.v.y -= CFG.GRAV * dt;
    const before = m.p.x, beforeZ = m.p.z;
    moveBody(m, m.v.x * dt, m.v.y * dt, m.v.z * dt);
    if (m.onGround && (Math.abs(m.p.x - before) < 0.001 || Math.abs(m.p.z - beforeZ) < 0.001)) m.v.y = CFG.JUMP * 0.85;
    if (m.p.y < -6) m.hp = 0;
    m.obj.rotation.y = Math.atan2(dx, dz);
    m.obj.position.copy(m.p);
    m.phase += dt * (2 + spd);
    m.parts.arm1.rotation.x = Math.sin(m.phase * 3) * 0.5;
    m.parts.arm2.rotation.x = -Math.sin(m.phase * 3) * 0.5;
    // 受击闪红
    const em = m.flash > 0 ? 0xa03030 : 0x000000;
    m.parts.bodyMat.emissive.setHex(em);
    m.parts.headMat.emissive.setHex(em);
    // 血条：面向相机、按血量收缩
    m.parts.bar.visible = m.hp < MOB_MAXHP || dist < 14;
    if (m.parts.bar.visible) {
      m.parts.bar.lookAt(camera.position);
      const f = Math.max(0.02, m.hp / MOB_MAXHP);
      m.parts.barFg.scale.x = f;
      m.parts.barFg.position.x = -(1 - f) * 0.36;
      m.parts.barFg.material.color.setHex(f > 0.55 ? 0x7fe06b : f > 0.25 ? 0xf0c04a : 0xe0524b);
    }
    // 太阳下暴晒（露天 + 白天）会持续掉血
    m.sunTick = (m.sunTick || 0) - dt;
    if (m.sunTick <= 0) {
      m.sunTick = 0.5;
      m.sunlit = isSkyLit(Math.floor(m.p.x), Math.floor(m.p.y + 1.2), Math.floor(m.p.z)) && lightLevel > 0.7;
    }
    if (m.sunlit) {
      m.hp -= dt * 2.2;
      m.parts.bodyMat.emissive.setHex(0x552211);
      if (m.hp <= 0) { startMobDeath(m); continue; }
    }
    // 贴身攻击
    m.atkCd -= dt;
    if (hostile && dist < 1.5 && m.atkCd <= 0 && player.alive && Math.abs(m.p.y - player.p.y) < 1.8) {
      m.atkCd = 1.6;
      damagePlayer(3);
    }
  }
  const cap = night ? CFG.MAX_MOBS + 2 : CFG.MAX_MOBS;
  const rate = 0.85;
  if (aliveMobs() < cap && Math.random() < dt * rate) spawnMob();
}

/* ============================================================ 状态 / HUD */
const $ = id => document.getElementById(id);
const hud = {
  status: $('status'), tgt: $('tgt'), mine: $('mine'), mineBar: $('mine').firstElementChild,
  hotbar: $('hotbar'), hearts: $('hearts'), food: $('foodrow'), hint: $('hint'), flash: $('flash'),
  panel: $('panel'), invGrid: $('invGrid'), recList: $('recList'), invCount: $('invCount'),
  start: $('start'), death: $('death'), deathMsg: $('deathMsg'),
};
let hintTimer = 0;
function toast(msg, secs = 2.4) { hud.hint.textContent = msg; hud.hint.style.opacity = '1'; hintTimer = secs; }

function damagePlayer(n) {
  if (!player.alive) return;
  const ap = armorPoints();
  const mul = 1 - Math.min(0.8, ap * 0.04);          // 每点护甲 4% 减伤，上限 80%
  const dmg = Math.max(0.5, n * mul);
  player.hp = Math.max(0, player.hp - dmg);
  hud.flash.style.opacity = '0.35';
  setTimeout(() => { hud.flash.style.opacity = '0'; }, 130);
  sfx('hurt');
  if (player.hp <= 0) die();
}
function die() {
  player.alive = false;
  hud.death.classList.remove('hide');
  hud.deathMsg.textContent = `你在 ${clockText()} 倒下了。背包还在，世界也还在。`;
  if (document.pointerLockElement) document.exitPointerLock();
}
function setSpawnAt(x, y, z) {
  player.spawn = { x: x + 0.5, y: y + 1.05, z: z + 0.5, bed: true };
  toast('重生点已设为这张床', 2.2);
  saveSoon();
}
function respawn() {
  const sp = player.spawn;
  if (sp) {
    player.p.set(sp.x, sp.y, sp.z);
    buildChunk(getChunk(Math.floor(sp.x / CFG.CH), Math.floor(sp.z / CFG.CH)));
  } else {
    const sx = 8, sz = 8;
    player.p.set(sx + 0.5, surfaceY(sx, sz) + 1.2, sz + 0.5);
  }
  player.v.set(0, 0, 0);
  player.hp = 20; player.hunger = 18; player.alive = true;
  player.fallFrom = null;
  worldTime = Math.floor(worldTime / CFG.DAY) * CFG.DAY;
  hud.death.classList.add('hide');
}

/* ---------- 快捷栏 / 背包 ---------- */
function renderHotbar() {
  const row = hud.hotbar;
  row.innerHTML = '';
  for (let i = 0; i < 9; i++) {
    const s = inv[i];
    const d = document.createElement('div');
    d.className = 'slot' + (i === player.sel ? ' sel' : '');
    d.innerHTML = `<span class="k">${i + 1}</span>` +
      (s ? `<img src="${iconURL(s.id)}" alt=""><span class="n">${s.n > 1 ? s.n : ''}</span>` : '');
    d.onclick = () => { player.sel = i; refreshHeld(); renderHotbar(); };
    row.appendChild(d);
  }
}
function renderHearts() {
  const hp = Math.ceil(player.hp / 2);
  let html = '<span class="lbl">生命</span>';
  for (let i = 0; i < 10; i++) html += `<div class="heart">${i < hp ? '<i></i>' : ''}</div>`;
  hud.hearts.innerHTML = html;
  const food = Math.ceil(player.hunger / 2);
  let html2 = '<span class="lbl">饱食</span>';
  for (let i = 0; i < 10; i++) html2 += `<div class="food">${i < food ? '<i></i>' : ''}</div>`;
  hud.food.innerHTML = html2;
}
function renderArmorRow() {
  const row = $('armorGrid');
  if (!row) return;
  row.innerHTML = '';
  for (const s of ARMOR_SLOTS) {
    const id = player.armor[s];
    const d = document.createElement('div');
    d.className = 'cell' + (id ? '' : ' empty');
    d.style.cssText = 'position:relative;border:2px solid #33475e;background:#1b2536;border-radius:3px;aspect-ratio:1';
    d.title = id ? `${ITEMS[id].name}（点击脱下）` : `空 ${ARMOR_SLOT_NAME[s]}`;
    if (id) {
      d.innerHTML = `<img src="${iconURL(id)}" alt="" style="position:absolute;inset:5px;width:calc(100% - 10px);image-rendering:pixelated">`;
      d.onclick = () => {
        addItem(id, 1); player.armor[s] = null;
        toast(`脱下 ${ITEMS[id].name}`, 1.2);
        renderArmorRow(); renderHotbar(); renderInventoryPanel(); saveSoon();
      };
    } else {
      d.innerHTML = `<span style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-size:10px;color:#5d738d">${ARMOR_SLOT_NAME[s]}</span>`;
    }
    row.appendChild(d);
  }
  const v = $('armorVal');
  if (v) v.textContent = `护甲 ${armorPoints()}`;
}
function renderInventoryPanel() {
  renderArmorRow();
  hud.invGrid.innerHTML = '';
  for (let i = 0; i < SLOTS; i++) {
    const s = inv[i];
    const d = document.createElement('div');
    d.className = 'cell';
    if (s) {
      d.innerHTML = `<img src="${iconURL(s.id)}" alt=""><span class="n">${s.n > 1 ? s.n : ''}</span>`;
      d.title = nameOf(s.id);
      d.onclick = () => {
        const df = defOf(s.id) || {};
        if (df.kind === 'armor') { equipArmor(s.id); return; }
        if (i < 9) { player.sel = i; refreshHeld(); renderHotbar(); }
        toast(`选中 ${nameOf(s.id)}`, 1.2);
      };
    }
    hud.invGrid.appendChild(d);
  }
  hud.invCount.textContent = `${inv.length}/${SLOTS}`;
  hud.recList.innerHTML = '';
  const hasTable = nearCraftingTable();
  for (const r of RECIPES) {
    const matsOk = Object.entries(r.need).every(([id, n]) => countOf(+id) >= n);
    const tableOk = r.tier !== 1 || hasTable;
    const ok = matsOk && tableOk;
    const d = document.createElement('div');
    d.className = 'rec' + (ok ? '' : ' no');
    const need = Object.entries(r.need).map(([id, n]) => `${nameOf(+id)}×${n}`).join(' + ');
    const badge = r.tier === 1 ? (hasTable ? '<i style="color:#7fe06b">工作台 ✓</i>' : '<i style="color:#e0a24a">需工作台</i>') : '';
    d.innerHTML = `<img src="${iconURL(r.out)}" alt=""><div class="t">${nameOf(r.out)} ×${r.n}<i>${need}</i>${badge}</div>`
      + `<div class="go">${ok ? '制作 →' : tableOk ? '缺材料' : '需工作台'}</div>`;
    d.onclick = () => { if (!ok) { if (!tableOk) toast('需要站在工作台旁边', 1.5); return; } craft(r); };
    hud.recList.appendChild(d);
  }
}
// tier 1 = 必须站在已放置的工作台旁边才能做（"大工具"）
const RECIPES = [
  { out: 8, n: 4, need: { 6: 1 } },
  { out: 104, n: 4, need: { 8: 2 } },
  { out: 10, n: 1, need: { 8: 4 } },
  { out: 100, n: 1, need: { 8: 3, 104: 2 }, tier: 1 },
  { out: 101, n: 1, need: { 9: 3, 104: 2 }, tier: 1 },
  { out: 102, n: 1, need: { 8: 2, 104: 1 }, tier: 1 },
  { out: 103, n: 1, need: { 9: 2, 104: 1 }, tier: 1 },
  { out: 120, n: 1, need: { 106: 3, 104: 2 }, tier: 1 },
  { out: 121, n: 1, need: { 106: 2, 104: 1 }, tier: 1 },
  { out: 110, n: 1, need: { 106: 5 }, tier: 1 },
  { out: 111, n: 1, need: { 106: 8 }, tier: 1 },
  { out: 112, n: 1, need: { 106: 7 }, tier: 1 },
  { out: 113, n: 1, need: { 106: 4 }, tier: 1 },
  { out: 14, n: 1, need: { 8: 4, 104: 3 }, tier: 1 },
];
// 附近 9×6×9 内是否有已放置的工作台（0.4 秒缓存）
let tableCache = { t: -1, v: false };
function nearCraftingTable() {
  const now = performance.now();
  if (now - tableCache.t < 400) return tableCache.v;
  const px = Math.floor(player.p.x), py = Math.floor(player.p.y), pz = Math.floor(player.p.z);
  let has = false;
  for (let dx = -4; dx <= 4 && !has; dx++) for (let dz = -4; dz <= 4 && !has; dz++) {
    for (let dy = -2; dy <= 3; dy++) if (getBlock(px + dx, py + dy, pz + dz) === 10) { has = true; break; }
  }
  tableCache = { t: now, v: has };
  return has;
}
function craft(r) {
  if (r.tier === 1 && !nearCraftingTable()) { toast('需要站在工作台旁边才能做这个', 1.6); return false; }
  for (const [id, n] of Object.entries(r.need)) if (countOf(+id) < n) return false;
  for (const [id, n] of Object.entries(r.need)) takeItem(+id, n);
  addItem(r.out, r.n);
  sfx('craft');
  toast(`合成 ${nameOf(r.out)} ×${r.n}`, 1.6);
  renderHotbar(); refreshHeld(); renderInventoryPanel(); saveSoon();
  return true;
}
let panelOpen = false;
function openPanel(open) {
  panelOpen = open;
  hud.panel.classList.toggle('hide', !open);
  if (open) {
    renderInventoryPanel();
    if (document.pointerLockElement) document.exitPointerLock();
  } else if (started) lockPointer();
}

/* ============================================================ 输入 */
const keys = new Set();
let mineHeld = false, placeQueued = false, attackQueued = false, jumpQueued = false;
const joy = { x: 0, y: 0, active: false };
let started = false;

function lockPointer() {
  const el = renderer.domElement;
  if (el.requestPointerLock) { try { const r = el.requestPointerLock(); if (r && r.catch) r.catch(() => {}); } catch (e) {} }
}
addEventListener('keydown', e => {
  const k = e.code;
  keys.add(k);
  if (k === 'Space') { jumpQueued = true; e.preventDefault(); }
  if (k === 'KeyE') { if (started) openPanel(!panelOpen); e.preventDefault(); }
  if (k.startsWith('Digit')) {
    const n = +k.slice(5);
    if (n >= 1 && n <= 9) { player.sel = n - 1; refreshHeld(); renderHotbar(); }
  }
  if (k === 'Escape' && panelOpen) openPanel(false);
});
addEventListener('keyup', e => keys.delete(e.code));
addEventListener('wheel', e => {
  if (!started || panelOpen) return;
  player.sel = (player.sel + (e.deltaY > 0 ? 1 : -1) + 9) % 9;
  refreshHeld(); renderHotbar();
}, { passive: true });

renderer.domElement.addEventListener('mousedown', e => {
  if (!started || panelOpen || !player.alive) return;
  if (document.pointerLockElement !== renderer.domElement) { lockPointer(); return; }
  if (e.button === 0) { mineHeld = true; attackQueued = true; if (heldKind() === 'sword') startSwing('attack', 0.5); }
  if (e.button === 2) placeQueued = true;
});
addEventListener('mouseup', e => { if (e.button === 0) mineHeld = false; });
addEventListener('contextmenu', e => e.preventDefault());
addEventListener('mousemove', e => {
  if (!started || panelOpen) return;
  if (document.pointerLockElement === renderer.domElement) {
    player.yaw -= e.movementX * 0.0023;
    player.pitch = clamp(player.pitch - e.movementY * 0.0023, -1.53, 1.53);
  }
});

/* ---------- 触屏 ---------- */
const isTouch = matchMedia('(pointer:coarse)').matches || 'ontouchstart' in window;
if (isTouch) document.body.classList.add('touch');
const stick = $('stick'), knob = $('knob');
let stickId = null, lookId = null, lookLast = null, pinchDist = 0;
stick.addEventListener('touchstart', e => {
  const t = e.changedTouches[0]; stickId = t.identifier; joy.active = true;
  const r = stick.getBoundingClientRect();
  stick.dataset.cx = r.left + r.width / 2; stick.dataset.cy = r.top + r.height / 2;
  e.preventDefault();
}, { passive: false });
addEventListener('touchmove', e => {
  for (const t of e.changedTouches) {
    if (t.identifier === stickId) {
      const cx = +stick.dataset.cx, cy = +stick.dataset.cy;
      let dx = t.clientX - cx, dy = t.clientY - cy;
      const len = Math.hypot(dx, dy), max = 46;
      if (len > max) { dx = dx / len * max; dy = dy / len * max; }
      knob.style.transform = `translate(${dx}px,${dy}px)`;
      joy.x = dx / max; joy.y = dy / max;
    } else if (t.identifier === lookId) {
      if (lookLast) {
        player.yaw -= (t.clientX - lookLast.x) * 0.0052;
        player.pitch = clamp(player.pitch - (t.clientY - lookLast.y) * 0.0052, -1.53, 1.53);
      }
      lookLast = { x: t.clientX, y: t.clientY };
    }
  }
}, { passive: true });
addEventListener('touchend', e => {
  for (const t of e.changedTouches) {
    if (t.identifier === stickId) { stickId = null; joy.x = joy.y = 0; knob.style.transform = ''; joy.active = false; }
    if (t.identifier === lookId) { lookId = null; lookLast = null; }
  }
});
renderer.domElement.addEventListener('touchstart', e => {
  const t = e.changedTouches[0];
  if (t.clientX > innerWidth * 0.42) { lookId = t.identifier; lookLast = { x: t.clientX, y: t.clientY }; }
  e.preventDefault();
}, { passive: false });

function bindHold(el, down, up) {
  el.addEventListener('touchstart', e => { down(); e.preventDefault(); }, { passive: false });
  el.addEventListener('touchend', e => { up && up(); e.preventDefault(); }, { passive: false });
  el.addEventListener('mousedown', e => { down(); e.preventDefault(); });
  el.addEventListener('mouseup', () => up && up());
}
bindHold($('tMine'), () => { if (!panelOpen && player.alive) { mineHeld = true; attackQueued = true; } }, () => { mineHeld = false; });
bindHold($('tPlace'), () => { if (!panelOpen && player.alive) placeQueued = true; });
bindHold($('tJump'), () => { jumpQueued = true; });
$('tBag').addEventListener('click', () => openPanel(!panelOpen));

/* ============================================================ 交互 */
/* ── 挖掘裂缝：10 级裂纹贴图，贴在准星命中的方块表面 ── */
function makeCrackTexture() {
  const S = 16, N = 4;
  const cv = document.createElement('canvas');
  cv.width = cv.height = S * N;
  const g = cv.getContext('2d');
  for (let stage = 0; stage < 10; stage++) {
    const ox = (stage % N) * S, oy = ((stage / N) | 0) * S;
    g.save();
    g.beginPath(); g.rect(ox, oy, S, S); g.clip();
    g.strokeStyle = 'rgba(0,0,0,0.8)';
    g.lineWidth = 1.2;
    let seed = 7919 + stage * 131;
    const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
    const cracks = 1 + Math.round(stage * 0.65);     // 进度越高裂纹越多
    for (let i = 0; i < cracks; i++) {
      let x = 2 + rnd() * 12, y = 2 + rnd() * 12;
      let ang = rnd() * Math.PI * 2;
      g.beginPath(); g.moveTo(ox + x, oy + y);
      const segs = 3 + Math.floor(rnd() * 6);
      for (let k = 0; k < segs; k++) {
        ang += (rnd() - 0.5) * 1.2;
        x = clamp(x + Math.cos(ang) * 1.7, 0.5, S - 0.5);
        y = clamp(y + Math.sin(ang) * 1.7, 0.5, S - 0.5);
        g.lineTo(ox + x, oy + y);
      }
      g.stroke();
      if (stage > 4 && i % 2 === 0) {                // 后期加分支
        g.beginPath();
        g.moveTo(ox + x, oy + y);
        g.lineTo(ox + clamp(x + (rnd() - 0.5) * 6, 0.5, S - 0.5), oy + clamp(y + (rnd() - 0.5) * 6, 0.5, S - 0.5));
        g.stroke();
      }
    }
    g.restore();
  }
  const tex = new THREE.CanvasTexture(cv);
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  tex.repeat.set(1 / N, 1 / N);
  tex.offset.set(0, 1 - 1 / N);
  return tex;
}
const crackTex = makeCrackTexture();
const crackMesh = new THREE.Mesh(
  new THREE.BoxGeometry(1.008, 1.008, 1.008),
  new THREE.MeshBasicMaterial({
    map: crackTex, transparent: true, opacity: 0.95, depthWrite: false,
    polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2, fog: true,
  })
);
crackMesh.visible = false;
crackMesh.renderOrder = 3;
scene.add(crackMesh);

const targetOutline = new THREE.LineSegments(
  new THREE.EdgesGeometry(new THREE.BoxGeometry(1.004, 1.004, 1.004)),
  new THREE.LineBasicMaterial({ color: 0x0b0b0b, transparent: true, opacity: 0.7 })
);
targetOutline.visible = false;
scene.add(targetOutline);

function cameraDir() {
  const dir = new THREE.Vector3(0, 0, -1);
  dir.applyEuler(new THREE.Euler(player.pitch, player.yaw, 0, 'YXZ'));
  return dir;
}
function eyePos() { return new THREE.Vector3(player.p.x, player.p.y + CFG.EYE, player.p.z); }

function doMine(dt, target) {
  if (!target) { player.mining = 0; return; }
  const def = BLOCKS[target.id];
  if (!def) { player.mining = 0; return; }
  const key = target.x + ',' + target.y + ',' + target.z;
  if (player.mineKey !== key) { player.mineKey = key; player.mining = 0; }
  if (MINE_PIN !== null) player.mining = MINE_PIN;
  const pickOk = heldKind() === 'pick';
  let speed = 1 / Math.max(0.12, def.hard);
  if (def.pick) speed *= pickOk ? 1 : 0.28;
  const heldDef = held() ? ITEMS[held().id] : null;
  if (pickOk && heldDef && heldDef.fast) speed *= heldDef.fast;   // 铁镐更快
  player.mining += dt * speed;
  player.mineTarget = target;
  if (player.mining >= 1) {
    player.mining = 0;
    breakBlock(target);
    return true;
  }
  return false;
}
function breakBlock(t) {
  const def = BLOCKS[t.id];
  if (!def) return;
  setBlock(t.x, t.y, t.z, 0);
  sfx('dig');
  if (def.leaf) { if (Math.random() < 0.12) { addItem(105, 1); toast('捡到苹果 ×1', 1.6); } }
  else if (def.drop) {
    const stonePick = inv.some(s => s.id === 101 || s.id === 120);
    if (def.stonePick && !stonePick) toast('铁矿需要石镐或更好才能采集', 1.8);
    else if (def.pick && heldKind() !== 'pick') toast('石头需要镐才能采集', 1.8);
    else addItem(def.drop, 1);
  }
  renderHotbar(); refreshHeld(); saveSoon();
}
function placeBlock() {
  const h = held();
  if (!h || !BLOCKS[h.id] || h.id === 5) { toast('手里没有可放置的方块', 1.4); return false; }
  const t = raycastVoxel(eyePos(), cameraDir(), CFG.REACH);
  if (!t) return false;
  const x = t.x + t.nx, y = t.y + t.ny, z = t.z + t.nz;
  if (y < 0 || y >= CFG.WH) return false;
  const cur = getBlock(x, y, z);
  if (cur !== 0 && cur !== 5) return false;
  if (blockBoxBlocks(x, y, z)) { toast('这里放不下（会卡住自己）', 1.4); return false; }
  setBlock(x, y, z, h.id);
  takeItem(h.id, 1);
  sfx('place');
  startSwing('place', 0.26);
  if (h.id === 14) setSpawnAt(x, y, z);
  renderHotbar(); refreshHeld(); saveSoon();
  return true;
}
function eat() {
  const h = held();
  if (!h || (defOf(h.id) || {}).kind !== 'food') return false;
  if (player.hunger >= 20) { toast('现在不饿', 1.2); return false; }
  player.hunger = Math.min(20, player.hunger + (defOf(h.id).food || 4));
  takeItem(h.id, 1);
  sfx('eat'); toast('吃掉了苹果', 1.2);
  startSwing('place', 0.3);
  renderHotbar(); refreshHeld(); saveSoon();
  return true;
}
// 近战：沿视线找一个"锥形"内的怪（判定半径 1.05，射程比挖方块短 1.2 格）
function attackTarget() {
  const dir = cameraDir(), eye = eyePos();
  let best = null, bestScore = -1e9;
  for (const m of mobs) {
    if (m.hp <= 0 || m.dying) continue;
    const to = m.p.clone();
    to.y += 0.55;
    to.sub(eye);
    const t = to.dot(dir);
    if (t < 0.1 || t > CFG.REACH - 1.2) continue;
    const perp = to.addScaledVector(dir, -t).length();
    if (perp > 1.05) continue;
    const score = 1 / (perp + 0.2) - t * 0.05;
    if (score > bestScore) { bestScore = score; best = m; }
  }
  return best;
}
function attack() {
  if (player.atkCd > 0) return false;
  const target = attackTarget();
  if (!target) return false;
  const kind = heldKind();
  const dmg = kind === 'sword' ? ((defOf(held().id) || {}).dmg || 5)
            : kind === 'pick' ? 3 : 1;
  const dir = cameraDir();
  target.hp -= dmg;
  target.flash = 0.24;
  target.aggro = 16;                 // 被打了就记仇：白天也会追你
  target.v.y = 4.6;
  target.v.x += dir.x * 5.5; target.v.z += dir.z * 5.5;
  startSwing('attack', 0.5);
  player.atkCd = 0.42;
  player.hits = (player.hits || 0) + 1;
  sfx('hit');
  if (target.hp > 0) toast(`命中 ${MOB_NAME} −${dmg}（剩 ${Math.max(0, target.hp)}）`, 0.9);
  else {
    player.kills = (player.kills || 0) + 1;
    toast(`击倒 ${MOB_NAME}`, 1.4);
    startMobDeath(target);          // 立即进入倒地动画（updateMobs 里也会兜底触发）
  }
  return true;
}

/* ============================================================ 更新循环 */
let lastT = 0, acc = 0, fps = 60, frameCount = 0, fpsT = 0, startedAt = 0, camSmoothY = null;
const STEP = 1 / 60;
let saveTimer = 0;

function updatePlayer(dt) {
  player.atkCd = Math.max(0, player.atkCd - dt);
  if (!player.alive) { player.v.set(0, 0, 0); return; }
  let ix = 0, iz = 0;
  if (keys.has('KeyW') || keys.has('ArrowUp')) iz -= 1;
  if (keys.has('KeyS') || keys.has('ArrowDown')) iz += 1;
  if (keys.has('KeyA') || keys.has('ArrowLeft')) ix -= 1;
  if (keys.has('KeyD') || keys.has('ArrowRight')) ix += 1;
  if (joy.active) { ix += joy.x; iz += joy.y; }
  const len = Math.hypot(ix, iz);
  if (len > 1) { ix /= len; iz /= len; }
  const sink = Math.sin(player.yaw), cosk = Math.cos(player.yaw);
  const wx = ix * cosk + iz * sink;
  const wz = -ix * sink + iz * cosk;
  const sprint = keys.has('ShiftLeft') || keys.has('ShiftRight');
  const speed = (sprint ? CFG.SPRINT : CFG.WALK) * (player.inWater ? 0.62 : 1);
  player.v.x = wx * speed;
  player.v.z = wz * speed;

  const feetBlock = getBlock(Math.floor(player.p.x), Math.floor(player.p.y + 0.2), Math.floor(player.p.z));
  player.inWater = feetBlock === 5;
  if (player.inWater) {
    player.v.y = Math.max(player.v.y - CFG.GRAV * 0.28 * dt, -3.2);
    if (jumpQueued) player.v.y = 3.4;
  } else {
    player.v.y = Math.max(player.v.y - CFG.GRAV * dt, -56);
    if (jumpQueued && player.onGround) { player.v.y = CFG.JUMP; player.onGround = false; }
  }
  jumpQueued = false;

  // 摔落伤害
  if (!player.onGround && !player.inWater) { if (player.fallFrom === null) player.fallFrom = player.p.y; }
  const wasFall = player.fallFrom;
  moveBody(player, player.v.x * dt, player.v.y * dt, player.v.z * dt);
  if (player.onGround) {
    if (wasFall !== null) {
      const fall = wasFall - player.p.y;
      if (fall > 1.2) anim.land = Math.min(1, fall / 6);
      if (fall > 4.2 && !player.inWater) damagePlayer(Math.min(12, Math.round((fall - 4.2) * 1.7)));
    }
    player.fallFrom = null;
  }
  if (player.inWater) player.fallFrom = null;

  // 走路手部摆动
  const moving = len > 0.05 && player.onGround;
  player.walkPhase += dt * (moving ? (sprint ? 11 : 8) : 0);

  // 饥饿 / 回血
  player.hunger = Math.max(0, player.hunger - dt * (moving ? 0.055 : 0.02));
  if (player.hunger <= 0) { player.hp = Math.max(0, player.hp - dt * 0.6); if (player.hp <= 0) die(); }
  else if (player.hunger > 16 && player.hp < 20) player.hp = Math.min(20, player.hp + dt * 0.45);

  // 掉出世界
  if (player.p.y < -8) { damagePlayer(20); respawn(); }
}

function update(dt) {
  worldTime += dt;
  echoTimer -= dt;
  if (echoTimer <= 0) { echoTimer = 0.4; underground = isUnderground(); }
  caveMix += ((underground ? 1 : 0) - caveMix) * Math.min(1, dt * 4);
  updateSky();
  // 回声系统：地下 → 混响变强 + 偶尔滴水
  if (wetGain) {
    const want = underground ? 0.55 : 0.06;
    wetGain.gain.value += (want - wetGain.gain.value) * Math.min(1, dt * 2.5);
  }
  if (underground && AC) {
    dripTimer -= dt;
    if (dripTimer <= 0) { dripTimer = 2.5 + Math.random() * 9; playDrip(); }
  }
  updatePlayer(dt);
  updateMobs(dt);

  // 目标方块
  const t = player.alive ? raycastVoxel(eyePos(), cameraDir(), CFG.REACH) : null;
  if (t) {
    targetOutline.visible = true;
    targetOutline.position.set(t.x + 0.5, t.y + 0.5, t.z + 0.5);
  } else targetOutline.visible = false;
  // 裂缝：随挖掘进度（0..1）换成 10 级贴图
  if (t && player.mining > 0.015) {
    const stage = Math.min(9, Math.floor(player.mining * 10));
    crackTex.offset.set((stage % 4) / 4, 1 - (((stage / 4) | 0) + 1) / 4);
    crackMesh.position.set(t.x + 0.5, t.y + 0.5, t.z + 0.5);
    crackMesh.visible = true;
  } else crackMesh.visible = false;

  const wantAttack = attackQueued || (mineHeld && mobs.length > 0);
  if (wantAttack) attackQueued = false;
  const hitMob = wantAttack ? attack() : false;
  if (!hitMob && mineHeld && t) doMine(dt, t);
  else if (!mineHeld) { player.mining = 0; player.mineTarget = null; }
  if (placeQueued) {
    placeQueued = false;
    const h = held();
    if (t && t.id === 10) { openPanel(true); startSwing('place', 0.2); }
    else if (t && BLOCKS[t.id] && BLOCKS[t.id].bed) { setSpawnAt(t.x, t.y, t.z); startSwing('place', 0.26); }
    else if (h && (defOf(h.id) || {}).kind === 'food') eat();
    else placeBlock();
  }

  // 手部姿势在 frame() 里按真实帧时长算（固定步长里算会让动画在高刷屏上发顿）
  player.swing = 0;

  // 区块流式加载
  streamChunks();

  // 存档
  saveTimer += dt;
  if (saveTimer > 8) { saveTimer = 0; save(); }
}

function streamChunks() {
  const pcx = Math.floor(player.p.x / CFG.CH), pcz = Math.floor(player.p.z / CFG.CH);
  // 建立缺失区块的地形（限流）
  let built = 0;
  for (let r = 0; r <= CFG.LOAD_R && built < 2; r++) {
    for (let dx = -r; dx <= r && built < 2; dx++) for (let dz = -r; dz <= r && built < 2; dz++) {
      if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
      const c = getChunk(pcx + dx, pcz + dz);
      if (!c.ready) { buildChunk(c); built++; }
    }
  }
  // 重建脏区块
  let rebuilt = 0;
  for (const c of dirty) {
    if (rebuilt >= 3) break;
    const d = Math.max(Math.abs(c.cx - pcx), Math.abs(c.cz - pcz));
    if (d > CFG.LOAD_R + 1) { dirty.delete(c); continue; }
    buildChunk(c); dirty.delete(c); rebuilt++;
  }
  // 卸载远处
  for (const [k, c] of chunks) {
    const d = Math.max(Math.abs(c.cx - pcx), Math.abs(c.cz - pcz));
    if (d > CFG.UNLOAD_R) {
      if (c.mesh) { scene.remove(c.mesh); c.mesh.geometry.dispose(); }
      if (c.water) { scene.remove(c.water); c.water.geometry.dispose(); }
      dirty.delete(c);
      chunks.delete(k);
    }
  }
}

/* ============================================================ HUD 刷新（降频） */
let hudTimer = 0, lastStatus = '';
function updateHUD(dt) {
  hudTimer += dt;
  if (hintTimer > 0) { hintTimer -= dt; if (hintTimer <= 0) hud.hint.style.opacity = '0'; }
  if (hudTimer < 0.2) return;
  hudTimer = 0;
  const t = player.mineTarget;
  const t2 = player.alive ? raycastVoxel(eyePos(), cameraDir(), CFG.REACH) : null;
  const pct = Math.round(player.mining * 100);
  hud.mine.style.display = (mineHeld && t2 && player.mining > 0.02) ? 'block' : 'none';
  hud.mineBar.style.width = `${Math.min(100, pct)}%`;
  hud.tgt.textContent = t2 ? `${nameOf(t2.id)} ${player.mining > 0.02 ? pct + '%' : ''}` : '';
  const dirs = ['北', '东北', '东', '东南', '南', '西南', '西', '西北'];
  const deg = ((-player.yaw * 180 / Math.PI) % 360 + 360) % 360;
  const dirName = dirs[Math.round(deg / 45) % 8];
  const mem = (performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) + 'MB' : '');
  const s =
    `环境 <b>${underground ? '矿洞（回声）' : '地表'}</b>\n` +
    `FPS <b>${Math.round(fps)}</b>  区块 <b>${chunks.size}</b>  ${mem}\n` +
    `坐标 <b>${player.p.x.toFixed(1)} ${player.p.y.toFixed(1)} ${player.p.z.toFixed(1)}</b> 朝${dirName}\n` +
    `时间 <b>${clockText()}</b> ${isNight() ? '夜晚' : '白天'}  怪物 <b>${aliveMobs()}</b>  击倒 <b>${player.kills || 0}</b>\n` +
    `手持 <b>${held() ? nameOf(held().id) : '空手'}</b>${heldKind() === 'pick' ? '（镐）' : heldKind() === 'sword' ? '（剑）' : ''}  护甲 <b>${armorPoints()}</b>  重生点 <b>${player.spawn && player.spawn.bed ? '床' : '出生点'}</b>`;
  if (s !== lastStatus) { hud.status.innerHTML = s; lastStatus = s; }
  renderHearts();
}

/* ============================================================ 存档 */
function save() {
  try {
    const data = {
      seed: SEED, time: worldTime,
      player: { x: player.p.x, y: player.p.y, z: player.p.z, yaw: player.yaw, pitch: player.pitch, hp: player.hp, hunger: player.hunger },
      inv, edits: Array.from(edits.entries()), spawn: player.spawn, armor: player.armor,
    };
    localStorage.setItem(CFG.SAVE_KEY, JSON.stringify(data));
  } catch (e) { /* 配额满就跳过 */ }
}
let saveSoonT = 0;
function saveSoon() { clearTimeout(saveSoonT); saveSoonT = setTimeout(save, 600); }
function loadSave() {
  try {
    const raw = localStorage.getItem(CFG.SAVE_KEY);
    if (!raw) return false;
    const d = JSON.parse(raw);
    if (!d || !d.seed) return false;
    SEED = d.seed;
    worldTime = d.time || 0;
    inv = (d.inv || []).filter(s => s && isItem(s.id) && s.n > 0);
    player.spawn = d.spawn || null;
    if (d.armor) for (const s of ARMOR_SLOTS) player.armor[s] = ITEMS[d.armor[s]] ? d.armor[s] : null;
    for (const [k, v] of (d.edits || [])) edits.set(k, v);
    if (d.player) {
      player.p.set(d.player.x, d.player.y, d.player.z);
      player.yaw = d.player.yaw || 0; player.pitch = d.player.pitch || 0;
      player.hp = d.player.hp ?? 20; player.hunger = d.player.hunger ?? 20;
    }
    return true;
  } catch (e) { return false; }
}
function newWorld() {
  localStorage.removeItem(CFG.SAVE_KEY);
  location.reload();
}

/* ============================================================ 帧循环 */
function frame(now) {
  requestAnimationFrame(frame);
  if (!started) return;
  let dt = (now - lastT) / 1000;
  lastT = now;
  if (!isFinite(dt) || dt < 0) dt = 0;
  dt = Math.min(dt, 0.1);
  acc += dt;
  frameCount++; fpsT += dt;
  if (fpsT >= 0.5) { fps = frameCount / fpsT; frameCount = 0; fpsT = 0; }
  let guard = 0;
  while (acc >= STEP && guard++ < 6) { acc -= STEP; update(STEP); }
  updateHUD(dt);

  const idealEye = player.p.y + CFG.EYE + Math.sin(player.walkPhase) * 0.018;
  camSmoothY = camSmoothY === null ? idealEye : camSmoothY + (idealEye - camSmoothY) * Math.min(1, dt * 15);
  camera.position.set(player.p.x, camSmoothY, player.p.z);
  camera.rotation.set(player.pitch, player.yaw, 0);
  updateHandPose(dt, now);

  renderer.clear();
  renderer.render(scene, camera);
  renderer.clearDepth();
  renderer.render(handScene, handCam);
}

/* ============================================================ 启动 */
function startGame(fresh) {
  if (started) return;
  if (fresh) { localStorage.removeItem(CFG.SAVE_KEY); edits.clear(); }
  const loaded = !fresh && loadSave();
  if (!loaded) {
    SEED = (Math.random() * 1e6) | 0;
    const sp = findSpawn();
    player.p.set(sp.x, sp.y, sp.z);
    player.spawn = { x: sp.x, y: sp.y, z: sp.z, bed: false };
    player.hp = 20; player.hunger = 20;
    inv = [];
    addItem(10, 1);      // 送一个工作台
    addItem(105, 2);     // 两个苹果
    addItem(8, 8);       // 几块木板
    worldTime = CFG.DAY * 0.03;
  }
  try { AC = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) { AC = null; }
  if (AC) { sfxBus = null; initAudioChain(); }
  hud.start.classList.add('hide');
  refreshHeld(); renderHotbar(); renderHearts();
  started = true;
  lastT = performance.now(); startedAt = performance.now();
  // 先把出生点周围铺开，避免掉进虚空
  const pcx = Math.floor(player.p.x / CFG.CH), pcz = Math.floor(player.p.z / CFG.CH);
  for (let dx = -2; dx <= 2; dx++) for (let dz = -2; dz <= 2; dz++) buildChunk(getChunk(pcx + dx, pcz + dz));
  // 若出生在水里/悬空，抬到地表
  const sy2 = surfaceY(Math.floor(player.p.x), Math.floor(player.p.z));
  if (player.p.y < sy2 + 1) player.p.y = sy2 + 1.05;
  toast('按 E 打开背包与合成 · 左键挖、右键放', 4);
  lockPointer();
  window.__BW_STARTED = true;
}

$('btnPlay').onclick = () => startGame(false);
$('btnNew').onclick = () => startGame(true);
$('btnReset').onclick = () => { if (confirm('清空存档并生成一个新世界？')) newWorld(); };
$('btnBag').onclick = () => openPanel(!panelOpen);
$('btnClose').onclick = () => openPanel(false);
$('btnRespawn').onclick = () => respawn();
addEventListener('resize', () => {
  renderer.setSize(innerWidth, innerHeight);
  camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix();
  handCam.aspect = innerWidth / innerHeight; handCam.updateProjectionMatrix();
  document.body.classList.toggle('portrait', innerHeight > innerWidth * 1.05);
});
document.body.classList.toggle('portrait', innerHeight > innerWidth * 1.05);
addEventListener('visibilitychange', () => { if (document.hidden && started) save(); });
addEventListener('beforeunload', () => { if (started) save(); });

/* ============================================================ 调试探针 */
window.GAME = {
  CFG, BLOCKS, ITEMS, RECIPES, player, chunks, edits, mobs, anim, inv: () => inv,
  get started() { return started; },
  get fps() { return fps; },
  get time() { return worldTime; },
  get light() { return lightLevel; },
  state() {
    return {
      started, fps: Math.round(fps), pos: [+player.p.x.toFixed(2), +player.p.y.toFixed(2), +player.p.z.toFixed(2)],
      yaw: +player.yaw.toFixed(3), hp: player.hp, hunger: +player.hunger.toFixed(1),
      onGround: player.onGround, chunks: chunks.size, mobs: mobs.length,
      light: +lightLevel.toFixed(2), clock: clockText(), water: player.inWater,
      held: held() ? nameOf(held().id) : null, sel: player.sel,
      armVisible: armR.visible && armR.position.length() > 0, handSceneChildren: handScene.children.length,
      objCount: scene.children.length, edits: edits.size,
    };
  },
  blockAt: (x, y, z) => getBlock(x, y, z),
  setBlock: (x, y, z, id) => setBlock(x, y, z, id),
  nameAt: (x, y, z) => nameOf(getBlock(x, y, z)),
  heightAt, n3, caveCarve,
  icons: { armR, armL, handScene, solidMat, waterMat, scene, camera, handCam, renderer, crackMesh, crackTex, heldGroup },
  debug: {
    start: (fresh = false) => startGame(fresh),
    steps(n = 60) { for (let i = 0; i < n; i++) { update(STEP); } },
    look(yaw, pitch) { player.yaw = yaw; player.pitch = pitch; },
    tp(x, y, z) { player.p.set(x, y, z); player.v.set(0, 0, 0); },
    give(id, n = 1) { addItem(id, n); renderHotbar(); refreshHeld(); },
    clearInv() { inv = []; renderHotbar(); refreshHeld(); },
    select(i) { player.sel = i; refreshHeld(); renderHotbar(); },
    setTime(t) { worldTime = t; updateSky(); },
    setHp(v) { player.hp = v; },
    hurt: (n = 1) => damagePlayer(n),
    armor: () => ({ ...player.armor, ap: armorPoints() }),
    equip: (id) => { addItem(id, 1); return equipArmor(id); },
    nearTable: () => nearCraftingTable(),
    craftIdx: (i) => craft(RECIPES[i]),
    recipes: () => RECIPES.map((r, i) => ({ i, out: r.out, name: nameOf(r.out), tier: r.tier || 0, need: Object.keys(r.need).map(Number) })),
    respawn: () => respawn(),
    setHunger(v) { player.hunger = v; },
    mine(on) { mineHeld = !!on; },
    mineOnce() { const t = raycastVoxel(eyePos(), cameraDir(), CFG.REACH); if (t) breakBlock(t); return !!t; },
    mineTo() {
      const t = raycastVoxel(eyePos(), cameraDir(), CFG.REACH);
      if (!t) return null;
      player.mining = 0;
      let broke = false, i = 0;
      while (!broke && i++ < 900) broke = doMine(STEP, t);
      return { x: t.x, y: t.y, z: t.z, id: t.id, broke };
    },
    place() { return placeBlock(); },
    craft: (idx) => craft(RECIPES[idx]),
    craftAll() { const out = []; RECIPES.forEach((r, i) => { if (craft(r)) out.push(i); }); return out; },
    spawnMob: (dx, dz) => { const m = spawnMob(dx === undefined ? undefined : [dx, dz]); return m ? [+m.p.x.toFixed(1), +m.p.y.toFixed(1), +m.p.z.toFixed(1)] : null; },
    attack: () => attack(),
    aimAt: (i = 0) => {
      const m = mobs[i]; if (!m) return null;
      const eye = eyePos();
      const c = m.p.clone(); c.y += 0.55;
      const d = c.sub(eye).normalize();
      player.yaw = Math.atan2(-d.x, -d.z);
      player.pitch = Math.asin(Math.max(-1, Math.min(1, d.y)));
      return { yaw: +player.yaw.toFixed(3), pitch: +player.pitch.toFixed(3) };
    },
    handPose: () => ({
      arm: armR.position.toArray().map(v => +v.toFixed(4)).concat(armR.rotation.toArray().slice(0, 3).map(v => +(+v).toFixed(4))),
      item: heldGroup.position.toArray().map(v => +v.toFixed(4)).concat(heldGroup.rotation.toArray().slice(0, 3).map(v => +(+v).toFixed(4))),
      kind: heldKindNow, visible: heldGroup.visible, heldId: heldFor,
      swing: +anim.swing.toFixed(3), mineW: +anim.mineW.toFixed(3), mineT: +anim.mineT.toFixed(3),
      equip: +anim.equip.toFixed(3), sway: [+anim.swayX.toFixed(4), +anim.swayY.toFixed(4)],
    }),
    swing: (type = 'attack', dur = 0.5) => startSwing(type, dur),
    pinMining: (v) => { MINE_PIN = v; },
    noiseTest(n = 4000) {
      const ch = [], rg = [];
      let carve = 0, surf = 0;
      for (let i = 0; i < n; i++) {
        const x = (Math.random() * 400 - 200) | 0, z = (Math.random() * 400 - 200) | 0;
        const h = heightAt(x, z);
        const y = 3 + Math.floor(Math.random() * Math.max(1, h - 5));
        ch.push(n3(x * 0.026, y * 0.05, z * 0.026));
        rg.push(1 - Math.abs(n3(x * 0.043 + 31.7, y * 0.019, z * 0.043 + 11.3) - 0.5) * 2);
        if (caveCarve(x, y, z, h)) carve++;
        const ys = h; if (caveCarve(x, ys, z, ys)) surf++;
      }
      const q = (arr, p) => { const a = arr.slice().sort((m, n) => m - n); return +a[Math.floor(p * (a.length - 1))].toFixed(3); };
      return { cheese: { q50: q(ch, .5), q90: q(ch, .9), q99: q(ch, .99), max: +Math.max(...ch).toFixed(3) },
               ridge: { q90: q(rg, .9), q99: q(rg, .99), max: +Math.max(...rg).toFixed(3) },
               carveFrac: +(carve / n).toFixed(3), surfaceHoleFrac: +(surf / n).toFixed(3) };
    },
    env: () => ({ underground, wet: wetGain ? +wetGain.gain.value.toFixed(3) : null, dripTimer: +dripTimer.toFixed(1) }),
    mineshafts: (r = 2) => {
      const pcx = Math.floor(player.p.x / MS_CELL), pcz = Math.floor(player.p.z / MS_CELL);
      const out = [];
      for (let dx = -r; dx <= r; dx++) for (let dz = -r; dz <= r; dz++) {
        const ms = mineshaftFor(pcx + dx, pcz + dz);
        if (ms) out.push({ ox: ms.ox, oz: ms.oz, baseY: ms.baseY, kind: ms.kind, corridors: ms.corridors, ops: ms.ops, entrance: ms.entrance });
      }
      return out;
    },
    enterMineshaft() {
      const pcx = Math.floor(player.p.x / MS_CELL), pcz = Math.floor(player.p.z / MS_CELL);
      for (let r = 0; r <= 3; r++) for (let dx = -r; dx <= r; dx++) for (let dz = -r; dz <= r; dz++) {
        const ms = mineshaftFor(pcx + dx, pcz + dz);
        if (!ms) continue;
        // 从结构里挑一个真正被挖空的点站进去（方向随机，不能假设 ox+6 一定在巷道里）
        const airs = [];
        for (const arr of ms.byChunk.values()) for (const o of arr) if (o.t === 0 && o.y === ms.baseY + 1) airs.push(o);
        if (!airs.length) continue;
        const pick = airs[Math.floor(airs.length / 2)];
        const x = pick.x, z = pick.z, y = ms.baseY + 1;
        const cx = Math.floor(x / CFG.CH), cz = Math.floor(z / CFG.CH);
        for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) buildChunk(getChunk(cx + a, cz + b));
        player.p.set(x + 0.5, y, z + 0.5); player.v.set(0, 0, 0);
        camSmoothY = null;
        return { x: x + 0.5, y, z: z + 0.5, baseY: ms.baseY, kind: ms.kind, corridors: ms.corridors, entrance: ms.entrance };
      }
      return null;
    },
    caveStats(n = 24) {
      const px = Math.floor(player.p.x), pz = Math.floor(player.p.z);
      let air = 0, tot = 0, mouths = 0, cols = 0;
      for (let x = px - n; x <= px + n; x += 2) for (let z = pz - n; z <= pz + n; z += 2) {
        const h = heightAt(x, z); cols++;
        if (h < CFG.WH - 2 && getBlock(x, h, z) === 0) mouths++;
        for (let y = 3; y < h - 1; y++) { tot++; if (getBlock(x, y, z) === 0) air++; }
      }
      return { caveAirFrac: +(air / Math.max(1, tot)).toFixed(3), surfaceHoles: mouths, columns: cols };
    },
    chunkBuildMs() {
      const c = getChunk(Math.floor(player.p.x / CFG.CH) + 3, Math.floor(player.p.z / CFG.CH));
      const t0 = performance.now(); buildChunk(c); return +(performance.now() - t0).toFixed(1);
    },
    mobsInfo: () => mobs.map(m => ({
      hp: m.hp, dying: m.dying, dieT: +m.dieT.toFixed(2), scale: +m.obj.scale.x.toFixed(3),
      tilt: +m.parts.core.rotation.x.toFixed(2), dist: +m.p.distanceTo(player.p).toFixed(2),
      aggro: +m.aggro.toFixed(1), flash: +m.flash.toFixed(2),
      barVisible: m.parts.bar.visible, barScale: +m.parts.barFg.scale.x.toFixed(2),
    })),
    treeSample(n = 400, x0 = 0, z0 = 0) {
      const kinds = { oak: 0, pine: 0, bush: 0, none: 0 };
      const heights = [], radii = [];
      for (let i = 0; i < n; i++) {
        for (let j = 0; j < 40; j++) {
          const t = treeParams(x0 + i * 7 + j * 13, z0 + j * 17 - i * 5);
          if (t) { kinds[t.kind]++; heights.push(t.trunkH); radii.push(t.r); break; }
          kinds.none++;
        }
      }
      const uniqH = [...new Set(heights)].sort();
      const uniqR = [...new Set(radii)].sort();
      return { kinds, trunkHeights: uniqH, radii: uniqR, samples: heights.length };
    },
    killMobs() { for (const m of mobs) killMob(m); mobs.length = 0; },
    seek(x, z) { player.p.x = x + 0.5; player.p.z = z + 0.5; player.p.y = surfaceY(x, z) + 1.2; player.v.set(0, 0, 0); },
    scanColumn(x, z) { const out = []; for (let y = CFG.WH - 1; y >= 0; y--) { const id = getBlock(x, y, z); if (id) out.push([y, nameOf(id)]); } return out; },
    findBlock(id, r = 24) {
      const px = Math.floor(player.p.x), pz = Math.floor(player.p.z);
      for (let d = 0; d < r; d++) for (let dx = -d; dx <= d; dx++) for (let dz = -d; dz <= d; dz++) {
        if (Math.max(Math.abs(dx), Math.abs(dz)) !== d) continue;
        for (let y = CFG.WH - 1; y > 0; y--) if (getBlock(px + dx, y, pz + dz) === id) return [px + dx, y, pz + dz];
      }
      return null;
    },
    counts() {
      const c = {};
      for (const ch of chunks.values()) for (const id of ch.blocks) if (id) c[nameOf(id)] = (c[nameOf(id)] || 0) + 1;
      return c;
    },
    // 截图用：WebGL 缓冲在合成后会被清空，必须同步重绘一次再取 toDataURL
    snapshot() {
      renderer.clear();
      renderer.render(scene, camera);
      renderer.clearDepth();
      renderer.render(handScene, handCam);
      return renderer.domElement.toDataURL();
    },
    save: () => save(),
    newWorld: () => newWorld(),
  },
};
requestAnimationFrame(frame);
