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
  if (cheese > (depth <= 2 ? 0.845 : 0.665)) return true;
  if (depth <= 1) return false;
  const ridge = n3(wx * 0.043 + 31.7, y * 0.019, wz * 0.043 + 11.3);
  const r = 1 - Math.abs(ridge - 0.5) * 2;          // 0.5 附近 → 细长的隧道壳
  return r > 0.972;
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

// 先试四个方向的斜坡楼梯；都不通就挖一口"折返台阶竖井"，保证矿洞能从地面进去
function openToSurface(ops, x0, y0, z0, dx, dz) {
  for (const [ax, az] of [[dx, dz], [-dx, -dz], [dz, -dx], [-dz, dx]]) {
    if (msStairs(ops, x0, y0, z0, ax, az)) return true;
  }
  // 竖井：2×2，每 3 格折返一次台阶，一直挖到地表
  let lvl = y0, cx = x0, cz = z0;
  for (let k = 1; k <= 120; k++) {
    const turn = Math.floor((k - 1) / 6) % 2 === 0 ? 1 : 0;
    if (turn) cz += (Math.floor((k - 1) / 12) % 2 === 0 ? 1 : -1);
    else cx += (Math.floor((k - 1) / 12) % 2 === 0 ? 1 : -1);
    if (k % 3 === 0) lvl++;
    for (let ax = 0; ax <= 1; ax++) for (let az = 0; az <= 1; az++) {
      for (let y = lvl; y < lvl + 3; y++) msPush(ops, cx + ax, y, cz + az, 0);
      msPush(ops, cx + ax, lvl - 1, cz + az, 8);
    }
    const surf = heightAt(cx, cz);
    if (surf <= CFG.SEA + 2) return false;
    if (lvl >= surf - 1) {
      for (let ax = 0; ax <= 1; ax++) for (let az = 0; az <= 1; az++)
        for (let y = surf - 1; y < lvl + 3; y++) msPush(ops, cx + ax, y, cz + az, 0);
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
      entrance = openToSurface(ops, ox, baseY, oz, dirX, 0);
    } else if (shapeRoll < 0.55) {                    // ② L 形拐弯
      kindName = 'L';
      const l1 = 14 + Math.floor(rnd() * 16), l2 = 12 + Math.floor(rnd() * 16);
      msGallery(ops, ox, baseY, oz, dirX, 0, l1, spacing);
      msGallery(ops, ox + dirX * (l1 - 1), baseY, oz, 0, dirZ, l2, spacing);
      corridors += 2;
      msRoom(ops, ox + dirX * (l1 - 1), baseY, oz + dirZ * (l2 - 1), 2, 2, 4);  // 拐角小厅
      entrance = openToSurface(ops, ox, baseY, oz, dirX, 0);
    } else if (shapeRoll < 0.75) {                     // ③ 十字矿口（中央大厅 + 四向）
      kindName = 'cross';
      msRoom(ops, ox, baseY, oz, 3, 3, 5);
      const l = 10 + Math.floor(rnd() * 10);
      msGallery(ops, ox + 4, baseY, oz, 1, 0, l, spacing, 1, 4);
      msGallery(ops, ox - 4, baseY, oz, -1, 0, l, spacing, 1, 4);
      msGallery(ops, ox, baseY, oz + 4, 0, 1, l, spacing, 1, 4);
      msGallery(ops, ox, baseY, oz - 4, 0, -1, l, spacing, 1, 4);
      corridors += 4;
      entrance = openToSurface(ops, ox + 4, baseY, oz, 1, 0);
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
      entrance = openToSurface(ops, cx, baseY, cz, 1, 0);
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
  14: { name: '床', top: 14, side: 15, bottom: 8, hard: 0.6, drop: 14, bed: true, half: 0.45 },
  15: { name: '铁矿石', top: 16, side: 16, bottom: 16, hard: 2.6, drop: 15, pick: true, stonePick: true },
  16: { name: '农田', top: 17, side: 2, bottom: 2, hard: 0.5, drop: 2 },
  17: { name: '小麦', top: 18, side: 18, bottom: 18, hard: 0.12, drop: 107, crop: true, plant: true, mature: true },
  23: { name: '小麦幼苗', top: 26, side: 26, bottom: 26, hard: 0.1, drop: 156, plant: true, stage: 0 },
  24: { name: '小麦苗', top: 27, side: 27, bottom: 27, hard: 0.1, drop: 156, plant: true, stage: 1 },
  25: { name: '堆肥箱', top: 28, side: 29, bottom: 8, hard: 0.9, drop: 25, compost: true },
  26: { name: '花岗岩', top: 30, side: 30, bottom: 30, hard: 2.6, drop: 26, pick: true },
  27: { name: '石灰岩', top: 31, side: 31, bottom: 31, hard: 1.9, drop: 27, pick: true },
  28: { name: '云杉原木', top: 33, side: 32, bottom: 33, hard: 1.5, drop: 28, log: true },
  29: { name: '云杉木板', top: 34, side: 34, bottom: 34, hard: 1.2, drop: 29 },
  30: { name: '白桦原木', top: 36, side: 35, bottom: 36, hard: 1.5, drop: 30, log: true },
  31: { name: '白桦木板', top: 37, side: 37, bottom: 37, hard: 1.2, drop: 31 },
  33: { name: '石砖楼梯', top: 24, side: 24, bottom: 24, hard: 2.1, drop: 33, pick: true, stair: true },
  34: { name: '木板楼梯', top: 8, side: 8, bottom: 8, hard: 1.2, drop: 34, stair: true },
  18: { name: '箱子', top: 20, side: 19, bottom: 19, hard: 0.9, drop: 18, chest: true },
  19: { name: '熔炉', top: 22, side: 21, bottom: 21, hard: 1.3, drop: 19, furnace: true },
  20: { name: '钻石矿石', top: 23, side: 23, bottom: 23, hard: 3.6, drop: 125, pick: true, stonePick: true, ironPick: true },
  21: { name: '石砖', top: 24, side: 24, bottom: 24, hard: 2.1, drop: 21, pick: true },
  22: { name: '玻璃', top: 25, side: 25, bottom: 25, hard: 0.4, drop: 22, glass: true },
};
const ITEMS = {
  100: { name: '木镐', kind: 'pick', fast: 1.35, dur: 60 },
  101: { name: '石镐', kind: 'pick', fast: 1.9, dur: 132 },
  102: { name: '木剑', kind: 'sword', dmg: 5, dur: 60 },
  103: { name: '石剑', kind: 'sword', dmg: 7, dur: 132 },
  104: { name: '木棍', kind: 'mat' },
  105: { name: '苹果', kind: 'food', food: 4 },
  106: { name: '铁锭', kind: 'mat' },
  110: { name: '铁头盔', kind: 'armor', slot: 'head', ap: 2 },
  111: { name: '铁胸甲', kind: 'armor', slot: 'chest', ap: 6 },
  112: { name: '铁护腿', kind: 'armor', slot: 'legs', ap: 5 },
  113: { name: '铁靴', kind: 'armor', slot: 'feet', ap: 2 },
  107: { name: '小麦', kind: 'mat' },
  108: { name: '生猪排', kind: 'food', food: 3 },
  109: { name: '熟猪排', kind: 'food', food: 6 },
  124: { name: '面包', kind: 'food', food: 5 },
  120: { name: '铁镐', kind: 'pick', fast: 2.6, dur: 251 },
  121: { name: '铁剑', kind: 'sword', dmg: 9, dur: 251 },
  125: { name: '钻石', kind: 'mat' },
  130: { name: '钻石镐', kind: 'pick', fast: 3.4, dur: 1561 },
  131: { name: '钻石剑', kind: 'sword', dmg: 13, dur: 1561 },
  132: { name: '钻石头盔', kind: 'armor', slot: 'head', ap: 3 },
  133: { name: '钻石胸甲', kind: 'armor', slot: 'chest', ap: 8 },
  134: { name: '钻石护腿', kind: 'armor', slot: 'legs', ap: 6 },
  135: { name: '钻石靴', kind: 'armor', slot: 'feet', ap: 3 },
  140: { name: '生牛肉', kind: 'food', food: 5 },
  141: { name: '熟牛肉', kind: 'food', food: 9 },
  142: { name: '羊毛', kind: 'mat' },
  143: { name: '鸡肉', kind: 'food', food: 3 },
  144: { name: '熟鸡肉', kind: 'food', food: 7 },
  148: { name: '骨头', kind: 'mat' },
  149: { name: '骨剑', kind: 'sword', dmg: 6, dur: 120 },
  151: { name: '空桶', kind: 'bucket' },
  152: { name: '水桶', kind: 'bucket', water: true },
  153: { name: '弓', kind: 'bow', dmg: 7, dur: 240 },
  154: { name: '箭', kind: 'ammo' },
  155: { name: '幽灵精华', kind: 'mat' },
  156: { name: '小麦种子', kind: 'seed' },
  157: { name: '肥料', kind: 'fertilizer' },
  158: { name: '木锄', kind: 'hoe', dur: 60 },
  159: { name: '石锄', kind: 'hoe', dur: 132 },
  160: { name: '铁锄', kind: 'hoe', dur: 251 },
};
const isItem = id => !!BLOCKS[id] || !!ITEMS[id];
const defOf = id => BLOCKS[id] || ITEMS[id];
const nameOf = id => (defOf(id) || { name: '?' }).name;

let atlasCanvas = null, atlasTex = null;
// 瓦片序号 → 图集 (col,row)：4 列 × 10 行 = 0..39。
// ⚠ 原来是 4×8（只有 0..31），但 32~37 号瓦片（云杉/白桦）也在画，画到画布外 ⇒
// 采样被 clamp 到最底行，云杉/白桦方块显示成「堆肥箱/石灰岩」的花纹。
const ATLAS_COLS = 4, ATLAS_ROWS = 10;
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
  // 26 幼苗：土堆上两片小芽
  T(26, '#6b4426', 0.08, (c, r) => {
    for (let y = 10; y < 16; y++) for (let x = 0; x < 16; x++) px(c, r, x, y, shade('#5d3a20', 1));
    for (let y = 8; y < 12; y++) { px(c, r, 7, y, '#4f8a33'); px(c, r, 8, y, '#5fa03c'); }
    px(c, r, 6, 9, '#5fa03c'); px(c, r, 5, 8, '#5fa03c'); px(c, r, 9, 10, '#5fa03c'); px(c, r, 10, 9, '#5fa03c');
  });
  // 27 小麦苗：更高的绿秆 + 小穗
  T(27, '#6b4426', 0.08, (c, r) => {
    for (let y = 11; y < 16; y++) for (let x = 0; x < 16; x++) px(c, r, x, y, shade('#5d3a20', 1));
    for (const x of [4, 8, 12]) {
      for (let y = 4; y < 12; y++) { px(c, r, x, y, '#4f8a33'); px(c, r, x + 1, y, '#5fa03c'); }
      for (let y = 2; y < 6; y++) { px(c, r, x, y, '#cfae4d'); px(c, r, x + 1, y, '#b8933c'); }
    }
  });
  // 28/29 堆肥箱（顶 / 侧）
  T(28, '#6f4a20', 0.06, (c, r) => {
    for (let x = 0; x < 16; x++) { px(c, r, x, 0, '#4f3416'); px(c, r, x, 15, '#4f3416'); }
    for (let y = 0; y < 16; y++) { px(c, r, 0, y, '#4f3416'); px(c, r, 15, y, '#4f3416'); }
    for (let y = 3; y < 13; y++) for (let x = 3; x < 13; x++) px(c, r, x, y, y % 3 === 0 ? '#4a3115' : '#3d5a2a');
    for (const [x, y] of [[5, 5], [9, 7], [6, 10], [10, 11]]) px(c, r, x, y, '#6b8f3d');
  });
  T(29, '#8a5f2c', 0.06, (c, r) => {
    for (let x = 0; x < 16; x++) { px(c, r, x, 0, '#4f3416'); px(c, r, x, 15, '#4f3416'); }
    for (let y = 0; y < 16; y++) { px(c, r, 0, y, '#4f3416'); px(c, r, 15, y, '#4f3416'); }
    for (let y = 4; y < 12; y++) { px(c, r, 1, y, '#6d4a20'); px(c, r, 14, y, '#6d4a20'); }
    for (let x = 2; x < 14; x++) px(c, r, x, 7, '#5c3f1b');
  });
  // 30 花岗岩：粉红底 + 黑白斑点
  T(30, '#b98a86', 0.1, (c, r) => {
    for (let i = 0; i < 34; i++) {
      const x = (i * 37) % 16, y = (i * 53) % 16;
      px(c, r, x, y, i % 3 === 0 ? '#e3cfcb' : i % 3 === 1 ? '#7d5a58' : '#a3766f');
    }
  });
  // 31 石灰岩：米白 + 细密横纹
  T(31, '#e3ddc9', 0.05, (c, r) => {
    for (let y = 0; y < 16; y += 3) for (let x = 0; x < 16; x++) px(c, r, x, y, '#cfc7ae');
    for (const [x, y] of [[3, 6], [9, 11], [12, 4], [6, 13]]) px(c, r, x, y, '#c2b99f');
  });
  // 32 云杉树皮（深褐竖纹）
  T(32, '#4a3524', 0.09, (c, r) => {
    for (let x = 0; x < 16; x += 3) for (let y = 0; y < 16; y++) px(c, r, x, y, '#33251a');
    for (let y = 0; y < 16; y += 5) for (let x = 0; x < 16; x++) px(c, r, x, y, '#59402c');
  });
  // 33 云杉年轮
  T(33, '#8a6a44', 0.05, (c, r) => {
    for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
      const d = Math.max(Math.abs(x - 7.5), Math.abs(y - 7.5));
      if (d > 6.5) px(c, r, x, y, '#3f2d1e');
      else if (Math.round(d) % 2 === 0) px(c, r, x, y, '#6f5232');
    }
  });
  // 34 云杉木板（更深的横板）
  T(34, '#6f4a28', 0.06, (c, r) => {
    for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
      if (y % 4 === 0) px(c, r, x, y, '#3f2a15');
      else if ((x * 5 + y * 3) % 13 === 0) px(c, r, x, y, '#5b3c1f');
    }
  });
  // 35 白桦树皮（白底黑斑）
  T(35, '#e8e4da', 0.04, (c, r) => {
    for (let i = 0; i < 16; i++) {
      const x = (i * 29) % 16, y = (i * 41) % 16;
      px(c, r, x, y, '#2b2924'); px(c, r, (x + 1) % 16, y, '#2b2924');
      if (i % 4 === 0) px(c, r, x, (y + 1) % 16, '#4a463d');
    }
  });
  // 36 白桦年轮
  T(36, '#d8c9a4', 0.04, (c, r) => {
    for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
      const d = Math.max(Math.abs(x - 7.5), Math.abs(y - 7.5));
      if (d > 6.5) px(c, r, x, y, '#8a7a56');
      else if (Math.round(d) % 2 === 0) px(c, r, x, y, '#bfae86');
    }
  });
  // 37 白桦木板（浅色横板）
  T(37, '#d8c9a0', 0.05, (c, r) => {
    for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
      if (y % 4 === 0) px(c, r, x, y, '#a8946a');
      else if ((x * 7 + y * 5) % 17 === 0) px(c, r, x, y, '#c4b285');
    }
  });
  // 38 枕头布：奶白 + 淡淡褶皱
  T(38, '#efeae0', 0.025, (c, r) => {
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
      const k = (x * 5 + y * 3) % 19;
      if (k === 0) px(c, r, x, y, '#ded6c6');
      if (k === 1 && x > 0) px(c, r, x - 1, y, '#e7e0d3');
    }
    for (let x = 0; x < S; x++) { px(c, r, x, 0, '#cfc7b6'); px(c, r, x, 15, '#d8d0bf'); }
  });
  // 39 被子：红底织纹（枕头是独立几何，这张瓦片不再画白枕带）
  T(39, '#b8423f', 0.05, (c, r) => {
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
      if ((x * 3 + y * 5) % 17 === 0) px(c, r, x, y, '#a33633');
      if (y % 8 === 3) px(c, r, x, y, '#a83a37');
    }
    for (let x = 0; x < S; x++) { px(c, r, x, 0, '#8e2c2a'); px(c, r, x, 15, '#8e2c2a'); }
  });
  // 24 石砖：整齐的砖块 + 灰浆缝
  T(24, '#8a8a8a', 0.07, (c, r) => {
    for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
      const row = (y / 4) | 0, off = (row % 2) * 4;
      const seamY = y % 4 === 0, seamX = (x + off) % 8 === 0;
      if (seamY || seamX) px(c, r, x, y, '#5f5f5f');
      else px(c, r, x, y, shade('#9a9a9a', 0.94 + ((x * 3 + y * 5) % 5) * 0.03));
    }
  });
  // 25 玻璃：浅蓝通透 + 白色反光条 + 深色边框
  T(25, '#cfe9f2', 0.02, (c, r) => {
    for (let x = 0; x < 16; x++) { px(c, r, x, 0, '#8fb6c4'); px(c, r, x, 15, '#8fb6c4'); }
    for (let y = 0; y < 16; y++) { px(c, r, 0, y, '#8fb6c4'); px(c, r, 15, y, '#8fb6c4'); }
    for (let i = 0; i < 14; i++) { px(c, r, 2 + i, 2 + i, '#f4fdff'); if (i < 9) px(c, r, 3 + i, 2 + i, '#e2f6ff'); }
    for (let i = 0; i < 8; i++) px(c, r, 9 + i, 4 + i, '#f4fdff');
  });
  T(23, '#8f8f8f', 0.09, (c, r) => {                 // 钻石矿：石底 + 青白色晶体颗粒
    const pts = [[2, 3], [5, 2], [11, 2], [13, 5], [7, 7], [9, 10], [3, 11], [12, 12], [5, 14], [14, 8], [10, 5]];
    for (const [x, y] of pts) {
      px(c, r, x, y, '#7ff0e2'); px(c, r, x + 1, y, '#2fc4b8');
      px(c, r, x, y + 1, '#c8fdf6'); px(c, r, x + 1, y + 1, '#49d8cb');
    }
  });
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
  T(8, '#b98a4e', 0.05, (c, r) => {
    // 4 条横向木板：板缝（深褐色） + 逐行色差
    for (let y = 0; y < S; y++) {
      const plank = (y / 4) | 0, inPlank = y % 4;
      const base = 0.93 + ((plank * 5 + inPlank) % 4) * 0.035;   // 每块板亮度略有差别
      for (let x = 0; x < S; x++) px(c, r, x, y, shade('#b98a4e', base));
      if (inPlank === 0) for (let x = 0; x < S; x++) px(c, r, x, y, '#7d5729');          // 板缝
      else if (inPlank === 3) for (let x = 0; x < S; x++) px(c, r, x, y, shade('#8d6534', 1)); // 板底阴影
    }
    // 木纹：短横向条纹（3~6 像素），只出现在板内部
    for (let y = 0; y < S; y++) {
      if (y % 4 === 0) continue;
      for (let x = 0; x < S; x++) {
        const k = (x * 7 + y * 23) % 13;
        if (k === 0) px(c, r, x, y, shade('#9c703c', 1));
        if (k === 1 && x > 0) px(c, r, x, y, shade('#a87a44', 1));
      }
    }
    // 错缝的板头接缝（竖向短线，位置错开才像铺板）
    for (const [bx, by] of [[3, 4], [10, 8], [6, 12]]) {
      for (let y = by + 1; y < Math.min(S, by + 4); y++) px(c, r, bx, y, shade('#6f4a20', 1));
    }
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
  // 17 农田：深色翻耕土 + 沟垄
  T(17, '#6a4426', 0.1, (c, r) => {
    for (let y = 3; y < 15; y += 3) for (let x = 1; x < 15; x++) px(c, r, x, y, shade('#4e3018', 1));
    for (let x = 2; x < 15; x += 5) for (let y = 1; y < 15; y++) px(c, r, x, y, shade('#5b3a1e', 1));
  });
  // 18 小麦：绿色秆 + 金黄穗
  T(18, '#3b6b28', 0.14, (c, r) => {
    for (let x = 2; x < 16; x += 4) {
      for (let y = 0; y < 16; y++) px(c, r, x, y, shade('#4f8a33', 1 + (Math.random() * 0.3 - 0.15)));
      for (let y = 1; y < 6; y++) { px(c, r, x, y, '#d9b24a'); px(c, r, Math.min(15, x + 1), y, '#c39a36'); }
    }
  });
  // 19 箱子侧 / 20 箱子顶
  T(19, '#9a6b33', 0.06, (c, r) => {
    for (let x = 0; x < 16; x++) { px(c, r, x, 0, '#6f4a20'); px(c, r, x, 15, '#6f4a20'); }
    for (let y = 0; y < 16; y++) { px(c, r, 0, y, '#6f4a20'); px(c, r, 15, y, '#6f4a20'); }
    for (let x = 6; x < 10; x++) for (let y = 6; y < 10; y++) px(c, r, x, y, '#cfd6de');
    for (let x = 7; x < 9; x++) for (let y = 7; y < 9; y++) px(c, r, x, y, '#8b939c');
  });
  T(20, '#a5723a', 0.06, (c, r) => {
    for (let x = 0; x < 16; x++) { px(c, r, x, 0, '#6f4a20'); px(c, r, x, 15, '#6f4a20'); }
    for (let y = 0; y < 16; y++) { px(c, r, 0, y, '#6f4a20'); px(c, r, 15, y, '#6f4a20'); }
    for (let x = 1; x < 15; x++) for (let y = 1; y < 15; y++) if ((x + y) % 5 === 0) px(c, r, x, y, '#8f6130');
  });
  // 21 熔炉侧面 / 22 熔炉顶
  T(21, '#6d6d6d', 0.1, (c, r) => {
    for (let x = 0; x < 16; x++) { px(c, r, x, 0, '#4a4a4a'); px(c, r, x, 15, '#4a4a4a'); }
    for (let y = 0; y < 16; y++) { px(c, r, 0, y, '#4a4a4a'); px(c, r, 15, y, '#4a4a4a'); }
    for (let x = 3; x < 13; x++) for (let y = 8; y < 14; y++) px(c, r, x, y, y > 10 ? '#3a2a20' : '#1a1512');
    for (let x = 4; x < 12; x++) for (let y = 12; y < 14; y++) px(c, r, x, y, '#c85a24');
  });
  T(22, '#787878', 0.1, (c, r) => {
    for (let x = 0; x < 16; x++) { px(c, r, x, 0, '#4a4a4a'); px(c, r, x, 15, '#4a4a4a'); }
    for (let y = 0; y < 16; y++) { px(c, r, 0, y, '#4a4a4a'); px(c, r, 15, y, '#4a4a4a'); }
    for (let x = 5; x < 11; x++) for (let y = 5; y < 11; y++) if ((x - 8) ** 2 + (y - 8) ** 2 < 7) px(c, r, x, y, '#2b2b2b');
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
  } else if (id === 107) { // 小麦
    g.lineCap = 'round'; g.lineWidth = 2.2;
    for (const [dx, rot] of [[-5, -0.3], [0, 0], [5, 0.3]]) {
      g.strokeStyle = '#6f9a3a';
      g.beginPath(); g.moveTo(16 + dx, 27); g.lineTo(16 + dx + rot * 9, 9); g.stroke();
      g.fillStyle = '#d9b24a';
      g.fillRect(13 + dx + rot * 7, 5, 5, 8);
      g.fillStyle = '#b8912f';
      g.fillRect(13 + dx + rot * 7, 5, 5, 2);
    }
  } else if (id === 156) { // 小麦种子
    g.fillStyle = '#d9b24a';
    for (const [x, y] of [[10, 12], [16, 10], [21, 14], [13, 18], [19, 20]]) {
      g.beginPath(); g.ellipse(x, y, 3, 2, 0.5, 0, 7); g.fill();
    }
    g.fillStyle = '#b8912f';
    for (const [x, y] of [[11, 13], [17, 11], [22, 15]]) { g.beginPath(); g.ellipse(x, y, 1.6, 1, 0.5, 0, 7); g.fill(); }
  } else if (id === 157) { // 肥料
    g.fillStyle = '#c9d0d8';
    g.beginPath(); g.moveTo(9, 8); g.lineTo(23, 8); g.lineTo(25, 26); g.lineTo(7, 26); g.closePath(); g.fill();
    g.fillStyle = '#5f8f3d';
    g.beginPath(); g.moveTo(10, 11); g.lineTo(22, 11); g.lineTo(23.4, 24); g.lineTo(8.6, 24); g.closePath(); g.fill();
    g.fillStyle = '#8fc45c'; g.fillRect(12, 14, 8, 3);
  } else if (ITEMS[id] && ITEMS[id].kind === 'hoe') { // 锄头
    const metal = id === 159 ? '#9a9a9a' : id === 160 ? '#d9dee5' : '#c8a06a';
    g.strokeStyle = '#b98a4e'; g.lineWidth = 4; g.lineCap = 'round';
    g.beginPath(); g.moveTo(11, 27); g.lineTo(20, 9); g.stroke();
    g.strokeStyle = metal; g.lineWidth = 5;
    g.beginPath(); g.moveTo(15, 7); g.lineTo(26, 9); g.stroke();
    g.beginPath(); g.moveTo(15, 7); g.lineTo(15, 12); g.stroke();
  } else if (id === 151 || id === 152) { // 桶 / 水桶
    g.fillStyle = '#c9d0d8';
    g.beginPath(); g.moveTo(7, 9); g.lineTo(25, 9); g.lineTo(22, 26); g.lineTo(10, 26); g.closePath(); g.fill();
    g.fillStyle = id === 152 ? '#3f9fe0' : '#7c8794';
    g.beginPath(); g.moveTo(9, 12); g.lineTo(23, 12); g.lineTo(20.6, 24); g.lineTo(11.4, 24); g.closePath(); g.fill();
    if (id === 152) { g.fillStyle = '#8fd4ff'; g.fillRect(11, 13, 10, 3); }
    g.strokeStyle = '#8b939c'; g.lineWidth = 2; g.beginPath(); g.moveTo(7, 9); g.lineTo(25, 9); g.stroke();
  } else if (id === 142) { // 羊毛
    g.fillStyle = '#f2efe6'; g.fillRect(5, 8, 22, 17);
    g.fillStyle = '#e2ddcf';
    for (const [x, y] of [[8, 11], [15, 9], [21, 13], [10, 17], [17, 19], [23, 21], [7, 22]]) g.fillRect(x, y, 4, 3);
  } else if (id === 148) { // 骨头
    g.strokeStyle = '#efe9d8'; g.lineWidth = 6; g.lineCap = 'round';
    g.beginPath(); g.moveTo(10, 22); g.lineTo(22, 10); g.stroke();
    g.fillStyle = '#efe9d8';
    for (const [x, y] of [[8, 23], [12, 26], [20, 6], [24, 9]]) { g.beginPath(); g.arc(x, y, 3.4, 0, 7); g.fill(); }
  } else if (id === 108 || id === 109 || id === 140 || id === 141 || id === 143 || id === 144) { // 肉类
    const cooked = id === 109 || id === 141 || id === 144;
    const bird = id === 143 || id === 144;
    const beef = id === 140 || id === 141;
    g.fillStyle = cooked ? (bird ? '#c98a4a' : '#a9622f') : (bird ? '#f0d6b8' : '#e08a8a');
    g.beginPath();
    if (bird) g.ellipse(16, 17, 8, 6.5, 0.3, 0, 7); else g.ellipse(15, 17, 9, 6.5, -0.2, 0, 7);
    g.fill();
    g.fillStyle = cooked ? (bird ? '#e0b070' : '#c98a4a') : (bird ? '#f8e6d0' : '#f2b3b3');
    g.beginPath(); g.ellipse(15, 16, 5.5, 3.5, -0.2, 0, 7); g.fill();
    if (beef || !bird) { g.fillStyle = '#efe6d2'; g.fillRect(23, 15, 5, 3.5); g.beginPath(); g.arc(28, 15.5, 2.4, 0, 7); g.fill(); }
    g.beginPath(); g.ellipse(15, 17, 9, 6.5, -0.2, 0, 7); g.fill();
    g.fillStyle = id === 108 ? '#f2b3b3' : '#c98a4a';
    g.beginPath(); g.ellipse(15, 16, 5.5, 3.5, -0.2, 0, 7); g.fill();
    g.fillStyle = '#efe6d2';
    g.fillRect(23, 15, 5, 3.5);
    g.beginPath(); g.arc(28, 15.5, 2.4, 0, 7); g.fill();
  } else if (id === 124) { // 面包
    g.fillStyle = '#c98a3f';
    g.beginPath(); g.ellipse(16, 16, 10, 6.5, 0, 0, 7); g.fill();
    g.fillStyle = '#8c5a25';
    g.beginPath(); g.ellipse(16, 13, 9.5, 3.4, 0, 0, 7); g.fill();
    g.strokeStyle = '#e9c089'; g.lineWidth = 1.6;
    for (const x of [11, 16, 21]) { g.beginPath(); g.moveTo(x, 11); g.lineTo(x + 1, 17); g.stroke(); }
  } else if (id === 125) { // 钻石
    g.fillStyle = '#3fd6c8';
    g.beginPath(); g.moveTo(16, 4); g.lineTo(27, 13); g.lineTo(16, 28); g.lineTo(5, 13); g.closePath(); g.fill();
    g.fillStyle = '#a9fbf2';
    g.beginPath(); g.moveTo(16, 7); g.lineTo(23, 13); g.lineTo(16, 24); g.lineTo(9, 13); g.closePath(); g.fill();
    g.fillStyle = '#effffd';
    g.beginPath(); g.moveTo(16, 7); g.lineTo(23, 13); g.lineTo(16, 13); g.closePath(); g.fill();
  } else if (ITEMS[id] && ITEMS[id].kind === 'pick') { // 镐
    const metal = id === 130 ? '#5fe6d8' : id === 101 ? '#9a9a9a' : id === 120 ? '#d9dee5' : '#c8a06a';
    g.strokeStyle = '#b98a4e'; g.lineWidth = 4; g.lineCap = 'round';
    g.beginPath(); g.moveTo(9, 27); g.lineTo(21, 12); g.stroke();
    g.strokeStyle = metal; g.lineWidth = 5;
    g.beginPath(); g.moveTo(9, 9); g.quadraticCurveTo(20, 5, 27, 13); g.stroke();
  } else if (ITEMS[id] && ITEMS[id].kind === 'sword') { // 剑
    const metal = id === 131 ? '#5fe6d8' : id === 149 ? '#efe9d8' : id === 103 ? '#b9b9b9' : id === 121 ? '#e3e8ef' : '#c8a06a';
    g.strokeStyle = metal; g.lineWidth = 5; g.lineCap = 'round';
    g.beginPath(); g.moveTo(10, 25); g.lineTo(24, 7); g.stroke();
    g.strokeStyle = '#8d6534'; g.lineWidth = 4;
    g.beginPath(); g.moveTo(7, 21); g.lineTo(14, 28); g.stroke();
  } else if (id === 106) { // 铁锭
    g.fillStyle = '#c9d0d8'; g.beginPath();
    g.moveTo(8, 21); g.lineTo(24, 21); g.lineTo(21, 12); g.lineTo(11, 12); g.closePath(); g.fill();
    g.fillStyle = '#e8eef4'; g.beginPath();
    g.moveTo(10, 19); g.lineTo(22, 19); g.lineTo(20, 14); g.lineTo(12, 14); g.closePath(); g.fill();
  } else if (ITEMS[id] && ITEMS[id].kind === 'armor') { // 盔甲
    const dia = id >= 132;
    const steel = dia ? '#5fe6d8' : '#d3dae2', dark = dia ? '#2fa89c' : '#8c98a6';
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
  if (inVillage(wx, wz)) return null;                 // 村庄范围内不长树
  if (inHaunted(wx, wz)) return null;                 // 鬼屋范围内不长树
  if (inExtraStruct(wx, wz)) return null;             // 其它结构范围内也不长树
  if (inRavine(wx, wz)) return null;                  // 峡谷里也不长树
  if (h2(wx * 2.17 + 91, wz * 3.31 - 17) < 0.977) return null;
  const g = heightAt(wx, wz);
  if (g <= CFG.SEA + 1 || g >= 45) return null;
  // 洞穴把地表这一列掏空了 → 别种（否则树干落在空气里，树悬在半空）
  if (caveCarve(wx, g, wz, g) || caveCarve(wx, g - 1, wz, g - 1)) return null;
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

/* ============================================================ 峡谷 / 裂谷 */
// 一条从地表撕开、直落十几到三十格的长裂谷：走路时能直接看见，谷底常见流水
const RV_CELL = 150;
const ravineCache = new Map();
function ravineFor(cellX, cellZ) {
  const key = cellX + ',' + cellZ;
  if (ravineCache.has(key)) return ravineCache.get(key);
  let out = null;
  const roll = h2(cellX * 53.7 + 7.3, cellZ * 29.1 - 3.9);
  if (roll > 0.16) {
    const rnd = mulberry32((Math.floor(roll * 1e9) ^ Math.imul(cellX, 40503) ^ Math.imul(cellZ, 12289)) | 0);
    let x = cellX * RV_CELL + 30 + Math.floor(rnd() * (RV_CELL - 60));
    let z = cellZ * RV_CELL + 30 + Math.floor(rnd() * (RV_CELL - 60));
    let ang = rnd() * Math.PI * 2;
    const len = 60 + Math.floor(rnd() * 70);
    const baseDepth = 20 + Math.floor(rnd() * 16);
    const baseW = 1 + Math.floor(rnd() * 2);        // 半宽 1..2（3~5 格宽）
    const water = rnd() < 0.55;
    const points = [], cols = new Set();
    let minX = 1e9, maxX = -1e9, minZ = 1e9, maxZ = -1e9;
    for (let i = 0; i < len; i++) {
      if (i % 6 === 0) ang += (rnd() - 0.5) * 0.7;
      x += Math.round(Math.cos(ang));
      z += Math.round(Math.sin(ang));
      const h = heightAt(x, z);
      if (h <= CFG.SEA + 2) continue;                 // 不往海里撕
      const depth = baseDepth + Math.floor(rnd() * 10);
      points.push({ x, z, top: h, bot: Math.max(4, h - depth), w: baseW + (rnd() < 0.2 ? 1 : 0) });
      cols.add(x + ',' + z);
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
    }
    if (points.length > 20) {
      const byChunk = new Map();
      points.forEach((pt, i) => {
        const k = (pt.x >> 4) + ',' + (pt.z >> 4);
        let arr = byChunk.get(k);
        if (!arr) byChunk.set(k, arr = []);
        arr.push(i);
      });
      out = { cellX, cellZ, points, byChunk, cols, water, minX, maxX, minZ, maxZ, n: points.length };
    }
  }
  ravineCache.set(key, out);
  return out;
}
function inRavine(x, z) {
  const cx = Math.floor(x / RV_CELL), cz = Math.floor(z / RV_CELL);
  for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
    const r = ravineFor(cx + dx, cz + dz);
    if (!r) continue;
    if (x < r.minX - 5 || x > r.maxX + 5 || z < r.minZ - 5 || z > r.maxZ + 5) continue;
    if (r.cols.has(x + ',' + z)) return true;
  }
  return false;
}

// ── 矿脉：按区块确定性生成，每条矿脉是 3~8 个连在一起的矿石 ──
const veinCache = new Map();
function oreVeins(cx, cz) {
  const key = cx + ',' + cz;
  if (veinCache.has(key)) return veinCache.get(key);
  const rnd = mulberry32((Math.imul(cx, 73856093) ^ Math.imul(cz, 19349663) ^ Math.imul(SEED, 83492791)) | 0);
  const out = [];
  const vein = (count, tile, size, yMin, yMax, chance = 1) => {
    for (let i = 0; i < count; i++) {
      if (chance < 1 && rnd() > chance) continue;
      let x = 1 + Math.floor(rnd() * 14), z = 1 + Math.floor(rnd() * 14);
      let y = yMin + Math.floor(rnd() * Math.max(1, yMax - yMin));
      const len = 3 + Math.floor(rnd() * size);
      for (let k = 0; k < len; k++) {
        out.push({ x, y, z, t: tile });
        const d = rnd();
        if (d < 0.3) x = Math.min(15, Math.max(0, x + (rnd() < 0.5 ? 1 : -1)));
        else if (d < 0.62) z = Math.min(15, Math.max(0, z + (rnd() < 0.5 ? 1 : -1)));
        else y = Math.min(CFG.WH - 4, Math.max(2, y + (rnd() < 0.5 ? 1 : -1)));
      }
    }
  };
  vein(48, 13, 5, 6, 44);        // 煤：总量和以前持平，但变成 48 条成簇矿脉
  vein(10, 15, 4, 4, 32);        // 铁：比以前稀有 ~1.6 倍
  vein(1, 20, 3, 3, 10, 0.07);   // 钻石：只有 7% 的区块有一条，且只在 y<10
  veinCache.set(key, out);
  return out;
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
      if (id !== 4 && caveCarve(wx, y, wz, h)) id = 0;                             // 洞穴（含天然洞口）
      if (id) b[idx(lx, y, lz)] = id;
    }
    for (let y = Math.max(h + 1, 0); y <= SEA && y < WH; y++) b[idx(lx, y, lz)] = 5;  // 水
  }
  // 矿脉：成簇埋进石头里（只在还是石头的地方替换，不动土/沙/水）
  for (const v of oreVeins(cx, cz)) {
    const i = idx(v.x, v.y, v.z);
    if (b[i] === 3) b[i] = v.t;
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
  // 峡谷（按点的索引取本块片段）
  const rvCellX = Math.floor(ox / RV_CELL), rvCellZ = Math.floor(oz / RV_CELL);
  for (let ddx = -1; ddx <= 1; ddx++) for (let ddz = -1; ddz <= 1; ddz++) {
    const rv = ravineFor(rvCellX + ddx, rvCellZ + ddz);
    if (!rv) continue;
    const list = rv.byChunk.get(selfKey);
    if (!list) continue;
    for (const pi of list) {
      const pt = rv.points[pi];
      const span = pt.top - pt.bot;
      // 水峡谷：从谷壁高处挂下一道瀑布（生成时就是完整水柱，走近后灌进谷底继续流）
      if (rv.water && pi % 11 === 0 && span > 10) {
        if (pt.x >= ox && pt.x < ox + CH && pt.z >= oz && pt.z < oz + CH) {
          for (let yy = pt.top - 4; yy >= pt.bot + 1; yy--) {
            if (yy > 0 && yy < WH) b[idx(pt.x - ox, yy, pt.z - oz)] = 5;
          }
        }
      }
      for (let dy = 0; dy <= span; dy++) {
        const y = pt.top - dy;
        if (y < 1 || y >= WH) continue;
        const t = dy / Math.max(1, span);
        const hw = Math.max(1, Math.round(pt.w * (1 - 0.25 * t)));   // 崖壁接近垂直，只微微收窄
        for (let ax = -hw; ax <= hw; ax++) for (let az = -hw; az <= hw; az++) {
          if (ax * ax + az * az > hw * hw + 0.9) continue;
          const x = pt.x + ax, z = pt.z + az;
          if (x < ox || x >= ox + CH || z < oz || z >= oz + CH) continue;
          const i = idx(x - ox, y, z - oz);
          const cur = b[i];
          if (cur === 0 || cur === 5) continue;
          const edge = ax * ax + az * az > (hw - 1) * (hw - 1);
          if (edge && dy % 7 === 0 && h3(x * 3 + 1, y * 7, z * 5 - 2) > 0.68) continue;   // 偶尔留岩台
          b[i] = 0;
        }
      }
      // 谷底积水
      if (rv.water && pi % 5 < 2) {          // 只在部分谷段积水，留出干路
        for (let ax = -1; ax <= 1; ax++) for (let az = -1; az <= 1; az++) {
          const x = pt.x + ax, z = pt.z + az;
          if (x < ox || x >= ox + CH || z < oz || z >= oz + CH) continue;
          const yy = pt.bot + 1;
          if (yy > 0 && yy < WH && b[idx(x - ox, yy, z - oz)] === 0) b[idx(x - ox, yy, z - oz)] = 5;
        }
      }
    }
  }
  // 村庄（同样按 byChunk 取本块片段）
  const vCellX = Math.floor(ox / VS_CELL), vCellZ = Math.floor(oz / VS_CELL);
  for (let ddx = -1; ddx <= 1; ddx++) for (let ddz = -1; ddz <= 1; ddz++) {
    const v = villageFor(vCellX + ddx, vCellZ + ddz);
    if (!v) continue;
    const arr = v.byChunk.get(selfKey);
    if (!arr) continue;
    for (const op of arr) {
      if (op.x < ox || op.x >= ox + CH || op.z < oz || op.z >= oz + CH) continue;
      if (op.y < 0 || op.y >= WH) continue;
      const i = (op.y * CH + (op.z - oz)) * CH + (op.x - ox);
      if (op.t === 0) {
        if (b[i] !== 0 && b[i] !== 5) b[i] = 0;
      } else if (b[i] !== 5) {
        b[i] = op.t;
        if (op.m) setMeta(op.x, op.y, op.z, op.m, true);   // 楼梯朝向随结构一起落地
      }
    }
  }
  // 废弃鬼屋（同样按 byChunk 取本块片段）
  const hCellX = Math.floor(ox / HS_CELL), hCellZ = Math.floor(oz / HS_CELL);
  for (let ddx = -1; ddx <= 1; ddx++) for (let ddz = -1; ddz <= 1; ddz++) {
    const hs = hauntedFor(hCellX + ddx, hCellZ + ddz);
    if (!hs) continue;
    const arrH = hs.byChunk.get(selfKey);
    if (!arrH) continue;
    for (const op of arrH) {
      if (op.x < ox || op.x >= ox + CH || op.z < oz || op.z >= oz + CH) continue;
      if (op.y < 0 || op.y >= WH) continue;
      const i = (op.y * CH + (op.z - oz)) * CH + (op.x - ox);
      if (op.t === 0) { if (b[i] !== 5) b[i] = 0; }
      else { b[i] = op.t; if (op.m) setMeta(op.x, op.y, op.z, op.m, true); }   // 楼梯朝向随结构一起落地
    }
  }
  applyExtraStructs(b, ox, oz, selfKey);
  // 悬空水清理：洞穴/裂谷/矿洞会把水下面的岩层掏空，水块就会浮在空中。
  // 从下往上扫，下面已经是空气（或刚被清掉）的水一起去掉；玩家靠近后模拟会从旁边补成瀑布。
  for (let y = 1; y < WH; y++) for (let z = 0; z < CH; z++) for (let x = 0; x < CH; x++) {
    const i = (y * CH + z) * CH + x;
    if (b[i] !== 5) continue;
    if (b[((y - 1) * CH + z) * CH + x] === 0) b[i] = 0;
  }
  return b;
}

function getChunk(cx, cz) {
  const k = ckey(cx, cz);
  let c = chunks.get(k);
  if (!c) {
    const blocks = genChunk(cx, cz);
    c = { cx, cz, blocks, mesh: null, glass: null, water: null, ready: false };
    // 应用存档里对该区块的改动（走按区块的索引，避免每次生成都全表扫描 + split）
    const bucket = editsByChunk.get(cx + ',' + cz);
    if (bucket) for (const [li, id] of bucket) blocks[li] = id;
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
const isSolid = id => id !== 0 && id !== 5 && !(BLOCKS[id] && BLOCKS[id].plant);   // 作物可穿过

// 存档改动按区块分桶：key "cx,cz" → Map(区块内线性下标 → 方块 id)
const editsByChunk = new Map();
function indexEdit(x, y, z, id) {
  const ck = (x >> 4) + ',' + (z >> 4);
  let m = editsByChunk.get(ck);
  if (!m) editsByChunk.set(ck, m = new Map());
  const li = (y * CFG.CH + (z & 15)) * CFG.CH + (x & 15);
  if (id === 0) m.delete(li); else m.set(li, id);
}
function reindexEdits() {
  editsByChunk.clear();
  for (const [k, id] of edits) {
    const p = k.split(',');
    indexEdit(+p[0], +p[1], +p[2], id);
  }
}

function setBlock(x, y, z, id, record = true) {
  if (id === 0) { const mk = metaKey(x, y, z); blockMeta.delete(mk); genMeta.delete(mk); }
  if (y < 0 || y >= CFG.WH) return;
  const cx = x >> 4, cz = z >> 4;
  const c = getChunk(cx, cz);
  c.blocks[(y * CFG.CH + (z & 15)) * CFG.CH + (x & 15)] = id;
  if (record) {
    if (edits.size > 40000) { edits.clear(); editsByChunk.clear(); }
    edits.set(x + ',' + y + ',' + z, id);
    indexEdit(x, y, z, id);
  }
  dirty.add(c);
  const lx = x & 15, lz = z & 15;
  if (lx === 0) markDirty(cx - 1, cz);
  if (lx === 15) markDirty(cx + 1, cz);
  if (lz === 0) markDirty(cx, cz - 1);
  if (lz === 15) markDirty(cx, cz + 1);
  if (!waterBusy && typeof wakeWater === 'function') wakeWater(x, y, z);
}
/* ---------- 水流动 ---------- */
// id 5 = 水。自然生成的水（海/湖/泉）算"水源"，不在表里；
// 表里的是流出来的水，带 0..4 的流动等级（0 = 从上方落下来的）。
const WATER_MAX_LVL = 4, WATER_CELL_CAP = 700;
const waterFlow = new Map();          // "x,y,z" -> level
const waterQueue = [];
let waterHead = 0;                       // 队列读指针（不用 shift，避免 O(n²)）
const waterQueued = new Set();
let waterBusy = false;                // 流体自己改方块时不要再反向唤醒（否则队列无限自激）

function enqueueWater(x, y, z) {
  if (y < 0 || y >= CFG.WH) return;
  const k = x + ',' + y + ',' + z;
  if (waterQueued.has(k)) return;
  const id = getBlock(x, y, z);
  if (id !== 5 && id !== 0) return;
  waterQueued.add(k);
  waterQueue.push([x, y, z, k]);
  if (waterHead > 4096 && waterHead * 2 > waterQueue.length) {   // 定期压实：数组别无限长
    waterQueue.splice(0, waterHead);
    waterHead = 0;
  }
}
function wakeWater(x, y, z) {
  // 方块变了：把周围的水/空气都排进队列，让它们重新判断该流还是该退
  enqueueWater(x, y, z);
  enqueueWater(x + 1, y, z); enqueueWater(x - 1, y, z);
  enqueueWater(x, y, z + 1); enqueueWater(x, y, z - 1);
  enqueueWater(x, y + 1, z); enqueueWater(x, y - 1, z);
}
function setWater(x, y, z, lvl) {
  waterBusy = true; setBlock(x, y, z, 5, true); waterBusy = false;
  waterFlow.set(x + ',' + y + ',' + z, lvl);
  enqueueWater(x, y, z);
}
function clearWater(x, y, z) {
  waterBusy = true; setBlock(x, y, z, 0, true); waterBusy = false;
  waterFlow.delete(x + ',' + y + ',' + z);
  enqueueWater(x, y + 1, z);
  enqueueWater(x + 1, y, z); enqueueWater(x - 1, y, z);
  enqueueWater(x, y, z + 1); enqueueWater(x, y, z - 1);
}
const flowLvl = (x, y, z) => {
  const v = waterFlow.get(x + ',' + y + ',' + z);
  return v === undefined ? -1 : v;
};
// 每帧跑一小批（预算控制），水才会"一格一格流过去"
function updateWater(budget = 40) {
  let n = 0, changed = 0;
  const t0 = performance.now();
  while (waterHead < waterQueue.length && n < budget) {
    const e = waterQueue[waterHead++];
    const x = e[0], y = e[1], z = e[2];
    waterQueued.delete(e[3]);
    n++;
    if ((n & 15) === 0 && performance.now() - t0 > 5) break;   // 时间预算：每帧最多 5ms，别把整帧吃掉
    const id = getBlock(x, y, z);
    const lvl = flowLvl(x, y, z);
    if (id !== 5) {                       // 已经不是水了
      if (lvl >= 0) waterFlow.delete(x + ',' + y + ',' + z);
      enqueueWater(x, y + 1, z);
      continue;
    }
    // 流动水是否还有来源撑腰（上方有水，或旁边有更低等级/水源）
    if (lvl >= 0) {
      let supported = getBlock(x, y + 1, z) === 5;
      if (!supported) {
        for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          if (getBlock(x + dx, y, z + dz) !== 5) continue;
          const nl = flowLvl(x + dx, y, z + dz);
          if (nl < 0 || nl < lvl) { supported = true; break; }
        }
      }
      if (!supported) { clearWater(x, y, z); changed++; continue; }
    }
    // 往下流：正下方的空气直接变成水
    if (y > 0 && getBlock(x, y - 1, z) === 0) {
      setWater(x, y - 1, z, 0);
      changed++;
      continue;                          // 有下落就不横向扩
    }
    // 横向铺开
    const next = (lvl < 0 ? 1 : lvl + 1);
    if (next > WATER_MAX_LVL) continue;
    if (waterFlow.size > WATER_CELL_CAP) continue;
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx, nz = z + dz;
      if (getBlock(nx, y, nz) === 0) {
        setWater(nx, y, nz, next);
        changed++;
      }
    }
  }
  return { processed: n, changed };
}

// 出生点：从 (8,8) 向外找一块高于海面的陆地，别让玩家出生就泡在水里
// 出生点若在鬼屋 3 格范围内，就挪到那栋鬼屋的门口（"一出生就能看到鬼屋"）
function spawnNearHouse(sp) {
  const cx = Math.floor(sp.x / HS_CELL), cz = Math.floor(sp.z / HS_CELL);
  let best = null;
  for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
    const hs = hauntedFor(cx + dx, cz + dz);
    if (!hs) continue;
    const d = Math.hypot(sp.x - hs.cx, sp.z - hs.cz);
    if (!best || d < best.d) best = { d, hs };
  }
  if (!best || best.d > 130) return sp;          // 只有鬼屋本来就在 130 格内才搬（不是每个种子都搬）
  const hs = best.hs;
  const x = hs.cx + 0.5, z = hs.cz + hs.D + 13.5;         // 正门前 13 格：一眼能看到整栋楼
  const g = heightAt(Math.floor(x), Math.floor(z));
  if (Math.abs(g - hs.y0) > 10) return sp;                 // 地形太离谱就放弃，别把人丢进裂谷
  return { x, y: Math.max(g, hs.y0) + 1, z, yaw: Math.atan2(-(hs.cx - x), -(hs.cz - z)) };
}
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
const glassMat = new THREE.MeshBasicMaterial({
  map: atlasTex, vertexColors: true, transparent: true, opacity: 0.42,
  depthWrite: false, side: THREE.DoubleSide, fog: true,
});
const waterMat = new THREE.MeshBasicMaterial({
  map: atlasTex, vertexColors: true, transparent: true, opacity: 0.74,
  depthWrite: false, side: THREE.DoubleSide, fog: true,
});

// 水面高度：水源/从上方落下的水 = 整格；横向流出的水按等级往下压，越远越薄
const waterTopH = (x, y, z) => {
  const lvl = flowLvl(x, y, z);
  if (lvl <= 0) return 1.0;
  return Math.max(0.42, 1 - 0.145 * lvl);          // 1..4 → 0.855 / 0.71 / 0.565 / 0.42
};
// 四个角点各自取周围最低水面 → 水面自然变成斜的（流到落差处会向下倾斜成瀑布口）
function waterCornerHeights(x, y, z) {
  const own = waterTopH(x, y, z);
  const surf = (nx, nz) => {
    const id = getBlock(nx, y, nz);
    if (id === 5) return waterTopH(nx, y, nz);
    if (id === 0) return getBlock(nx, y - 1, nz) === 0 ? 0.16 : own;   // 悬边 → 斜下去；靠着陆地 → 平
    return own;                                                        // 被方块挡住 → 平
  };
  const out = [[own, own], [own, own]];
  for (let ci = 0; ci <= 1; ci++) for (let cj = 0; cj <= 1; cj++) {
    let m = own;
    for (let dx = ci - 1; dx <= ci; dx++) for (let dz = cj - 1; dz <= cj; dz++) {
      if (dx === 0 && dz === 0) continue;
      const hh = surf(x + dx, z + dz);
      if (hh < m) m = hh;
    }
    out[ci][cj] = Math.max(0.14, m);
  }
  return out;
}

const FACES = [
  { n: [1, 0, 0], v: [[1, 0, 1], [1, 0, 0], [1, 1, 0], [1, 1, 1]], sh: 0.82 },
  { n: [-1, 0, 0], v: [[0, 0, 0], [0, 0, 1], [0, 1, 1], [0, 1, 0]], sh: 0.82 },
  { n: [0, 1, 0], v: [[0, 1, 1], [1, 1, 1], [1, 1, 0], [0, 1, 0]], sh: 1.0 },
  { n: [0, -1, 0], v: [[0, 0, 0], [1, 0, 0], [1, 0, 1], [0, 0, 1]], sh: 0.52 },
  { n: [0, 0, 1], v: [[0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]], sh: 0.7 },
  { n: [0, 0, -1], v: [[1, 0, 0], [0, 0, 0], [0, 1, 0], [1, 1, 0]], sh: 0.7 },
];
const CORNERS = [[0, 0], [1, 0], [1, 1], [0, 1]];
// 方块朝向（meta）：0=默认；原木 1=X轴 2=Z轴；楼梯 1..4=台阶高的那一侧朝向(+X,-X,+Z,-Z)
const blockMeta = new Map();       // 玩家放置的（要存档）
const genMeta = new Map();         // 结构生成时带的（不存档，重新生成时再算）
const metaKey = (x, y, z) => ((x + 32768) * 65536 + (z + 32768)) * 256 + y;
function getMeta(x, y, z) {
  const k = metaKey(x, y, z);
  return blockMeta.get(k) || genMeta.get(k) || 0;
}
function setMeta(x, y, z, m, gen = false) {
  const k = metaKey(x, y, z);
  if (!m) { blockMeta.delete(k); genMeta.delete(k); return; }
  if (gen) genMeta.set(k, m); else blockMeta.set(k, m);
}
function faceTile(def, fi, meta = 0) {
  if (def.log && meta) {                 // 横放的原木：两端露年轮
    if (meta === 1 && (fi === 0 || fi === 1)) return def.top;
    if (meta === 2 && (fi === 4 || fi === 5)) return def.top;
    return def.side ?? def.top;
  }
  if (fi === 2) return def.top;
  if (fi === 3) return def.bottom ?? def.top;
  return def.side ?? def.top;
}

// ⚠ 顶点必须写「区块内局部坐标」：buildChunk 给网格整体设置了 m.position=(ox,0,oz)，
// 这里若写世界坐标就会被重复偏移一次（楼梯飞到 2×区块原点之外，房顶楼梯全部消失）。
function emitStair(lx, y, lz, def, meta, P, U, C, I, base) {
  const tile = def.top;
  const u0 = (tile % ATLAS_COLS) / ATLAS_COLS + 0.0015;
  const v0 = 1 - (((tile / ATLAS_COLS) | 0) + 1) / ATLAS_ROWS + 0.0015;
  const iu = 1 / ATLAS_COLS - 0.003, iv = 1 / ATLAS_ROWS - 0.003;
  // 高侧：1=+X 2=-X 3=+Z 4=-Z
  const hi = meta || 3;
  let bx0 = 0, bx1 = 1, bz0 = 0, bz1 = 1;
  if (hi === 1) bx1 = 0.5; else if (hi === 2) bx0 = 0.5;
  else if (hi === 3) bz1 = 0.5; else if (hi === 4) bz0 = 0.5;
  const boxes = [[0, 0, 0, 1, 0.5, 1], [bx0, 0.5, bz0, bx1, 1, bz1]];
  let v = base, first = true;
  for (const [x0, y0, z0, x1, y1, z1] of boxes) {
    for (let fi = 0; fi < 6; fi++) {
      // 底盒的顶面必须画：顶盒只盖住一半，另一半就是台阶面（不画就会看到破洞/像块悬空板）
      if (!first && fi === 3) continue;                      // 顶盒底面被底盒顶面盖住，剔掉防 z-fighting
      const F = FACES[fi], sh = F.sh, s = sh;
      for (let k = 0; k < 4; k++) {
        const V = F.v[k];
        P.push(lx + (V[0] ? x1 : x0), y + (V[1] ? y1 : y0), lz + (V[2] ? z1 : z0));
        U.push(u0 + CORNERS[k][0] * iu, v0 + CORNERS[k][1] * iv);
        C.push(s, s, s);
      }
      I.push(v, v + 1, v + 2, v, v + 2, v + 3);
      v += 4;
    }
    first = false;
  }
  return v - base;                          // 实际压入的顶点数（跳过顶盒底面 = 11 面 / 44 顶点）
}

// ── 通用盒子：自定义形状（床/家具）用。只画 5 面（底面永远贴在下面一层，画了只会 z-fighting）
// 坐标全是「区块内局部坐标 + 格内偏移 0..1」，别写世界坐标（见 emitStair 上面那条注释）
function emitBox(P, U, C, I, base, lx, y, lz, x0, x1, y0, y1, z0, z1, tile) {
  const u0 = (tile % ATLAS_COLS) / ATLAS_COLS + 0.0015;
  const v0 = 1 - (((tile / ATLAS_COLS) | 0) + 1) / ATLAS_ROWS + 0.0015;
  const iu = 1 / ATLAS_COLS - 0.003, iv = 1 / ATLAS_ROWS - 0.003;
  let v = base;
  for (let fi = 0; fi < 6; fi++) {
    if (fi === 3) continue;                                // 底面不画
    const F = FACES[fi], s = F.sh;
    for (let k = 0; k < 4; k++) {
      const V = F.v[k];
      P.push(lx + (V[0] ? x1 : x0), y + (V[1] ? y1 : y0), lz + (V[2] ? z1 : z0));
      U.push(u0 + CORNERS[k][0] * iu, v0 + CORNERS[k][1] * iv);
      C.push(s, s, s);
    }
    I.push(v, v + 1, v + 2, v, v + 2, v + 3);
    v += 4;
  }
  return v - base;
}

// ── 床：木床架 + 床垫 + 3D 枕头（两格）。meta：脚格 1..4 = 指向床头的方向；
//    头格 5..8 = 同上 +4（只有头格画枕头，所以一对床只有一只枕头）。
//    meta=0（旧存档）按邻居推断，保证老床也能出一只枕头。
const BED_T_FRAME = 8, BED_T_MAT = 39, BED_T_PILLOW = 38;
function bedFacing(wx, y, wz, meta) {
  if (meta) return { dir: meta > 4 ? meta - 4 : meta, head: meta > 4 };
  const isBed = (dx, dz) => getBlock(wx + dx, y, wz + dz) === 14;
  if (isBed(-1, 0)) return { dir: 1, head: true };          // 同伴在 -X ⇒ 自己在 +X 端 = 头
  if (isBed(1, 0)) return { dir: 2, head: false };          // 同伴在 +X ⇒ 自己是脚
  if (isBed(0, -1)) return { dir: 3, head: true };
  if (isBed(0, 1)) return { dir: 4, head: false };
  return { dir: 3, head: true };                            // 单格孤床：当床头，至少有个枕头
}
function emitBed(lx, y, lz, wx, wz, meta, P, U, C, I, base) {
  const { dir, head } = bedFacing(wx, y, wz, meta);
  const alongX = dir === 1 || dir === 2;                    // 床轴 = X 轴
  const flip = dir === 2 || dir === 4;                      // 沿轴坐标 0 = 脚那侧，需要取反
  const mapA = t => flip ? 1 - t : t;
  let n = 0;
  const box = (a0, a1, w0, w1, y0, y1, tile) => {           // a=沿床轴, w=横向
    const p0 = mapA(a0), p1 = mapA(a1);
    const lo = Math.min(p0, p1), hi = Math.max(p0, p1);
    n += alongX
      ? emitBox(P, U, C, I, base + n, lx, y, lz, lo, hi, y0, y1, w0, w1, tile)
      : emitBox(P, U, C, I, base + n, lx, y, lz, w0, w1, y0, y1, lo, hi, tile);
  };
  box(0.04, 0.96, 0.04, 0.96, 0.00, 0.16, BED_T_FRAME);     // 木床架
  box(0.02, 0.98, 0.06, 0.94, 0.16, 0.45, BED_T_MAT);       // 床垫/被子
  if (head) box(0.70, 0.96, 0.14, 0.86, 0.45, 0.58, BED_T_PILLOW);   // 枕头（床头远端）
  return n;
}

function buildChunk(chunk) {
  const CH = CFG.CH, WH = CFG.WH;
  const ox = chunk.cx * CH, oz = chunk.cz * CH;
  const P = [], U = [], C = [], I = [];
  const P2 = [], U2 = [], C2 = [], I2 = [];
  const P3 = [], U3 = [], C3 = [], I3 = [];
  let vc = 0, vw = 0, vg = 0;
  for (let y = 0; y < WH; y++) for (let z = 0; z < CH; z++) for (let x = 0; x < CH; x++) {
    const id = chunk.blocks[(y * CH + z) * CH + x];
    if (!id) continue;
    const def = BLOCKS[id];
    if (!def) continue;
    const wx = ox + x, wz = oz + z;
    const meta = (blockMeta.size || genMeta.size) ? getMeta(wx, y, wz) : 0;
    if (def.stair) { vc += emitStair(x, y, z, def, meta, P, U, C, I, vc); continue; }
    if (def.bed) { vc += emitBed(x, y, z, wx, wz, meta, P, U, C, I, vc); continue; }
    const water = id === 5;
    const glass = id === 22;
    const solidTop = def.half || 1;                       // 床这类半格方块
    let wch = null;                                       // 水面角点高度缓存
    for (let fi = 0; fi < 6; fi++) {
      const f = FACES[fi];
      const nb = getBlock(wx + f.n[0], y + f.n[1], wz + f.n[2]);
      if (water) { if (nb !== 0) continue; }
      else if (glass) { if (nb === 22 || nb === 5) continue; }          // 玻璃之间不画内面
      // ⚠ 半格方块（床）不是满格：它只占下半格，若照旧把邻面剔掉，
      // 邻居方块朝向床的那一面就整面消失 → 从床上看过去能直接穿进方块里（"床周围方块穿透"）。
      // 半格邻居一律照画（半格自己的侧面会被这一条同源规则挡住，不会 z-fighting）。
      else if (nb !== 0 && nb !== 5 && nb !== 22 && !(BLOCKS[nb] && BLOCKS[nb].half)) continue;
      const t = faceTile(def, fi, meta);
      const u0 = (t % ATLAS_COLS) / ATLAS_COLS + 0.0015;
      const v0 = 1 - (((t / ATLAS_COLS) | 0) + 1) / ATLAS_ROWS + 0.0015;
      const iu = 1 / ATLAS_COLS - 0.003, iv = 1 / ATLAS_ROWS - 0.003;
      const jit = 0.95 + h3(wx * 3 + fi, y * 7, wz * 5) * 0.1;
      const s = f.sh * jit;
      const base = water ? vw : glass ? vg : vc;
      for (let k = 0; k < 4; k++) {
        const V = f.v[k];
        let vy = V[1] * solidTop;
        if (water && V[1] === 1) {                        // 水面顶点按角点高度 → 斜坡
          if (!wch) wch = waterCornerHeights(wx, y, wz);
          vy = wch[V[0]][V[2]];
        }
        const dst = water ? P2 : glass ? P3 : P;
        const du = water ? U2 : glass ? U3 : U;
        const dc = water ? C2 : glass ? C3 : C;
        dst.push(x + V[0], y + vy, z + V[2]);
        du.push(u0 + CORNERS[k][0] * iu, v0 + CORNERS[k][1] * iv);
        dc.push(s, s, s);
      }
      const di = water ? I2 : glass ? I3 : I;
      di.push(base, base + 1, base + 2, base, base + 2, base + 3);
      if (water) vw += 4; else if (glass) vg += 4; else vc += 4;
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
  const ng = mk(P3, U3, C3, I3, glassMat);
  const nw = mk(P2, U2, C2, I2, waterMat);
  if (chunk.mesh) { scene.remove(chunk.mesh); chunk.mesh.geometry.dispose(); }
  if (chunk.glass) { scene.remove(chunk.glass); chunk.glass.geometry.dispose(); }
  if (chunk.water) { scene.remove(chunk.water); chunk.water.geometry.dispose(); }
  chunk.mesh = nm; chunk.glass = ng; chunk.water = nw;
  if (nm) scene.add(nm);
  if (ng) { ng.renderOrder = 1; scene.add(ng); }
  if (nw) { nw.renderOrder = 2; scene.add(nw); }
  chunk.ready = true;
}

/* ============================================================ 玩家 */
const player = {
  p: new THREE.Vector3(8, 40, 8), v: new THREE.Vector3(),
  yaw: 0, pitch: 0, onGround: false,
  hp: 20, hunger: 20, alive: true, fly: false,
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
// 背包是 27 个固定格子（空格为 null），这样物品可以在格子里随意换位置
const SLOTS = 27;
let inv = new Array(SLOTS).fill(null);
const STACK_MAX = 64;

// 工具类物品单独占格、每把一份剩余耐久（d），用坏时整把消失
function useTool(n = 1) {
  if (isCreative()) return;                       // 创造模式不掉耐久
  const s = inv[player.sel];
  if (!s) return;
  const def = ITEMS[s.id];
  if (!def || !def.dur) return;
  if (s.d === undefined) s.d = def.dur;
  s.d -= n;
  if (s.d <= 0) {
    inv[player.sel] = null;
    toast(`${def.name}用坏了`, 2.0);
    sfx('hurt');
    refreshHeld();
  }
  renderHotbar();
  if (panelOpen) renderInventoryPanel();
  saveSoon();
}
function addItem(id, n = 1) {
  if (!isItem(id)) return false;
  const idef = defOf(id) || {};
  if (idef.dur) {                                  // 工具/剑：一把一格，带耐久
    let left = n;
    for (let i = 0; i < SLOTS && left > 0; i++) if (!inv[i]) { inv[i] = { id, n: 1, d: idef.dur }; left--; }
    if (left > 0) toast('背包满了，东西掉在脚下', 1.5);
    return left < n;
  }
  for (let i = 0; i < SLOTS && n > 0; i++) {
    const s = inv[i];
    if (s && s.id === id && s.n < STACK_MAX) { const add = Math.min(STACK_MAX - s.n, n); s.n += add; n -= add; }
  }
  for (let i = 0; i < SLOTS && n > 0; i++) {
    if (!inv[i]) { const add = Math.min(STACK_MAX, n); inv[i] = { id, n: add }; n -= add; }
  }
  if (n > 0) toast('背包满了，东西掉在脚下', 1.5);
  return n === 0;
}
function countOf(id) { let n = 0; for (const s of inv) if (s && s.id === id) n += s.n; return n; }
function takeItem(id, n) {
  for (let i = 0; i < SLOTS && n > 0; i++) {
    const s = inv[i];
    if (!s || s.id !== id) continue;
    const take = Math.min(s.n, n);
    s.n -= take; n -= take;
    if (s.n <= 0) inv[i] = null;
  }
  return n === 0;
}
const held = () => inv[player.sel] || null;
const heldKind = () => { const h = held(); return h ? (defOf(h.id) || {}).kind : null; };
const hasPick = () => inv.some(s => s && (defOf(s.id) || {}).kind === 'pick');
const invUsed = () => inv.filter(Boolean).length;

function collides(px, py, pz) {
  const hw = CFG.HW, h = CFG.PH;
  const x0 = Math.floor(px - hw), x1 = Math.floor(px + hw);
  const y0 = Math.floor(py + 0.001), y1 = Math.floor(py + h - 0.001);
  const z0 = Math.floor(pz - hw), z1 = Math.floor(pz + hw);
  for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) {
    const id = getBlock(x, y, z);
    if (!isSolid(id)) continue;
    const half = (BLOCKS[id] || {}).half;
    if (half && py >= y + half - 0.03) continue;              // 半格方块（床）：站在上面不算卡住
    return true;
  }
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
  const ironM = new THREE.MeshLambertMaterial({ color: 0xd9dee5 });
  const diaM = new THREE.MeshLambertMaterial({ color: 0x5fe6d8 });
  if (id === 100 || id === 101 || id === 120 || id === 130) {  // 镐
    const head = id === 130 ? diaM : id === 101 ? stoneM : id === 120 ? ironM : wood;
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
  } else if (id === 102 || id === 103 || id === 121 || id === 131 || id === 149) {       // 剑
    const bladeMat = id === 131 ? diaM : id === 149 ? new THREE.MeshLambertMaterial({ color: 0xefe9d8 }) : id === 103 ? stoneD : id === 121 ? ironM : new THREE.MeshLambertMaterial({ color: 0xd9c49b });
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
  } else if (id === 158 || id === 159 || id === 160) {   // 锄头
    const headMat = id === 159 ? stoneM : id === 160 ? ironM : wood;
    const handle = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.5, 0.04), woodDark);
    handle.position.y = -0.08;
    const blade = new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.07, 0.07), headMat);
    blade.position.set(0.1, 0.19, 0);
    blade.rotation.z = -0.12;
    g.add(handle, blade);
  } else if (id === 153) {                     // 弓
    const limb = new THREE.MeshLambertMaterial({ color: 0x8a6134 });
    const s1 = new THREE.Mesh(new THREE.BoxGeometry(0.045, 0.42, 0.045), limb);
    s1.position.set(0, 0.1, 0.06); s1.rotation.x = 0.32;
    const s2 = s1.clone(); s2.position.set(0, 0.1, -0.06); s2.rotation.x = -0.32;
    const grip = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.16, 0.07), new THREE.MeshLambertMaterial({ color: 0x6f4a20 }));
    const string = new THREE.Mesh(new THREE.BoxGeometry(0.012, 0.5, 0.012), new THREE.MeshLambertMaterial({ color: 0xf2efe6 }));
    string.position.z = 0.0; string.position.y = 0.1;
    g.add(s1, s2, grip, string);
  } else if (id === 154) {                     // 箭
    const shaft = new THREE.Mesh(new THREE.BoxGeometry(0.028, 0.5, 0.028), new THREE.MeshLambertMaterial({ color: 0x8a6134 }));
    shaft.position.y = 0.16;
    const tip = new THREE.Mesh(new THREE.ConeGeometry(0.045, 0.1, 4), new THREE.MeshLambertMaterial({ color: 0xc9d0d8 }));
    tip.position.y = 0.43; tip.rotation.x = Math.PI;
    const fin = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.12, 0.012), new THREE.MeshLambertMaterial({ color: 0xf2efe6 }));
    fin.position.y = -0.04;
    g.add(shaft, tip, fin);
  } else if (id === 125) {                     // 钻石
    const a = new THREE.Mesh(new THREE.OctahedronGeometry(0.13), diaM);
    a.position.y = 0.14; a.scale.y = 1.25;
    const b2 = new THREE.Mesh(new THREE.OctahedronGeometry(0.07), new THREE.MeshLambertMaterial({ color: 0xa9fbf2 }));
    b2.position.set(0.03, 0.2, 0.02);
    g.add(a, b2);
  } else if (id === 106) {                     // 铁锭
    const a = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.07, 0.1), ironM);
    a.position.y = 0.1;
    const b2 = new THREE.Mesh(new THREE.BoxGeometry(0.17, 0.055, 0.088), new THREE.MeshLambertMaterial({ color: 0xeff4f9 }));
    b2.position.y = 0.15;
    g.add(a, b2);
  } else if (id === 107) {                     // 小麦
    for (let i = 0; i < 3; i++) {
      const stalk = new THREE.Mesh(new THREE.BoxGeometry(0.022, 0.34, 0.022), new THREE.MeshLambertMaterial({ color: 0x6f9a3a }));
      stalk.position.set((i - 1) * 0.055, 0.16, 0);
      stalk.rotation.z = (i - 1) * 0.2;
      const ear = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.1, 0.05), new THREE.MeshLambertMaterial({ color: 0xd9b24a }));
      ear.position.set((i - 1) * 0.055, 0.33, 0);
      g.add(stalk, ear);
    }
  } else if (id === 108 || id === 109) {        // 猪排
    const raw = id === 108;
    const meat = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.06, 0.15), new THREE.MeshLambertMaterial({ color: raw ? 0xe08a8a : 0xa9622f }));
    meat.position.y = 0.1;
    const bone = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.05, 0.055), new THREE.MeshLambertMaterial({ color: 0xefe6d2 }));
    bone.position.set(0.12, 0.1, 0);
    g.add(meat, bone);
  } else if (id === 124) {                     // 面包
    const loaf = new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.11, 0.14), new THREE.MeshLambertMaterial({ color: 0xc98a3f }));
    loaf.position.y = 0.12;
    const crust = new THREE.Mesh(new THREE.BoxGeometry(0.27, 0.035, 0.15), new THREE.MeshLambertMaterial({ color: 0x8c5a25 }));
    crust.position.y = 0.175;
    g.add(loaf, crust);
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
  bow: { rx: -1.2, ry: 0.15, rz: -0.1, py: 0.02, pz: 0.06 },
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
    if (anim.swingType === 'bow') {
      anim.bowK = p < 0.55 ? p / 0.55 : Math.max(0, 1 - (p - 0.55) / 0.18);
      anim.swingA = 0;
    } else {
      anim.bowK = 0;
      const a = anim.swingType === 'attack' ? swingCurve(p, 0.3, 0.52)
              : Math.sin(clamp01(p) * Math.PI);    // 放置 = 轻轻一推
      anim.swingA = a;
      aTotal += a * (anim.swingType === 'attack' ? 1 : 0.55);
    }
  } else { anim.swingA = 0; anim.bowK = 0; }

  rx += aTotal * 0.62;
  pz += -0.05 * Math.max(0, aTotal);
  rz += aTotal * 0.1;
  // 弓：前 55% 往后拉弦，之后啪地弹回去
  if (anim.bowK > 0) {
    const k = anim.bowK;
    px -= 0.02 * k; py -= 0.035 * k; pz += 0.11 * k;
    rx -= 0.5 * k; rz -= 0.14 * k;
  }

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
let waterSeedT = 0.5;
// 玩家附近有水就排队（新生成的水没有"变化事件"，需要主动唤醒）
function seedWaterNear() {
  const px = Math.floor(player.p.x), py = Math.floor(player.p.y), pz = Math.floor(player.p.z);
  for (let dx = -10; dx <= 10; dx += 2) for (let dz = -10; dz <= 10; dz += 2) {
    for (let y = Math.min(CFG.WH - 2, py + 8); y >= Math.max(1, py - 12); y--) {
      const id = getBlock(px + dx, y, pz + dz);
      if (id === 5) { if (getBlock(px + dx, y - 1, pz + dz) === 0) wakeWater(px + dx, y, pz + dz); break; }
      if (id !== 0) break;
    }
  }
  scrubWaterNear();
}
// 兜底：附近"下面悬空"的静态水 → 变下落水（如果是水柱）或直接清掉（孤立水块）
function scrubWaterNear(r = 7) {
  const px = Math.floor(player.p.x), py = Math.floor(player.p.y), pz = Math.floor(player.p.z);
  for (let dx = -r; dx <= r; dx++) for (let dz = -r; dz <= r; dz++) {
    for (let y = Math.max(1, py - 6); y <= Math.min(CFG.WH - 2, py + 9); y++) {
      const x = px + dx, z = pz + dz;
      if (getBlock(x, y, z) !== 5) continue;
      if (flowLvl(x, y, z) >= 0) continue;                    // 流动水交给模拟
      const below = getBlock(x, y - 1, z);
      const above = getBlock(x, y + 1, z) === 5;
      let nb = false;                                        // 四周有没有水
      for (const [ax, az] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) if (getBlock(x + ax, y, z + az) === 5) { nb = true; break; }
      if (above) { if (below === 0) setWater(x, y, z, 0); continue; }        // 水柱中间：脚下悬空就变下落水
      if (below !== 0 && below !== 5) continue;              // 站在固体上 → 正常水源
      if (!nb) { clearWater(x, y, z); continue; }            // 顶上＋四周没有水＋脚下不是地面 ⇒ 浮空水，清掉
      if (below !== 5) setWater(x, y, z, 0);                 // 连着横向水源但脚下悬空 → 交给模拟
    }
  }
}
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
// 氛围判定：玩家比地表低多少格（>2.5 才算地下）。不扫头顶方块，站在树叶下面不会被误判成矿洞
function depthBelowSurface() {
  return heightAt(Math.floor(player.p.x), Math.floor(player.p.z)) - player.p.y;
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

/* ============================================================ 新结构（塔/井/石阵/营地/木屋） */
// 两坡屋顶：沿 Z 方向起脊，中间实、两侧收；stairTile 给了就在坡口加楼梯
function buildGableRoof(put, cx, cz, y, W, D, tile, stairTile) {
  for (let k = 0; k <= D; k++) {
    const half = D - k, yy = y + k;
    for (let dx = -W; dx <= W; dx++) {
      put(cx + dx, yy, cz - half, tile);
      put(cx + dx, yy, cz + half, tile);
      if (Math.abs(dx) === W) {                                    // 两端山墙填实
        for (let dz = -half + 1; dz <= half - 1; dz++) put(cx + dx, yy, cz + dz, tile);
      }
      if (stairTile && k < D) {                                    // 坡口压楼梯（台阶朝下）
        put(cx + dx, yy, cz - half - 1, stairTile, 4);
        put(cx + dx, yy, cz + half + 1, stairTile, 3);
      }
    }
  }
  for (let dx = -W; dx <= W; dx++) put(cx + dx, y + D, cz, tile);   // 屋脊
}

// 结构间距：任意两栋结构中心至少隔 34 格（避免叠在一起）
const STRUCT_MIN_GAP = 34;
const structGuard = new Set();
const STRUCT_TYPES = [];                   // 由文件末尾注册
let structDepth = 0;
function structNear(x, z, skip) {
  // 深度限制：嵌套超过 2 层就只看缓存，不再触发生成（否则 A→B→C→A 会爆栈）
  structDepth++;
  try {
    const peekOnly = structDepth > 2;
    for (const t of STRUCT_TYPES) {
      if (t.name === skip) continue;
      const cx = Math.floor(x / t.cell), cz = Math.floor(z / t.cell);
      for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
        const o = peekOnly ? (t.cache ? t.cache.get((cx + dx) + ',' + (cz + dz)) : null) : t.get(cx + dx, cz + dz);
        if (!o) continue;
        if (Math.max(Math.abs(o.cx - x), Math.abs(o.cz - z)) < STRUCT_MIN_GAP) return t.name;
      }
    }
    return null;
  } finally { structDepth--; }
}
function guarded(name, key, fn) {
  const g = name + key;
  if (structGuard.has(g)) return null;
  structGuard.add(g);
  try { return fn(); } finally { structGuard.delete(g); }
}
function packOps(ops) {
  const byChunk = new Map();
  for (const op of ops) {
    const k = (op.x >> 4) + ',' + (op.z >> 4);
    let arr = byChunk.get(k);
    if (!arr) byChunk.set(k, arr = []);
    arr.push(op);
  }
  return byChunk;
}

// 石塔
const TW_CELL = 256, towerCache = new Map();
function towerFor(cellX, cellZ) {
  const key = cellX + ',' + cellZ;
  if (towerCache.has(key)) return towerCache.get(key);
  return guarded('tower', key, () => {
    let out = null;
    const roll = h2(cellX * 53.7 + 7.7, cellZ * 39.1 - 4.3);
    if (roll > 0.42) {
      const rnd = mulberry32((Math.floor(roll * 1e9) ^ Math.imul(cellX, 2246822519) ^ Math.imul(cellZ, 3266489917)) | 0);
      const cx = cellX * TW_CELL + 60 + Math.floor(rnd() * (TW_CELL - 120));
      const cz = cellZ * TW_CELL + 60 + Math.floor(rnd() * (TW_CELL - 120));
      const ops = [], put = (x, y, z, t, m) => ops.push({ x, y, z, t, m }), carve = (x, y, z) => ops.push({ x, y, z, t: 0 });
      let gy = 0;
      for (let dx = -3; dx <= 3; dx++) for (let dz = -3; dz <= 3; dz++) gy = Math.max(gy, heightAt(cx + dx, cz + dz));
      if (gy > CFG.SEA + 3 && gy < 40 && !structNear(cx, cz, 'tower')) {
        const H = 12 + Math.floor(rnd() * 8);
        for (let y = 1; y <= H; y++) for (let dx = -2; dx <= 2; dx++) for (let dz = -2; dz <= 2; dz++) {
          const edge = Math.abs(dx) === 2 || Math.abs(dz) === 2;
          const win = y % 4 === 2 && (dx === 0 || dz === 0);
          if (edge) put(cx + dx, gy + y, cz + dz, win ? 22 : 21);
          else carve(cx + dx, gy + y, cz + dz);
        }
        for (let y = 1; y <= H; y++) {                               // 内圈螺旋石阶
          const a = Math.floor(y / 2) % 4;
          const d = [[0, -1], [1, 0], [0, 1], [-1, 0]][a];
          put(cx + d[0], gy + y, cz + d[1], 33, 0);
        }
        for (let dx = -3; dx <= 3; dx++) for (let dz = -3; dz <= 3; dz++) put(cx + dx, gy + H + 1, cz + dz, 21);
        for (let dx = -3; dx <= 3; dx += 2) for (let dz = -3; dz <= 3; dz += 2) put(cx + dx, gy + H + 2, cz + dz, 21);
        put(cx, gy + 1, cz, 18);
        out = { name: 'tower', cx, cz, gy, byChunk: packOps(ops), ops: ops.length, label: '石塔' };
      }
    }
    towerCache.set(key, out);
    return out;
  });
}

// 水井
const WL_CELL = 192, wellCache = new Map();
function wellFor(cellX, cellZ) {
  const key = cellX + ',' + cellZ;
  if (wellCache.has(key)) return wellCache.get(key);
  return guarded('well', key, () => {
    let out = null;
    const roll = h2(cellX * 21.3 - 5.1, cellZ * 61.9 + 9.7);
    if (roll > 0.5) {
      const rnd = mulberry32((Math.floor(roll * 1e9) ^ Math.imul(cellX, 668265263) ^ Math.imul(cellZ, 374761393)) | 0);
      const cx = cellX * WL_CELL + 40 + Math.floor(rnd() * (WL_CELL - 80));
      const cz = cellZ * WL_CELL + 40 + Math.floor(rnd() * (WL_CELL - 80));
      const gy = heightAt(cx, cz);
      const ops = [], put = (x, y, z, t, m) => ops.push({ x, y, z, t, m }), carve = (x, y, z) => ops.push({ x, y, z, t: 0 });
      if (gy > CFG.SEA + 2 && gy < 44 && !structNear(cx, cz, 'well')) {
        for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
          const edge = Math.abs(dx) === 1 || Math.abs(dz) === 1;
          put(cx + dx, gy, cz + dz, edge ? 9 : 5);
          carve(cx + dx, gy + 1, cz + dz);
        }
        for (const p of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) for (let y = 1; y <= 3; y++) put(cx + p[0], gy + y, cz + p[1], 28);
        for (let dx = -2; dx <= 2; dx++) for (let dz = -2; dz <= 2; dz++) put(cx + dx, gy + 4, cz + dz, 34);
        out = { name: 'well', cx, cz, gy, byChunk: packOps(ops), ops: ops.length, label: '水井' };
      }
    }
    wellCache.set(key, out);
    return out;
  });
}

// 石阵
const SC_CELL = 320, circleCache = new Map();
function circleFor(cellX, cellZ) {
  const key = cellX + ',' + cellZ;
  if (circleCache.has(key)) return circleCache.get(key);
  return guarded('circle', key, () => {
    let out = null;
    const roll = h2(cellX * 83.1 + 2.9, cellZ * 29.7 - 6.5);
    if (roll > 0.55) {
      const rnd = mulberry32((Math.floor(roll * 1e9) ^ Math.imul(cellX, 1103515245) ^ Math.imul(cellZ, 12345)) | 0);
      const cx = cellX * SC_CELL + 70 + Math.floor(rnd() * (SC_CELL - 140));
      const cz = cellZ * SC_CELL + 70 + Math.floor(rnd() * (SC_CELL - 140));
      const ops = [], put = (x, y, z, t, m) => ops.push({ x, y, z, t, m });
      let gy = 0, ok = true;
      for (let dx = -9; dx <= 9; dx += 3) for (let dz = -9; dz <= 9; dz += 3) {
        const h = heightAt(cx + dx, cz + dz);
        if (gy === 0) gy = h;
        if (Math.abs(h - gy) > 3) ok = false;
        gy = Math.max(gy, h);
      }
      if (ok && gy > CFG.SEA + 2 && gy < 44 && !structNear(cx, cz, 'circle')) {
        const rr = 6 + Math.floor(rnd() * 3), n = 8 + Math.floor(rnd() * 4);
        for (let i = 0; i < n; i++) {
          const a = (i / n) * Math.PI * 2;
          const sx = Math.round(Math.cos(a) * rr), sz = Math.round(Math.sin(a) * rr);
          const hh = 2 + ((i * 7) % 3);
          const tile = i % 3 === 0 ? 30 : 26;                        // 花岗岩 / 立石
          for (let y = 1; y <= hh; y++) put(cx + sx, gy + y, cz + sz, tile);
        }
        put(cx, gy + 1, cz, 33);                                     // 中央祭台（石砖楼梯）
        out = { name: 'circle', cx, cz, gy, byChunk: packOps(ops), ops: ops.length, label: '石阵' };
      }
    }
    circleCache.set(key, out);
    return out;
  });
}

// 废墟营地
const CP_CELL = 224, campCache = new Map();
function campFor(cellX, cellZ) {
  const key = cellX + ',' + cellZ;
  if (campCache.has(key)) return campCache.get(key);
  return guarded('camp', key, () => {
    let out = null;
    const roll = h2(cellX * 43.3 - 8.1, cellZ * 67.7 + 3.3);
    if (roll > 0.55) {
      const rnd = mulberry32((Math.floor(roll * 1e9) ^ Math.imul(cellX, 971) ^ Math.imul(cellZ, 78233)) | 0);
      const cx = cellX * CP_CELL + 50 + Math.floor(rnd() * (CP_CELL - 100));
      const cz = cellZ * CP_CELL + 50 + Math.floor(rnd() * (CP_CELL - 100));
      const gy = heightAt(cx, cz);
      const ops = [], put = (x, y, z, t, m) => ops.push({ x, y, z, t, m }), carve = (x, y, z) => ops.push({ x, y, z, t: 0 });
      if (gy > CFG.SEA + 2 && gy < 44 && !structNear(cx, cz, 'camp')) {
        for (let dx = -4; dx <= 4; dx++) for (let dz = -4; dz <= 4; dz++) {
          if (Math.abs(dx) !== 4 && Math.abs(dz) !== 4) continue;
          if (((dx * 7 + dz * 13 + cellX * 3) % 5 + 5) % 5 === 0) continue;   // 塌口
          const hh = 1 + Math.abs((dx * 3 + dz * 5) % 2);
          for (let y = 1; y <= hh; y++) put(cx + dx, gy + y, cz + dz, 21);
        }
        for (let dz = -2; dz <= 2; dz++) { put(cx - 2, gy + 1, cz + dz, 29); put(cx + 2, gy + 1, cz + dz, 29); }
        put(cx - 1, gy + 2, cz, 29); put(cx + 1, gy + 2, cz, 29); put(cx, gy + 3, cz, 29);
        for (const p of [[0, 1], [1, 0], [0, -1], [-1, 0]]) put(cx + p[0], gy + 1, cz + p[1], 9);
        put(cx, gy + 1, cz + 3, 18);
        out = { name: 'camp', cx, cz, gy, byChunk: packOps(ops), ops: ops.length, label: '废墟营地' };
      }
    }
    campCache.set(key, out);
    return out;
  });
}

// 白桦木屋（带坡屋顶）
const CB_CELL = 200, cabinCache = new Map();
function cabinFor(cellX, cellZ) {
  const key = cellX + ',' + cellZ;
  if (cabinCache.has(key)) return cabinCache.get(key);
  return guarded('cabin', key, () => {
    let out = null;
    const roll = h2(cellX * 33.9 + 11.7, cellZ * 91.3 - 2.7);
    if (roll > 0.45) {
      const rnd = mulberry32((Math.floor(roll * 1e9) ^ Math.imul(cellX, 374761393) ^ Math.imul(cellZ, 668265263)) | 0);
      const cx = cellX * CB_CELL + 50 + Math.floor(rnd() * (CB_CELL - 100));
      const cz = cellZ * CB_CELL + 50 + Math.floor(rnd() * (CB_CELL - 100));
      const ops = [], put = (x, y, z, t, m) => ops.push({ x, y, z, t, m }), carve = (x, y, z) => ops.push({ x, y, z, t: 0 });
      const w = 3, d = 2, h = 3;
      let gy = 0;
      for (let dx = -w; dx <= w; dx++) for (let dz = -d; dz <= d; dz++) gy = Math.max(gy, heightAt(cx + dx, cz + dz));
      if (gy > CFG.SEA + 2 && gy < 42 && !structNear(cx, cz, 'cabin')) {
        for (let dx = -w; dx <= w; dx++) for (let dz = -d; dz <= d; dz++) {
          put(cx + dx, gy, cz + dz, 31);                             // 白桦木地板
          for (let y = 1; y <= h; y++) {
            const edge = Math.abs(dx) === w || Math.abs(dz) === d;
            if (edge) put(cx + dx, gy + y, cz + dz, 29);
            else carve(cx + dx, gy + y, cz + dz);
          }
        }
        for (let y = 1; y <= 2; y++) carve(cx, gy + y, cz + d);
        put(cx - w, gy + 2, cz, 22);
        put(cx + w, gy + 2, cz, 22);
        buildGableRoof(put, cx, cz, gy + h + 1, w + 1, d + 1, 31, 34);
        put(cx + 1, gy + 1, cz - 1, 18);
        out = { name: 'cabin', cx, cz, gy, byChunk: packOps(ops), ops: ops.length, label: '白桦木屋' };
      }
    }
    cabinCache.set(key, out);
    return out;
  });
}

function applyExtraStructs(b, ox, oz, selfKey) {
  for (const t of STRUCT_TYPES) {
    if (t.cell === VS_CELL || t.cell === HS_CELL) continue;          // 村庄/鬼屋走原来的路径
    const sx = Math.floor(ox / t.cell), sz = Math.floor(oz / t.cell);
    for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
      const st = t.get(sx + dx, sz + dz);
      if (!st) continue;
      const arr = st.byChunk.get(selfKey);
      if (!arr) continue;
      for (const op of arr) {
        if (op.x < ox || op.x >= ox + CFG.CH || op.z < oz || op.z >= oz + CFG.CH) continue;
        if (op.y < 1 || op.y >= CFG.WH) continue;
        const i = (op.y * CFG.CH + (op.z - oz)) * CFG.CH + (op.x - ox);
        if (op.t === 0) { if (b[i] !== 5) b[i] = 0; }
        else b[i] = op.t;
        if (op.m) setMeta(op.x, op.y, op.z, op.m, true);
      }
    }
  }
}
// 新结构范围内不长树
function inExtraStruct(wx, wz) {
  for (const t of STRUCT_TYPES) {
    if (t.cell === VS_CELL || t.cell === HS_CELL) continue;
    const cx = Math.floor(wx / t.cell), cz = Math.floor(wz / t.cell);
    for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
      const o = t.get(cx + dx, cz + dz);
      if (o && Math.abs(wx - o.cx) <= 9 && Math.abs(wz - o.cz) <= 9) return true;
    }
  }
  return false;
}

/* ============================================================ 村庄 */
// ── 废弃鬼屋：288 格一栋，三层大房子（石砖墙 + 玻璃窗 + 木板楼板 + 木柱）──
const HS_CELL = 288, HS_FLOORS = 3, HS_FH = 4;
const hsCache = new Map();
const bossSpawned = new Set();
function hauntedFor(cellX, cellZ) {
  const key = cellX + ',' + cellZ;
  if (hsCache.has(key)) return hsCache.get(key);
  let out = null;
  const roll = h2(cellX * 71.3 + 3.1, cellZ * 47.7 - 8.9);
  if (roll > 0.45) {
    const rnd = mulberry32((Math.floor(roll * 1e9) ^ Math.imul(cellX, 2654435761) ^ Math.imul(cellZ, 40503)) | 0);
    const cx = cellX * HS_CELL + 80 + Math.floor(rnd() * (HS_CELL - 160));
    const cz = cellZ * HS_CELL + 80 + Math.floor(rnd() * (HS_CELL - 160));
    const W = 8, D = 6;                       // 半宽 / 半深（17×13 的外墙）
    let gy = 0;
    for (let dx = -W - 1; dx <= W + 1; dx++) for (let dz = -D - 1; dz <= D + 1; dz++) gy = Math.max(gy, heightAt(cx + dx, cz + dz));
    if (gy > CFG.SEA + 4 && gy < 38) {
      const y0 = gy + 1;
      const ops = [];
      // m = 方块朝向（楼梯等非立方体用）：屋顶坡口会带 3/4，必须一起存下来
      const put = (x, y, z, t, m) => ops.push(m ? { x, y, z, t, m } : { x, y, z, t });
      const carve = (x, y, z) => ops.push({ x, y, z, t: 0 });
      // 地基：把低处填到 y0-1
      for (let dx = -W; dx <= W; dx++) for (let dz = -D; dz <= D; dz++) {
        for (let y = heightAt(cx + dx, cz + dz) + 1; y < y0; y++) put(cx + dx, y, cz + dz, 21);
      }
      for (let f = 0; f < HS_FLOORS; f++) {
        const fy = y0 + f * HS_FH;
        // 楼板（木板）
        for (let dx = -W; dx <= W; dx++) for (let dz = -D; dz <= D; dz++) put(cx + dx, fy, cz + dz, 8);
        // 楼梯井：楼板开 3×3 洞（在西南角）
        for (let dx = 0; dx < 3; dx++) for (let dz = 0; dz < 3; dz++) carve(cx - W + 1 + dx, fy, cz - D + 1 + dz);
        // 墙体：石砖，第 2 层高开玻璃窗
        for (let h = 1; h < HS_FH; h++) {
          const y = fy + h;
          for (let dx = -W; dx <= W; dx++) for (let dz = -D; dz <= D; dz++) {
            const edge = Math.abs(dx) === W || Math.abs(dz) === D;
            if (!edge) { carve(cx + dx, y, cz + dz); continue; }   // 内部空气
            const win = h === 2 && (dx + dz) % 5 === 0;
            put(cx + dx, y, cz + dz, win ? 22 : 21);
          }
        }
        // 四角木柱
        for (const [sx, sz] of [[-W, -D], [W, -D], [-W, D], [W, D]]) {
          for (let h = 1; h < HS_FH; h++) put(cx + sx, fy + h, cz + sz, 6);
        }
        // 楼梯：从楼梯井往西每格升 1（游戏能自动上 1 格台阶）
        for (let i = 1; i <= 3; i++) put(cx - W + 1 + i - 1, fy + i, cz - D + 1, 8);
        // 一层南墙开门（2 格高）
        if (f === 0) for (let h = 1; h <= 2; h++) for (let dz = -1; dz <= 1; dz++) carve(cx + dz, fy + h, cz + D);
      }
      // 屋顶：改成两坡石砖屋顶 + 楼梯屋檐（原来是一块平板）
      const topY = y0 + HS_FLOORS * HS_FH;
      buildGableRoof(put, cx, cz, topY, W + 1, D + 1, 21, 33);
      // 家具：每层两个箱子（战利品按坐标生成）
      put(cx - 2, y0 + 1, cz + 2, 18);
      put(cx + 3, y0 + 1, cz - 3, 18);
      put(cx + 2, y0 + HS_FH + 1, cz + 3, 18);
      put(cx - 3, y0 + 2 * HS_FH + 1, cz - 2, 18);
      const byChunk = new Map();
      for (const op of ops) {
        const k = (op.x >> 4) + ',' + (op.z >> 4);
        let arr = byChunk.get(k);
        if (!arr) byChunk.set(k, arr = []);
        arr.push(op);
      }
      out = { cellX, cellZ, cx, cz, y0, W, D, floors: HS_FLOORS, fh: HS_FH, byChunk, ops: ops.length,
              bossAt: { x: cx, y: y0 + (HS_FLOORS - 1) * HS_FH + 1, z: cz } };
    }
  }
  hsCache.set(key, out);
  return out;
}
function inHaunted(wx, wz) {
  const cx = Math.floor(wx / HS_CELL), cz = Math.floor(wz / HS_CELL);
  for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
    const hs = hauntedFor(cx + dx, cz + dz);
    if (!hs) continue;
    if (Math.abs(wx - hs.cx) <= hs.W + 2 && Math.abs(wz - hs.cz) <= hs.D + 2) return true;
  }
  return false;
}

const VS_CELL = 160;
const villageCache = new Map();


function buildHouse(put, carve, hx, hz, w, d, h, cx, cz, rnd) {
  const woodP = 8, log = 6, cobble = 9;
  // 先量出这块地的起伏：以最高点为室内地面，往下填、往上清 → 房子不会埋在山坡里
  let mn = 99, mx = -99;
  for (let dx = -w - 1; dx <= w + 1; dx++) for (let dz = -d - 1; dz <= d + 1; dz++) {
    const hh = heightAt(hx + dx, hz + dz);
    if (hh < mn) mn = hh;
    if (hh > mx) mx = hh;
  }
  const gy = mx;
  for (let dx = -w - 1; dx <= w + 1; dx++) for (let dz = -d - 1; dz <= d + 1; dz++) {
    for (let y = Math.max(1, mn - 1); y < gy; y++) put(hx + dx, y, hz + dz, cobble);   // 地基填到地面
    for (let y = gy + 1; y <= gy + h + 3; y++) carve(hx + dx, y, hz + dz);              // 清出空间（含屋顶上方）
  }
  for (let dx = -w; dx <= w; dx++) for (let dz = -d; dz <= d; dz++) put(hx + dx, gy, hz + dz, woodP);  // 地板
  for (let y = gy + 1; y <= gy + h; y++) {
    for (let dx = -w; dx <= w; dx++) { put(hx + dx, y, hz - d, woodP); put(hx + dx, y, hz + d, woodP); }
    for (let dz = -d; dz <= d; dz++) { put(hx - w, y, hz + dz, woodP); put(hx + w, y, hz + dz, woodP); }
  }
  for (const [sx, sz] of [[-w, -d], [w, -d], [-w, d], [w, d]])
    for (let y = gy + 1; y <= gy + h; y++) put(hx + sx, y, hz + sz, log);
  // 门：朝向村中心那一面开 2 高缺口
  if (Math.abs(cx - hx) > Math.abs(cz - hz)) {
    const sx = cx > hx ? 1 : -1;
    for (let y = gy + 1; y <= gy + 2; y++) carve(hx + sx * w, y, hz);
  } else {
    const sz = cz > hz ? 1 : -1;
    for (let y = gy + 1; y <= gy + 2; y++) carve(hx, y, hz + sz * d);
  }
  if (rnd() < 0.8) { carve(hx - w, gy + 2, hz + d - 1); carve(hx + w, gy + 2, hz - d + 1); }   // 窗
  buildGableRoof(put, hx, hz, gy + h + 1, w + 1, d + 1, woodP, 34);   // 两坡屋顶（原来是一块平顶）
  put(hx, gy + h + 2 + d, hz, log);
  const bx = hx + (rnd() < 0.5 ? -w + 1 : w - 1), bz = hz + (rnd() < 0.5 ? -d + 1 : d - 1);
  put(bx, gy + 1, bz, 18);                                                                    // 屋内箱子
  if (rnd() < 0.5) put(bx + (bx > hx ? -1 : 1), gy + 1, bz, 14, 7);                          // 有时放张床（7 = 床头，带枕头）
}

function buildFarm(put, carve, fx, fz, r, rnd) {
  // 农田也先量坡度，以最高点做田面，别让小麦挂在斜坡上
  let mn = 99, mx = -99;
  for (let dx = -r - 1; dx <= r + 1; dx++) for (let dz = -r - 1; dz <= r + 1; dz++) {
    const hh = heightAt(fx + dx, fz + dz);
    if (hh < mn) mn = hh;
    if (hh > mx) mx = hh;
  }
  const gy = mx;
  for (let dx = -r; dx <= r; dx++) for (let dz = -r; dz <= r; dz++) {
    const x = fx + dx, z = fz + dz;
    for (let y = Math.max(1, mn - 1); y < gy; y++) put(x, y, z, 9);
    put(x, gy, z, 16);            // 农田
    const st = ((x * 7 + z * 13) % 10 + 10) % 10;
    put(x, gy + 1, z, st < 4 ? 17 : st < 7 ? 24 : 23);   // 成熟 / 半熟 / 幼苗混着长
    carve(x, gy + 2, z);
  }
  put(fx - r, gy + 1, fz - r, 25);                        // 田角放一个堆肥箱
  for (let dx = -r - 1; dx <= r + 1; dx++) for (let dz = -r - 1; dz <= r + 1; dz++) {
    if (Math.abs(dx) !== r + 1 && Math.abs(dz) !== r + 1) continue;
    if (dz === r + 1 && dx === 0) continue;                 // 留个进出口
    put(fx + dx, gy, fz + dz, 8);
    put(fx + dx, gy + 1, fz + dz, 8);
  }
}

function villageFor(cellX, cellZ) {
  const key = cellX + ',' + cellZ;
  if (villageCache.has(key)) return villageCache.get(key);
  let out = null;
  const roll = h2(cellX * 91.7 + 13.3, cellZ * 57.1 - 21.9);
  if (roll > 0.3) {                                        // 70% 的格子有村庄
    const rnd = mulberry32((Math.floor(roll * 1e9) ^ Math.imul(cellX, 83492791) ^ Math.imul(cellZ, 427131)) | 0);
    const cx = cellX * VS_CELL + 44 + Math.floor(rnd() * (VS_CELL - 88));
    const cz = cellZ * VS_CELL + 44 + Math.floor(rnd() * (VS_CELL - 88));
    const gy = heightAt(cx, cz);
    if (gy > CFG.SEA + 3 && gy < 42) {                     // 不在水下、不在山顶
      const ops = [];
      // m = 方块朝向（楼梯等非立方体用）：屋顶坡口会带 3/4，必须一起存下来
      const put = (x, y, z, t, m) => ops.push(m ? { x, y, z, t, m } : { x, y, z, t });
      const carve = (x, y, z) => ops.push({ x, y, z, t: 0 });
      const houses = 3 + Math.floor(rnd() * 3);
      for (let i = 0; i < houses; i++) {
        const ang0 = (i / houses) * Math.PI * 2 + rnd() * 0.6;
        const w = 2 + Math.floor(rnd() * 2), d = 2 + Math.floor(rnd() * 2);
        // 在给定方位附近试 4 个点，挑最平的一块地盖房
        let best = null, bestVar = 99;
        for (let k = 0; k < 4; k++) {
          const ang = ang0 + (k ? (rnd() - 0.5) * 0.5 : 0);
          const rad = 9 + Math.floor(rnd() * 10);
          const hx = cx + Math.round(Math.cos(ang) * rad);
          const hz = cz + Math.round(Math.sin(ang) * rad);
          let mn = 99, mx = -99;
          for (let dx = -w - 1; dx <= w + 1; dx++) for (let dz = -d - 1; dz <= d + 1; dz++) {
            const hh = heightAt(hx + dx, hz + dz);
            if (hh < mn) mn = hh;
            if (hh > mx) mx = hh;
          }
          if (mx - mn < bestVar) { bestVar = mx - mn; best = { hx, hz }; }
        }
        if (best) buildHouse(put, carve, best.hx, best.hz, w, d, 3 + Math.floor(rnd() * 2), cx, cz, rnd);
      }
      const farms = 1 + Math.floor(rnd() * 2);
      for (let i = 0; i < farms; i++) {
        const ang = rnd() * Math.PI * 2, rad = 4 + rnd() * 10;
        buildFarm(put, carve, Math.round(cx + Math.cos(ang) * rad), Math.round(cz + Math.sin(ang) * rad), 2 + Math.floor(rnd() * 2), rnd);
      }
      // 村中心：圆石台 + 箱子
      for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) put(cx + dx, gy, cz + dz, 9);
      put(cx, gy + 1, cz, 18);
      const byChunk = new Map();
      for (const op of ops) {
        const k2 = (op.x >> 4) + ',' + (op.z >> 4);
        let arr = byChunk.get(k2);
        if (!arr) byChunk.set(k2, arr = []);
        arr.push(op);
      }
      let minX = 1e9, maxX = -1e9, minZ = 1e9, maxZ = -1e9;
      for (const op of ops) {
        if (op.x < minX) minX = op.x;
        if (op.x > maxX) maxX = op.x;
        if (op.z < minZ) minZ = op.z;
        if (op.z > maxZ) maxZ = op.z;
      }
      out = { cellX, cellZ, cx, cz, gy, houses, ops: ops.length, byChunk, minX, maxX, minZ, maxZ };
    }
  }
  villageCache.set(key, out);
  return out;
}

// 这个坐标是否落在村庄范围内（含 3 格余量，防止树冠压到房子上）
function inVillage(wx, wz) {
  const cellX = Math.floor(wx / VS_CELL), cellZ = Math.floor(wz / VS_CELL);
  for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
    const v = villageFor(cellX + dx, cellZ + dz);
    if (!v) continue;
    if (wx >= v.minX - 3 && wx <= v.maxX + 3 && wz >= v.minZ - 3 && wz <= v.maxZ + 3) return true;
  }
  return false;
}

function nearestVillage(maxDist = 140) {
  const pcx = Math.floor(player.p.x / VS_CELL), pcz = Math.floor(player.p.z / VS_CELL);
  let best = null, bestD = maxDist * maxDist;
  for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
    const v = villageFor(pcx + dx, pcz + dz);
    if (!v) continue;
    const d = (v.cx - player.p.x) ** 2 + (v.cz - player.p.z) ** 2;
    if (d < bestD) { bestD = d; best = v; }
  }
  return best;
}

// 箱子：真正的容器（27 格），第一次打开时按坐标哈希生成战利品，之后内容持久化
const CHEST_TABLE = [[105, 1, 3], [107, 1, 3], [8, 3, 6], [104, 2, 5], [13, 2, 5], [106, 1, 2], [9, 2, 4], [17, 1, 3]];
const CHEST_SLOTS = 27;
const chestInv = new Map();          // "x,y,z" -> 27 格内容
function chestSlots(x, y, z) {
  const k = x + ',' + y + ',' + z;
  let slots = chestInv.get(k);
  if (!slots) {
    slots = new Array(CHEST_SLOTS).fill(null);
    const rnd = mulberry32((Math.imul(x, 73856093) ^ Math.imul(y, 19349663) ^ Math.imul(z, 83492791) ^ SEED) | 0);
    const picks = 2 + Math.floor(rnd() * 4);
    for (let i = 0; i < picks; i++) {
      const [id, a, b] = CHEST_TABLE[Math.floor(rnd() * CHEST_TABLE.length)];
      const n = a + Math.floor(rnd() * (b - a + 1));
      let idx = Math.floor(rnd() * CHEST_SLOTS), guard = 0;
      while (slots[idx] && guard++ < CHEST_SLOTS) idx = (idx + 1) % CHEST_SLOTS;
      slots[idx] = { id, n };
    }
    chestInv.set(k, slots);
  }
  return slots;
}
let openChestPos = null, cursor = null;          // cursor = 手上正在搬运的那一堆
function openChest(x, y, z) {
  if (panelOpen) openPanel(false);           // 两个界面不要叠在一起
  openChestPos = { x, y, z };
  chestSlots(x, y, z);
  $('chestPanel').classList.remove('hide');
  renderChest();
  sfx('craft');
  return true;
}
function closeChest() {
  if (cursor) {                                    // 关界面时手上的东西塞回背包/箱子
    if (!addItem(cursor.id, cursor.n)) { toast('背包满了，物品掉在脚下', 1.6); spawnDrop(cursor.id, cursor.n, player.p.x, player.p.y + 1, player.p.z); }
    cursor = null;
  }
  openChestPos = null;
  $('chestPanel').classList.add('hide');
  renderHotbar(); refreshHeld(); saveSoon();
}
function afterSlotChange() {
  renderHotbar(); refreshHeld();
  if (openChestPos) renderChest();
  if (panelOpen) renderInventoryPanel();
  saveSoon();
}
// 点一下拿起，再点一下放下 / 合并 / 交换 —— 背包和箱子共用这套逻辑
function slotClick(arr, i) {
  const cur = arr[i];
  if (!cursor) {
    if (cur) { cursor = cur; arr[i] = null; }
    else return;
  } else if (!cur) {
    arr[i] = cursor; cursor = null;
  } else if (cur.id === cursor.id) {
    const total = cur.n + cursor.n;
    if (total <= STACK_MAX) { cur.n = total; cursor = null; }
    else { cur.n = STACK_MAX; cursor = { id: cursor.id, n: total - STACK_MAX }; }
  } else {
    arr[i] = cursor; cursor = cur;
  }
  afterSlotChange();
}
function renderGrid(el, arr, handler) {
  if (!el) return;
  el.innerHTML = '';
  for (let i = 0; i < arr.length; i++) {
    const s = arr[i];
    const d = document.createElement('div');
    d.className = 'cell';
    if (s) {
      d.innerHTML = `<img src="${iconURL(s.id)}" alt=""><span class="n">${s.n > 1 ? s.n : ''}</span>`;
      d.title = nameOf(s.id);
    }
    d.onclick = () => handler(i);
    el.appendChild(d);
  }
}
function cursorText() { return cursor ? `手上：${nameOf(cursor.id)} ×${cursor.n}` : '手上：空（点物品拿起，再点另一格放下/交换）'; }
function renderChest() {
  if (!openChestPos) return;
  const cs = chestSlots(openChestPos.x, openChestPos.y, openChestPos.z);
  renderGrid($('chestGrid'), cs, i => slotClick(cs, i));
  renderGrid($('chestInvGrid'), inv, i => slotClick(inv, i));
  const t = cursorText();
  if ($('chestHint')) $('chestHint').textContent = t;
  if ($('cursorInfo')) $('cursorInfo').textContent = t;
}

/* ============================================================ 生物 */
let MINE_PIN = null;
const mobs = [];
const MOB_DEATH_HOLD = 5, MOB_DEATH_FADE = 1.1;
const MOB_DEFS = {
  grunt:    { name: '夜行怪', hp: 20, chase: 2.9, wander: 1.2, hostile: true,  barY: 1.44, drop: null, dmg: 3, atkCd: 1.6, sunBurn: true },
  pig:      { name: '猪',     hp: 10, chase: 2.4, wander: 1.0, hostile: false, barY: 1.0,  drop: 108 },
  villager: { name: '村民',   hp: 20, chase: 1.9, wander: 0.9, hostile: false, barY: 1.85, drop: null },
  cow:      { name: '牛',     hp: 24, chase: 2.3, wander: 0.85, hostile: false, barY: 1.45, drop: 140, dropN: [1, 2] },
  sheep:    { name: '羊',     hp: 18, chase: 2.5, wander: 0.95, hostile: false, barY: 1.15, drop: 142, dropN: [1, 2] },
  chicken:  { name: '鸡',     hp: 8,  chase: 2.8, wander: 0.8,  hostile: false, barY: 0.75, drop: 143, dropN: [1, 1] },
  spider:   { name: '蜘蛛',   hp: 22, chase: 4.0, wander: 1.4,  hostile: true,  barY: 0.9,  drop: null, dmg: 2.5, atkCd: 1.25 },
  skeleton: { name: '骷髅射手', hp: 20, chase: 2.4, wander: 1.0, hostile: true,  barY: 1.6,  drop: 148, dropN: [1, 2], dmg: 3, atkCd: 1.5, ranged: true, sunBurn: true },
  ghost:    { name: '幽灵',   hp: 18, chase: 2.2, wander: 0.9, hostile: true,  barY: 1.7,  drop: 155, dropN: [1, 1], dmg: 2.5, atkCd: 1.4, float: true, ghostly: true },
  ghostBoss:{ name: '幽灵王', hp: 140, chase: 2.9, wander: 1.2, hostile: true, barY: 3.1,  drop: 155, dropN: [3, 5], dmg: 6, atkCd: 1.15, float: true, ghostly: true, boss: true },
};
const aliveMobs = () => mobs.filter(m => !m.dying).length;
const countKind = k => mobs.filter(m => !m.dying && m.kind === k).length;

/* ── 像素生物 ────────────────────────────────────────────────────────────────
   整只怪由 1/16 方块大小的「像素」小立方体拼成：每格一个颜色、内部面剔除，
   表面因此是硬边像素块（和世界方块同一网格感），而不是平滑的塑料盒子。
   几何按种类缓存后所有个体共用，出生/死亡不重新拼装。 */
const MOB_PX = 1 / 16;
const mobGeoCache = new Map();

function pixHash(x, y, z, k) {
  let n = Math.imul(x + 37, 374761393) ^ Math.imul(y + 11, 668265263) ^ Math.imul(z + k * 97, 1013904223);
  n = Math.imul(n ^ (n >>> 13), 1274126177);
  return ((n ^ (n >>> 16)) >>> 0) / 4294967296;
}
function tintHex(hex, f) {
  const r = Math.min(255, Math.max(0, Math.round(((hex >> 16) & 255) * f)));
  const g = Math.min(255, Math.max(0, Math.round(((hex >> 8) & 255) * f)));
  const b = Math.min(255, Math.max(0, Math.round((hex & 255) * f)));
  return (r << 16) | (g << 8) | b;
}
// "x,y,z"→颜色 的像素表 → 只含外壳面的 BufferGeometry（相邻像素之间的面不生成）
function voxGeometry(vox) {
  const FACES = [
    { n: [1, 0, 0], v: [[1, 0, 0], [1, 1, 0], [1, 1, 1], [1, 0, 1]] },
    { n: [-1, 0, 0], v: [[0, 0, 1], [0, 1, 1], [0, 1, 0], [0, 0, 0]] },
    { n: [0, 1, 0], v: [[0, 1, 0], [0, 1, 1], [1, 1, 1], [1, 1, 0]] },
    { n: [0, -1, 0], v: [[0, 0, 0], [1, 0, 0], [1, 0, 1], [0, 0, 1]] },
    { n: [0, 0, 1], v: [[0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]] },
    { n: [0, 0, -1], v: [[1, 0, 0], [0, 0, 0], [0, 1, 0], [1, 1, 0]] },
  ];
  const pos = [], col = [], c = new THREE.Color();
  for (const [k, hex] of vox) {
    const [x, y, z] = k.split(',').map(Number);
    c.setHex(hex);
    for (const f of FACES) {
      if (vox.has((x + f.n[0]) + ',' + (y + f.n[1]) + ',' + (z + f.n[2]))) continue;
      for (const i of [0, 1, 2, 0, 2, 3]) {
        const o = f.v[i];
        pos.push((x + o[0]) * MOB_PX, (y + o[1]) * MOB_PX, (z + o[2]) * MOB_PX);
        col.push(c.r, c.g, c.b);
      }
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  geo.computeVertexNormals();
  geo.userData.shared = true;
  return geo;
}

// 每种生物的像素模型（脚在 y=0、单位=像素；jitter 给表面加轻微色差 → 像素颗粒感）
function mobGeos(kind) {
  if (mobGeoCache.has(kind)) return mobGeoCache.get(kind);
  const body = new Map(), head = new Map();
  const K = (x, y, z) => x + ',' + y + ',' + z;
  const box = (map, x0, y0, z0, w, h, d, hex, jitter = 0.12) => {
    for (let x = x0; x < x0 + w; x++) for (let y = y0; y < y0 + h; y++) for (let z = z0; z < z0 + d; z++)
      map.set(K(x, y, z), tintHex(hex, 1 + (pixHash(x, y, z, map === head ? 7 : 3) - 0.5) * jitter));
  };
  const px = (map, x, y, z, hex) => map.set(K(x, y, z), hex);
  let coreY = 0.62, barY = 1.44, limbSpecs = [];

  if (kind === 'pig') {
    coreY = 0.46; barY = 1.0;
    const PINK = 0xefa0a0, PINK2 = 0xf7b4b4, SNOUT = 0xd98c8c, EYE = 0x1d1010;
    box(body, -5, 4, -8, 10, 8, 16, PINK, 0.10);          // 躯干
    box(body, -5, 4, -8, 10, 2, 16, 0xd98c8c, 0.07);      // 肚皮暗一档
    box(body, -3, 11, -8, 6, 1, 15, 0xf7bcbc, 0.05);      // 背脊亮条
    box(body, -1, 11, -9, 2, 2, 1, SNOUT, 0.05);          // 尾巴
    box(head, -4, 5, 8, 8, 8, 8, PINK2, 0.10);            // 头
    box(head, -2, 7, 16, 4, 3, 1, SNOUT, 0.05);           // 猪鼻
    px(head, -1, 8, 16, 0xb87373); px(head, 0, 8, 16, 0xb87373);   // 鼻孔
    px(head, -3, 10, 15, EYE); px(head, -3, 11, 15, EYE);
    px(head, 2, 10, 15, EYE); px(head, 3, 11, 15, EYE);
    box(head, -4, 13, 9, 2, 1, 2, 0xd98f8f, 0.05);        // 耳朵
    box(head, 2, 13, 9, 2, 1, 2, 0xd98f8f, 0.05);
    const legGeo = (() => { const m = new Map(); box(m, -1, -4, -1, 2, 4, 3, 0xd88888, 0.12); return voxGeometry(m); })();
    limbSpecs = [
      { geo: legGeo, x: -3, y: 4, z: 6, arm: true }, { geo: legGeo, x: 3, y: 4, z: 6, arm: true },
      { geo: legGeo, x: -3, y: 4, z: -6, arm: false }, { geo: legGeo, x: 3, y: 4, z: -6, arm: false },
    ];
  } else if (kind === 'villager') {
    coreY = 0.82; barY = 1.85;
    const ROBE = 0x6b5334, ROBE2 = 0x54402a, SKIN = 0xc9a37b, HAIR = 0x3b2a18, EYE = 0x24180f;
    box(body, -4, 7, -3, 8, 12, 6, ROBE, 0.10);           // 长袍
    box(body, -4, 7, -3, 8, 2, 6, ROBE2, 0.07);           // 下摆
    box(body, -4, 15, -3, 8, 1, 6, ROBE2, 0.05);          // 腰带
    box(head, -4, 19, -3, 8, 8, 6, SKIN, 0.09);           // 头
    box(head, -4, 25, -3, 8, 2, 6, HAIR, 0.07);           // 头发/帽檐
    px(head, -3, 23, 2, EYE); px(head, -2, 23, 2, EYE);
    px(head, 2, 23, 2, EYE); px(head, 3, 23, 2, EYE);
    box(head, -1, 20, 3, 2, 3, 2, 0xb98f68, 0.04);        // 大鼻子
    const armGeo = (() => { const m = new Map(); box(m, -1, -9, -1, 3, 9, 3, ROBE, 0.10); px(m, -1, -1, 1, SKIN); px(m, 0, -1, 1, SKIN); px(m, 1, -1, 1, SKIN); return voxGeometry(m); })();
    const legGeo = (() => { const m = new Map(); box(m, -1, -7, -1, 3, 7, 3, 0x3d2f1d, 0.10); return voxGeometry(m); })();
    limbSpecs = [
      { geo: armGeo, x: -5, y: 18, z: 0, arm: true }, { geo: armGeo, x: 5, y: 18, z: 0, arm: true },
      { geo: legGeo, x: -2, y: 7, z: 0, arm: false }, { geo: legGeo, x: 2, y: 7, z: 0, arm: false },
    ];
  } else if (kind === 'cow') {
    coreY = 0.62; barY = 1.45;
    const HIDE = 0x3a2b24, PATCH = 0xe8e2d6, HORN = 0xd8cbb0, SNOUT = 0xc9a29a;
    box(body, -6, 8, -10, 12, 10, 20, HIDE, 0.10);        // 躯干
    box(body, -6, 12, -6, 12, 5, 6, PATCH, 0.07);         // 白色花斑
    box(body, -6, 9, 3, 12, 4, 4, PATCH, 0.07);
    box(body, 2, 13, -9, 4, 4, 4, PATCH, 0.07);
    box(head, -4, 10, 10, 8, 8, 8, HIDE, 0.09);           // 头
    box(head, -3, 8, 17, 6, 4, 2, SNOUT, 0.06);           // 口鼻
    px(head, -1, 9, 18, 0x8a6a63); px(head, 1, 9, 18, 0x8a6a63);
    px(head, -4, 14, 14, 0x120c0a); px(head, 3, 14, 14, 0x120c0a);
    box(head, -5, 17, 11, 2, 2, 2, HORN, 0.04);           // 角
    box(head, 3, 17, 11, 2, 2, 2, HORN, 0.04);
    box(head, -6, 13, 12, 1, 3, 2, HIDE, 0.05);           // 耳朵
    box(head, 5, 13, 12, 1, 3, 2, HIDE, 0.05);
    const cowLeg = (() => { const m = new Map(); box(m, -1, -8, -1, 2, 8, 2, 0x33251f, 0.10); return voxGeometry(m); })();
    limbSpecs = [
      { geo: cowLeg, x: -4, y: 8, z: 6, arm: true }, { geo: cowLeg, x: 4, y: 8, z: 6, arm: true },
      { geo: cowLeg, x: -4, y: 8, z: -6, arm: false }, { geo: cowLeg, x: 4, y: 8, z: -6, arm: false },
    ];
  } else if (kind === 'sheep') {
    coreY = 0.55; barY = 1.15;
    const WOOL = 0xf2efe6, FACE = 0xd6c6b0, HOOF = 0x2b2622;
    box(body, -6, 5, -8, 12, 10, 16, WOOL, 0.18);         // 蓬松羊毛
    box(head, -3, 7, 8, 6, 7, 6, FACE, 0.08);             // 脸
    box(head, -4, 12, 7, 8, 3, 5, WOOL, 0.14);            // 头顶羊毛
    px(head, -2, 11, 13, 0x1a1512); px(head, 1, 11, 13, 0x1a1512);
    px(head, -1, 9, 13, 0xc9a89a);
    const sheepLeg = (() => { const m = new Map(); box(m, -1, -5, -1, 2, 5, 2, HOOF, 0.10); return voxGeometry(m); })();
    limbSpecs = [
      { geo: sheepLeg, x: -4, y: 5, z: 5, arm: true }, { geo: sheepLeg, x: 4, y: 5, z: 5, arm: true },
      { geo: sheepLeg, x: -4, y: 5, z: -5, arm: false }, { geo: sheepLeg, x: 4, y: 5, z: -5, arm: false },
    ];
  } else if (kind === 'chicken') {
    coreY = 0.30; barY = 0.72;
    const FEATHER = 0xf4f2ea, BEAK = 0xe0a33c, COMB = 0xd8402f;
    box(body, -3, 4, -4, 6, 6, 8, FEATHER, 0.10);         // 身体
    box(body, -4, 6, -2, 1, 3, 6, 0xe6e2d6, 0.08);        // 翅膀
    box(body, 3, 6, -2, 1, 3, 6, 0xe6e2d6, 0.08);
    box(head, -2, 9, 4, 5, 5, 5, FEATHER, 0.08);          // 头
    px(head, -2, 11, 8, BEAK); px(head, -1, 11, 8, BEAK); // 喙
    box(head, -1, 14, 5, 3, 1, 2, COMB, 0.05);            // 鸡冠
    px(head, 2, 12, 8, 0x241a12); px(head, -2, 12, 8, 0x241a12);
    const birdLeg = (() => { const m = new Map(); box(m, 0, -4, 0, 1, 4, 1, BEAK, 0.05); return voxGeometry(m); })();
    limbSpecs = [
      { geo: birdLeg, x: -1, y: 4, z: 0, arm: true }, { geo: birdLeg, x: 2, y: 4, z: 0, arm: false },
    ];
  } else if (kind === 'spider') {
    coreY = 0.42; barY = 0.92;
    const CH = 0x2a2430, CH2 = 0x1c1822, EYE = 0xd23c3c;
    box(body, -4, 4, -6, 8, 6, 12, CH, 0.12);             // 头胸
    box(body, -6, 5, -8, 12, 5, 6, CH2, 0.10);            // 后腹
    box(head, -3, 5, 6, 6, 5, 5, CH, 0.10);               // 头
    px(head, -2, 8, 10, EYE); px(head, -1, 8, 10, EYE); px(head, 1, 8, 10, EYE); px(head, 2, 8, 10, EYE);
    const spLeg = (() => { const m = new Map(); box(m, 0, -1, 0, 7, 1, 1, CH2, 0.08); return voxGeometry(m); })();
    limbSpecs = [
      { geo: spLeg, x: -4, y: 8, z: 4, arm: true }, { geo: spLeg, x: 4, y: 8, z: 4, arm: true },
      { geo: spLeg, x: -4, y: 8, z: 0, arm: false }, { geo: spLeg, x: 4, y: 8, z: 0, arm: false },
    ];
  } else if (kind === 'skeleton') {
    coreY = 0.66; barY: 0; barY = 1.55;
    const BONE = 0xe8e4d6, BONE2 = 0xc9c4b2, SOCKET = 0x1e1a16;
    box(body, -3, 8, -1, 6, 8, 3, BONE, 0.10);            // 胸腔
    box(body, -2, 11, 2, 4, 1, 1, BONE2, 0.05);           // 肋骨阴影
    box(head, -3, 16, -3, 7, 7, 7, BONE, 0.09);           // 头骨
    px(head, -2, 20, 4, SOCKET); px(head, -1, 20, 4, SOCKET);
    px(head, 2, 20, 4, SOCKET); px(head, 3, 20, 4, SOCKET);
    box(head, -1, 17, 4, 3, 1, 1, BONE2, 0.04);           // 牙
    const skArm = (() => { const m = new Map(); box(m, -1, -8, -1, 2, 8, 2, BONE, 0.09); return voxGeometry(m); })();
    const skLeg = (() => { const m = new Map(); box(m, -1, -8, -1, 2, 8, 2, BONE2, 0.09); return voxGeometry(m); })();
    limbSpecs = [
      { geo: skArm, x: -4, y: 16, z: 0, arm: true }, { geo: skArm, x: 4, y: 16, z: 0, arm: true },
      { geo: skLeg, x: -2, y: 8, z: 0, arm: false }, { geo: skLeg, x: 2, y: 8, z: 0, arm: false },
    ];
  } else if (kind === 'ghost' || kind === 'ghostBoss') {
    const boss = kind === 'ghostBoss';
    const S2 = boss ? 2 : 1;                                 // Boss 整体放大一倍
    coreY = 0.75 * S2; barY = boss ? 3.05 : 1.62;
    const SHEET = boss ? 0xd8c8f0 : 0xe6eef7, DARK = boss ? 0x8f6fc0 : 0xa8bccc, EYE = boss ? 0xff5a8a : 0x2a2b3a;
    box(body, -3 * S2, 6 * S2, -2 * S2, 7 * S2, 10 * S2, 3 * S2, SHEET, 0.14);   // 主体
    box(body, -4 * S2, 8 * S2, -1 * S2, 9 * S2, 4 * S2, 2 * S2, SHEET, 0.12);    // 伸出的手臂
    // 下摆做成一缕一缕的（幽灵感）
    for (let i = -3; i <= 3; i += 2) {
      const len = 2 + ((i * 7 + 5) % 3);
      box(body, i * S2, (6 - len) * S2, -2 * S2, 1 * S2, len * S2, 2 * S2, DARK, 0.12);
    }
    box(head, -3 * S2, 14 * S2, -2 * S2, 7 * S2, 6 * S2, 3 * S2, SHEET, 0.10);   // 头
    px(head, -2 * S2, 17 * S2, 1 * S2, EYE); px(head, -1 * S2, 17 * S2, 1 * S2, EYE);
    px(head, 1 * S2, 17 * S2, 1 * S2, EYE); px(head, 2 * S2, 17 * S2, 1 * S2, EYE);
    box(head, -1 * S2, 15 * S2, 1 * S2, 3 * S2, 1 * S2, 1 * S2, 0x3a3550, 0.06);  // 嘴
    limbSpecs = [];
  } else {                                                // grunt 夜行怪
    coreY = 0.62; barY = 1.44;
    const BODY = 0x2f5d5a, BODY2 = 0x264a48, HEAD = 0x9fd8c8, EYE = 0xff4d4d, TEETH = 0xe8f4ef;
    box(body, -4, 7, -2, 8, 9, 4, BODY, 0.13);            // 躯干
    box(body, -3, 9, 1, 6, 5, 1, BODY2, 0.09);            // 胸口暗块
    box(body, -4, 7, -2, 8, 1, 4, 0x1f3d3c, 0.05);        // 腰带
    box(head, -4, 16, -4, 8, 8, 8, HEAD, 0.09);           // 头
    box(head, -4, 22, -4, 8, 2, 8, 0x82c3b2, 0.07);       // 头顶暗一档
    px(head, -3, 19, 3, EYE); px(head, -2, 19, 3, EYE);
    px(head, 2, 19, 3, EYE); px(head, 3, 19, 3, EYE);
    box(head, -2, 17, 3, 4, 1, 1, TEETH, 0.03);           // 牙
    const armGeo = (() => { const m = new Map(); box(m, -1, -9, -1, 3, 9, 3, BODY, 0.13); box(m, -1, -9, -1, 3, 2, 3, BODY2, 0.07); return voxGeometry(m); })();
    const legGeo = (() => { const m = new Map(); box(m, -1, -7, -1, 3, 7, 3, BODY2, 0.12); return voxGeometry(m); })();
    limbSpecs = [
      { geo: armGeo, x: -5, y: 16, z: 0, arm: true }, { geo: armGeo, x: 5, y: 16, z: 0, arm: true },
      { geo: legGeo, x: -2, y: 7, z: 0, arm: false }, { geo: legGeo, x: 2, y: 7, z: 0, arm: false },
    ];
  }

  const geo = { body: voxGeometry(body), head: voxGeometry(head), coreY, barY, limbs: limbSpecs };
  mobGeoCache.set(kind, geo);
  return geo;
}

// 每种生物一个模型实例（几何共享）；core 代表"身体中心"，倒地时绕它旋转才不会插进地里
function makeMobModel(kind) {
  const G = mobGeos(kind);
  const g = new THREE.Group();
  const core = new THREE.Group();
  core.position.y = G.coreY;
  const ghostly = !!(MOB_DEFS[kind] && MOB_DEFS[kind].ghostly);
  const matOpts = { vertexColors: true, transparent: ghostly, opacity: ghostly ? 0.72 : 1 };
  const bodyMat = new THREE.MeshLambertMaterial(matOpts);
  const headMat = new THREE.MeshLambertMaterial(matOpts);
  const bodyMesh = new THREE.Mesh(G.body, bodyMat); bodyMesh.position.y = -G.coreY;
  const headMesh = new THREE.Mesh(G.head, headMat); headMesh.position.y = -G.coreY;
  core.add(bodyMesh, headMesh);
  const limbs = [];
  for (const L of G.limbs) {
    const mesh = new THREE.Mesh(L.geo, bodyMat);
    mesh.position.set(L.x * MOB_PX, L.y * MOB_PX - G.coreY, L.z * MOB_PX);
    core.add(mesh); limbs.push(mesh);
  }
  g.add(core);
  const barBg = new THREE.Mesh(new THREE.PlaneGeometry(0.8, 0.11), new THREE.MeshBasicMaterial({ color: 0x140c0c }));
  const barFg = new THREE.Mesh(new THREE.PlaneGeometry(0.72, 0.055), new THREE.MeshBasicMaterial({ color: 0x7fe06b }));
  barFg.position.set(0, 0, 0.004);
  const bar = new THREE.Group();
  bar.position.y = G.barY;
  bar.add(barBg, barFg);
  g.add(bar);
  const arms = limbs.filter((m, i) => G.limbs[i].arm);
  return { g, core, coreY: G.coreY, bodyMat, headMat, arm1: arms[0] || null, arm2: arms[1] || null, bar, barFg, limbs };
}

function spawnMobAt(kind, x, y, z, opts = {}) {
  const def = MOB_DEFS[kind];
  if (!def) return null;
  if (getBlock(x, y, z) !== 0 || getBlock(x, y + 1, z) !== 0) return null;
  const parts = makeMobModel(kind);
  const m = {
    kind, p: new THREE.Vector3(x + 0.5, y + 0.02, z + 0.5), v: new THREE.Vector3(),
    hp: def.hp, maxHp: def.hp, onGround: false, atkCd: 0, phase: Math.random() * 9,
    wander: 0, dir: new THREE.Vector2(), flash: 0, aggro: 0,
    dying: false, dieT: 0, stepUp: true, flee: 0,
    home: opts.home || null,
    obj: parts.g, parts,
  };
  m.obj.position.copy(m.p);
  scene.add(m.obj);
  mobs.push(m);
  return m;
}

// ── 刷怪点 ──
function findSpawnSpot() {                        // 夜行怪：只找黑暗空腔
  const okSpot = (x, y, z) =>
    getBlock(x, y, z) === 0 && getBlock(x, y + 1, z) === 0 &&
    isSolid(getBlock(x, y - 1, z)) && isDarkAt(x, y, z);
  for (let t = 0; t < 14; t++) {
    const ang = Math.random() * Math.PI * 2, dist = 8 + Math.random() * 14;
    const x = Math.floor(player.p.x + Math.cos(ang) * dist);
    const z = Math.floor(player.p.z + Math.sin(ang) * dist);
    if (Math.random() < 0.75) {
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
function findGrassSpot() {                        // 猪：露天的草地上
  for (let t = 0; t < 12; t++) {
    const ang = Math.random() * Math.PI * 2, dist = 10 + Math.random() * 20;
    const x = Math.floor(player.p.x + Math.cos(ang) * dist);
    const z = Math.floor(player.p.z + Math.sin(ang) * dist);
    const y = surfaceY(x, z) + 1;
    if (getBlock(x, y - 1, z) !== 1) continue;     // 脚下是草地
    if (getBlock(x, y, z) !== 0 || getBlock(x, y + 1, z) !== 0) continue;
    return { x, y, z };
  }
  return null;
}
function spawnMob(kind = 'grunt', offset) {
  const mdef = MOB_DEFS[kind];
  if (!offset && mdef) {
    const s = mdef.hostile ? findSpawnSpot() : findGrassSpot();
    return s ? spawnMobAt(kind, s.x, s.y, s.z) : null;
  }
  if (offset) {
    const x = Math.floor(player.p.x + offset[0]);
    const z = Math.floor(player.p.z + offset[1]);
    return spawnMobAt(kind, x, surfaceY(x, z) + 1, z);
  }
  return null;
}

// ── 骷髅的箭 ──
const arrows = [];
function sightClear(from, to) {                       // 两点之间有没有固体方块挡着
  const a = new THREE.Vector3(from.x, from.y + 1.2, from.z);
  const b = new THREE.Vector3(to.x, to.y + 1.1, to.z);
  const d = b.clone().sub(a);
  const len = d.length();
  d.divideScalar(len || 1);
  for (let t = 0.6; t < len; t += 0.45) {
    const x = Math.floor(a.x + d.x * t), y = Math.floor(a.y + d.y * t), z = Math.floor(a.z + d.z * t);
    if (isSolid(getBlock(x, y, z))) return false;
  }
  return true;
}
// 箭的独立模型：木杆 + 铁箭头 + 两片白色尾羽
let arrowGeoCache = null;
function makeArrowModel() {
  if (!arrowGeoCache) {
    const shaftG = new THREE.BoxGeometry(0.032, 0.032, 0.6);
    const headG = new THREE.ConeGeometry(0.05, 0.13, 4);
    const finG = new THREE.BoxGeometry(0.12, 0.014, 0.14);
    arrowGeoCache = { shaftG, headG, finG };
  }
  const wood = new THREE.MeshLambertMaterial({ color: 0x8a6134 });
  const iron = new THREE.MeshLambertMaterial({ color: 0xc9d0d8 });
  const feather = new THREE.MeshLambertMaterial({ color: 0xf2efe6 });
  const g = new THREE.Group();
  const shaft = new THREE.Mesh(arrowGeoCache.shaftG, wood);
  const head = new THREE.Mesh(arrowGeoCache.headG, iron);
  head.rotation.x = Math.PI / 2; head.position.z = 0.34;
  const f1 = new THREE.Mesh(arrowGeoCache.finG, feather);
  f1.position.z = -0.26; f1.rotation.y = 0.35;
  const f2 = new THREE.Mesh(arrowGeoCache.finG, feather);
  f2.position.z = -0.26; f2.rotation.y = -0.35;
  g.add(shaft, head, f1, f2);
  g.userData.shared = true;
  return g;
}
function spawnArrow(from, to, opts = {}) {
  const dir = to.clone().sub(from).normalize();
  const obj = makeArrowModel();
  obj.position.copy(from);
  obj.lookAt(to);
  scene.add(obj);
  arrows.push({
    p: from.clone(), v: dir.multiplyScalar(opts.speed || 24), t: 0, obj,
    dmg: opts.dmg || 4, fromPlayer: !!opts.fromPlayer,
  });
  return true;
}
function shootArrow(m) {                       // 骷髅射箭
  const from = new THREE.Vector3(m.p.x, m.p.y + 1.15, m.p.z);
  const to = new THREE.Vector3(player.p.x, player.p.y + 1.05, player.p.z);
  spawnArrow(from, to, { dmg: 4, speed: 22 });
  sfx('place');
}
function updateArrows(dt) {
  for (let i = arrows.length - 1; i >= 0; i--) {
    const a = arrows[i];
    a.t += dt;
    a.v.y -= 6.5 * dt;
    let gone = a.t > 5;
    // 分 3 小步推进并逐小步判定：箭速 34 m/s 时一帧走 0.57 格，不分步会直接穿过去
    const SUB = 3;
    for (let k = 0; k < SUB && !gone; k++) {
      a.p.addScaledVector(a.v, dt / SUB);
      if (a.fromPlayer) {                              // 玩家的箭打怪
        for (const m of mobs) {
          if (m.hp <= 0 || m.dying) continue;
          const dx = a.p.x - m.p.x, dy = a.p.y - (m.p.y + 0.6), dz = a.p.z - m.p.z;
          if (dx * dx + dy * dy + dz * dz > 0.55) continue;
          m.hp -= a.dmg; m.flash = 0.24; m.aggro = 18;
          const kd = Math.hypot(a.v.x, a.v.z) || 1;
          m.v.x = (a.v.x / kd) * 4.2; m.v.z = (a.v.z / kd) * 4.2; m.v.y = Math.max(m.v.y, 2.6);
          m.knockT = 0.22;
          sfx('hit');
          toast(`命中 ${MOB_DEFS[m.kind].name} −${a.dmg}`, 0.9);
          if (m.hp <= 0) {
            startMobDeath(m);
            player.kills = (player.kills || 0) + 1;
            toast(`射倒 ${MOB_DEFS[m.kind].name}`, 1.4);
          }
          gone = true;
          break;
        }
      } else {                                          // 敌人的箭打玩家
        const dx = a.p.x - player.p.x, dy = a.p.y - (player.p.y + 0.9), dz = a.p.z - player.p.z;
        if (dx * dx + dy * dy + dz * dz < 0.45) { hurtPlayerFrom(a.p.x - a.v.x * 0.05, a.p.z - a.v.z * 0.05, a.dmg, 4.6); gone = true; }
      }
      if (!gone) {
        const bb = getBlock(Math.floor(a.p.x), Math.floor(a.p.y), Math.floor(a.p.z));
        if (bb !== 0 && bb !== 5 && bb !== 22) gone = true;
      }
    }
    a.obj.position.copy(a.p);
    if (gone) { scene.remove(a.obj); arrows.splice(i, 1); }   // 几何共享，不 dispose
  }
}

// ── 死亡 / 移除 ──
function killMob(m) {
  scene.remove(m.obj);
  m.obj.traverse(o => {
    if (o.geometry && !o.geometry.userData.shared) o.geometry.dispose();
    if (o.material) { if (Array.isArray(o.material)) o.material.forEach(x => x.dispose()); else o.material.dispose(); }
  });
}
function startMobDeath(m) {
  if (m.dying) return;
  m.dying = true;
  m.dieT = 0;
  m.hp = 0;
  m.aggro = 0;
  m.v.set(0, 0, 0);
  m.parts.bar.visible = false;
  m.parts.bodyMat.emissive.setHex(0x000000);
  m.parts.headMat.emissive.setHex(0x000000);
  const def = MOB_DEFS[m.kind];
  if (def && def.drop) {                            // 掉落物实体
    const [lo, hi] = def.dropN || [1, 2];
    const n = lo + Math.floor(Math.random() * (hi - lo + 1));
    spawnDrop(def.drop, n, m.p.x, m.p.y + 0.45, m.p.z);
    toast(`${def.name}掉落了 ${nameOf(def.drop)} ×${n}`, 1.8);
  }
  sfx('hurt');
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
      m.parts.core.position.y = m.parts.coreY - 0.28 * fall;
      if (m.parts.arm1) m.parts.arm1.rotation.x = -0.5 * fall;   // 鸡只有两条腿，arm2 可能为空
      if (m.parts.arm2) m.parts.arm2.rotation.x = 0.35 * fall;
      m.parts.bar.visible = false;
      if (m.dieT > MOB_DEATH_HOLD) {
        const k = clamp01((m.dieT - MOB_DEATH_HOLD) / MOB_DEATH_FADE);
        const sc = 1 - k;
        m.obj.scale.setScalar(Math.max(0.001, sc));
        m.obj.position.y = m.p.y - 0.3 * k;
        if (sc <= 0.03 || dist > 40) { killMob(m); mobs.splice(i, 1); }
      }
      continue;
    }
    const def = MOB_DEFS[m.kind];
    const hostileNow = def.hostile && (night || m.aggro > 0);
    m.flash = Math.max(0, m.flash - dt);
    m.aggro = Math.max(0, m.aggro - dt);
    m.flee = Math.max(0, m.flee - dt);
    if (m.hp <= 0) { startMobDeath(m); continue; }
    if (dist > 72) { killMob(m); mobs.splice(i, 1); continue; }
    if (!def.hostile && !night && dist > 44) { killMob(m); mobs.splice(i, 1); continue; }

    let mx = 0, mz = 0, speed = def.wander;
    if (def.ranged && hostileNow && player.alive) {      // 骷髅：保持距离并射箭
      if (dist > 15) { mx = dx / (dist || 1); mz = dz / (dist || 1); speed = def.chase; }
      else if (dist < 6) { mx = -dx / (dist || 1); mz = -dz / (dist || 1); speed = def.chase * 0.85; }
      m.shootCd = (m.shootCd || 0) - dt;
      if (m.shootCd <= 0 && dist < 20 && sightClear(m.p, player.p)) { m.shootCd = 1.7; shootArrow(m); }
    } else if (def.hostile && hostileNow && dist < 26 && player.alive) {
      mx = dx / (dist || 1); mz = dz / (dist || 1); speed = def.chase;
    } else if (m.flee > 0) {                         // 被打之后逃跑
      mx = -dx / (dist || 1); mz = -dz / (dist || 1); speed = def.chase;
    } else {
      m.wander -= dt;
      if (m.wander <= 0) {
        m.wander = 1.5 + Math.random() * 2.5;
        const a = Math.random() * Math.PI * 2;
        m.dir.set(Math.cos(a), Math.sin(a));
      }
      mx = m.dir.x * 0.45; mz = m.dir.y * 0.45;
      if (m.home) {                                  // 村民别走太远
        const hx = m.home.x - m.p.x, hz = m.home.z - m.p.z;
        const hd = Math.hypot(hx, hz);
        if (hd > 14) { mx = hx / hd; mz = hz / hd; speed = def.wander; }
      }
    }
    if (m.knockT > 0) {                       // 被击退：保住冲量，AI 这段时间不接管
      m.knockT -= dt;
      const damp = Math.pow(0.03, dt);
      m.v.x *= damp; m.v.z *= damp;
    } else {
      m.v.x = mx * speed; m.v.z = mz * speed;
    }
    const before = m.p.x, beforeZ = m.p.z;
    if (def.float) {                            // 幽灵：飘着走、穿墙、不落地下坠
      m.floatY = m.floatY === undefined ? m.p.y + 1.1 : m.floatY;
      m.v.y = 0;
      m.p.x += m.v.x * dt; m.p.z += m.v.z * dt;
      const hover = m.floatY + Math.sin(m.phase * 1.4) * 0.18;
      m.p.y += (hover - m.p.y) * Math.min(1, dt * 3.2);
    } else {
      m.v.y -= CFG.GRAV * dt;
      moveBody(m, m.v.x * dt, m.v.y * dt, m.v.z * dt);
    }
    if (!def.float && m.onGround && (Math.abs(m.p.x - before) < 0.001 || Math.abs(m.p.z - beforeZ) < 0.001)) m.v.y = CFG.JUMP * 0.85;
    if (m.p.y < -6) m.hp = 0;
    // 朝向 = 实际移动方向。原来无条件朝玩家，走路时看起来是横着/倒着走
    const vlen = Math.hypot(m.v.x, m.v.z);
    const faceY = vlen > 0.3 ? Math.atan2(m.v.x, m.v.z)
                : (dist < 22 ? Math.atan2(dx, dz) : m.obj.rotation.y);   // 站住时才转过来看你
    let dYaw = faceY - m.obj.rotation.y;
    while (dYaw > Math.PI) dYaw -= Math.PI * 2;
    while (dYaw < -Math.PI) dYaw += Math.PI * 2;
    m.obj.rotation.y += clamp(dYaw, -dt * 11, dt * 11);                  // 平滑转身
    m.obj.position.copy(m.p);
    m.phase += dt * (2 + speed);
    if (m.parts.arm1) m.parts.arm1.rotation.x = Math.sin(m.phase * 3) * (m.kind === 'pig' ? 0.5 : 0.45);
    if (m.parts.arm2) m.parts.arm2.rotation.x = -Math.sin(m.phase * 3) * (m.kind === 'pig' ? 0.5 : 0.45);
    // 受击闪红
    const em = m.flash > 0 ? 0xa03030 : 0x000000;
    m.parts.bodyMat.emissive.setHex(em);
    m.parts.headMat.emissive.setHex(em);
    // 血条
    m.parts.bar.visible = m.hp < m.maxHp || dist < 14;
    if (m.parts.bar.visible) {
      m.parts.bar.lookAt(camera.position);
      const f = Math.max(0.02, m.hp / m.maxHp);
      m.parts.barFg.scale.x = f;
      m.parts.barFg.position.x = -(1 - f) * 0.36;
      m.parts.barFg.material.color.setHex(f > 0.55 ? 0x7fe06b : f > 0.25 ? 0xf0c04a : 0xe0524b);
    }
    // 怕太阳的生物
    if (def.sunBurn) {
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
    }
    // 贴身攻击（所有敌对生物；骷髅是远程，只有贴脸才用近战）
    m.atkCd -= dt;
    if (def.hostile && hostileNow && dist < (def.boss ? 2.4 : 1.5) && m.atkCd <= 0 && player.alive && Math.abs(m.p.y - player.p.y) < (def.boss ? 3.2 : 2.0)) {
      m.atkCd = def.atkCd || 1.6;
      hurtPlayerFrom(m.p.x, m.p.z, def.dmg || 3);
      sfx('hurt');
    }
  }
  updateArrows(dt);
  // 刷怪：敌对生物只在黑暗处，和平生物在草地，村民在村庄
  const capGrunt = night ? CFG.MAX_MOBS + 2 : CFG.MAX_MOBS;
  if (countKind('grunt') < capGrunt && Math.random() < dt * 0.85) spawnMob('grunt');
  if (countKind('pig') < 4 && Math.random() < dt * 0.12) spawnMob('pig');
  if (countKind('cow') < 3 && Math.random() < dt * 0.10) spawnMob('cow');
  if (countKind('sheep') < 3 && Math.random() < dt * 0.10) spawnMob('sheep');
  if (countKind('chicken') < 4 && Math.random() < dt * 0.13) spawnMob('chicken');
  if (countKind('spider') < 4 && Math.random() < dt * 0.55) spawnMob('spider');
  if (countKind('skeleton') < 3 && Math.random() < dt * 0.30) spawnMob('skeleton');
  // 废弃鬼屋：进屋就刷幽灵，每栋只唤醒一只幽灵王
  const hcx = Math.floor(player.p.x / HS_CELL), hcz = Math.floor(player.p.z / HS_CELL);
  for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
    const hs = hauntedFor(hcx + dx, hcz + dz);
    if (!hs) continue;
    if (Math.abs(player.p.x - hs.cx) > hs.W + 3 || Math.abs(player.p.z - hs.cz) > hs.D + 3) continue;
    if (player.p.y < hs.y0 - 3 || player.p.y > hs.y0 + hs.floors * hs.fh + 6) continue;
    const key = hs.cellX + ',' + hs.cellZ;
    if (countKind('ghost') < 4 && Math.random() < dt * 0.9) {
      const gx = hs.cx + Math.round((Math.random() * 2 - 1) * (hs.W - 1));
      const gz = hs.cz + Math.round((Math.random() * 2 - 1) * (hs.D - 1));
      const gy2 = hs.y0 + Math.floor(Math.random() * hs.floors) * hs.fh + 1;
      spawnMobAt('ghost', gx, gy2, gz);
    }
    if (!bossSpawned.has(key) && countKind('ghostBoss') === 0 && Math.random() < dt * 0.8) {
      bossSpawned.add(key);
      spawnMobAt('ghostBoss', hs.bossAt.x, hs.bossAt.y, hs.bossAt.z);
      toast('幽灵王醒了 —— 它守在这栋鬼屋的最上层', 3.2);
      sfx('hurt');
    }
  }
  const v = (typeof nearestVillage === 'function') ? nearestVillage() : null;
  if (v && countKind('villager') < 3 && Math.random() < dt * 0.4) {
    const ang = Math.random() * Math.PI * 2, r = 3 + Math.random() * 8;
    const x = Math.floor(v.cx + Math.cos(ang) * r), z = Math.floor(v.cz + Math.sin(ang) * r);
    spawnMobAt('villager', x, surfaceY(x, z) + 1, z, { home: { x: v.cx, z: v.cz } });
  }
}

/* ============================================================ 掉落物 */
const drops = [];
const DROP_MAX = 90;
const dropTexCache = new Map();
function dropTexture(id) {
  if (dropTexCache.has(id)) return dropTexCache.get(id);
  const tex = new THREE.TextureLoader().load(iconURL(id));
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.NearestFilter;
  dropTexCache.set(id, tex);
  return tex;
}
function spawnDrop(id, n, x, y, z, opts = {}) {
  if (!isItem(id) || n <= 0) return null;
  if (drops.length >= DROP_MAX) { addItem(id, n); return null; }   // 太挤就直接进包
  const mat = new THREE.MeshBasicMaterial({ map: dropTexture(id), transparent: true });
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(0.38, 0.38, 0.38), mat);
  const d = {
    id, n, t: 0, spin: Math.random() * 6,
    p: new THREE.Vector3(x, y, z),
    v: new THREE.Vector3((Math.random() - 0.5) * 1.4, opts.pop || 2.4, (Math.random() - 0.5) * 1.4),
    obj: mesh,
  };
  mesh.position.copy(d.p);
  scene.add(mesh);
  drops.push(d);
  return d;
}
function updateDrops(dt) {
  for (let i = drops.length - 1; i >= 0; i--) {
    const d = drops[i];
    d.t += dt;
    const dx = player.p.x - d.p.x, dy = (player.p.y + 0.7) - d.p.y, dz = player.p.z - d.p.z;
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (d.t > 0.3 && dist < 2.0) {                       // 靠近后吸附过来
      const k = Math.min(1, dt * 9);
      d.p.x += dx * k; d.p.y += dy * k; d.p.z += dz * k;
      d.v.set(0, 0, 0);
    } else {
      d.v.y -= 17 * dt;
      d.p.x += d.v.x * dt; d.p.y += d.v.y * dt; d.p.z += d.v.z * dt;
      const below = getBlock(Math.floor(d.p.x), Math.floor(d.p.y - 0.17), Math.floor(d.p.z));
      if (d.v.y < 0 && isSolid(below)) {                  // 落地弹一下
        d.p.y = Math.floor(d.p.y - 0.17) + 1.17;
        d.v.y *= -0.3;
        d.v.x *= 0.55; d.v.z *= 0.55;
        if (Math.abs(d.v.y) < 0.7) d.v.y = 0;
      }
    }
    d.spin += dt * 2.4;
    d.obj.position.set(d.p.x, d.p.y + Math.sin(d.t * 3.2) * 0.05, d.p.z);
    d.obj.rotation.y = d.spin;
    d.obj.rotation.x = Math.sin(d.spin * 0.7) * 0.15;
    if (d.t > 0.3 && dist < 0.95) {                       // 拾取
      addItem(d.id, d.n);
      if (d.n > 1) toast(`拾取 ${nameOf(d.id)} ×${d.n}`, 1.1);
      sfx('dig');
      renderHotbar();
      scene.remove(d.obj);
      d.obj.geometry.dispose(); d.obj.material.dispose();
      drops.splice(i, 1);
      continue;
    }
    if (d.t > 180) { scene.remove(d.obj); drops.splice(i, 1); }
  }
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
  if (isCreative()) return;                      // 创造模式无敌
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
    let durBar = '';
    if (s) {
      const idef = ITEMS[s.id];
      if (idef && idef.dur) {
        const left = s.d === undefined ? idef.dur : s.d;
        const f = Math.max(0, Math.min(1, left / idef.dur));
        const col = f > 0.5 ? '#7fe06b' : f > 0.25 ? '#f0c04a' : '#e0524b';
        durBar = `<i class="dur"><b style="width:${(f * 100).toFixed(0)}%;background:${col}"></b></i>`;
      }
    }
    d.innerHTML = `<span class="k">${i + 1}</span>` +
      (s ? `<img src="${iconURL(s.id)}" alt=""><span class="n">${s.n > 1 ? s.n : ''}</span>` + durBar : '');
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
    } else {
      d.innerHTML = `<span style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-size:10px;color:#5d738d">${ARMOR_SLOT_NAME[s]}</span>`;
    }
    // 手上有东西 → 穿到这个槽；手空 → 把这个槽脱下来拿在手上
    d.onclick = () => {
      if (cursor) {
        const df = ITEMS[cursor.id];
        if (df && df.kind === 'armor' && df.slot === s) {
          const old = player.armor[s];
          player.armor[s] = cursor.id;
          cursor.n -= 1;
          if (cursor.n <= 0) cursor = null;
          if (old) addItem(old, 1);
          toast(`穿上 ${ITEMS[player.armor[s]].name}（护甲 ${armorPoints()}）`, 1.4);
          afterSlotChange();
        } else toast(`这个槽只能放${ARMOR_SLOT_NAME[s]}`, 1.4);
      } else if (id) {
        player.armor[s] = null;
        cursor = { id, n: 1 };
        toast(`脱下 ${nameOf(id)}`, 1.1);
        afterSlotChange();
      }
    };
    row.appendChild(d);
  }
  const v = $('armorVal');
  if (v) v.textContent = `护甲 ${armorPoints()}`;
}
function renderCreativeGrid() {
  const box = $('creativeGrid'), sec = $('creativeSec');
  if (!box || !sec) return;
  if (!isCreative()) { sec.classList.add('hide'); return; }
  sec.classList.remove('hide');
  box.innerHTML = '';
  const ids = [...Object.keys(BLOCKS).map(Number), ...Object.keys(ITEMS).map(Number)].filter(id => isItem(id));
  for (const id of ids) {
    const d = document.createElement('div');
    d.className = 'cell';
    d.innerHTML = `<img src="${iconURL(id)}" alt="">`;
    d.title = nameOf(id) + '（点一下拿一组）';
    d.onclick = () => { addItem(id, 64); renderHotbar(); renderInventoryPanel(); saveSoon(); };
    box.appendChild(d);
  }
}
function renderInventoryPanel() {
  renderArmorRow();
  renderCreativeGrid();
  renderGrid(hud.invGrid, inv, i => slotClick(inv, i));
  if ($('cursorInfo')) $('cursorInfo').textContent = cursorText();
  hud.invCount.textContent = `${invUsed()}/${SLOTS}`;
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
  { out: 124, n: 1, need: { 107: 3 } },
  { out: 19, n: 1, need: { 9: 8 }, tier: 1 },
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
  { out: 14, n: 1, need: { 8: 2, 104: 3, 142: 2 }, tier: 1 },
  { out: 149, n: 1, need: { 148: 2, 104: 1 }, tier: 1 },
  { out: 151, n: 1, need: { 106: 3 }, tier: 1 },
  { out: 153, n: 1, need: { 104: 3, 142: 1 }, tier: 1 },
  { out: 154, n: 4, need: { 104: 1, 148: 1 }, tier: 1 },
  { out: 158, n: 1, need: { 8: 2, 104: 2 }, tier: 1 },
  { out: 159, n: 1, need: { 9: 2, 104: 2 }, tier: 1 },
  { out: 160, n: 1, need: { 106: 2, 104: 2 }, tier: 1 },
  { out: 25, n: 1, need: { 8: 4, 104: 2 }, tier: 1 },
  { out: 33, n: 4, need: { 21: 6 }, tier: 1 },
  { out: 34, n: 4, need: { 8: 6 }, tier: 1 },
  { out: 130, n: 1, need: { 125: 3, 104: 2 }, tier: 1 },
  { out: 131, n: 1, need: { 125: 2, 104: 1 }, tier: 1 },
  { out: 132, n: 1, need: { 125: 5 }, tier: 1 },
  { out: 133, n: 1, need: { 125: 8 }, tier: 1 },
  { out: 134, n: 1, need: { 125: 7 }, tier: 1 },
  { out: 135, n: 1, need: { 125: 4 }, tier: 1 },
];
// 熔炉：1 份燃料 + 1 份原料 → 1 份产物（燃料：木板 or 炼好的煤块）
const SMELT = [
  { in: 15, out: 106, n: 1, name: '铁矿石 → 铁锭' },
  { in: 108, out: 109, n: 1, name: '生猪排 → 熟猪排' },
  { in: 140, out: 141, n: 1, name: '生牛肉 → 熟牛肉' },
  { in: 143, out: 144, n: 1, name: '鸡肉 → 熟鸡肉' },
  { in: 4, out: 124, n: 0, name: '' },              // 占位（沙子暂无用途）
];
const FUELS = [8, 13];
function fuelCount() { return FUELS.reduce((a, id) => a + countOf(id), 0); }
function smelt(r) {
  if (!r || !r.n) return false;
  if (countOf(r.in) < 1) { toast(`没有 ${nameOf(r.in)}`, 1.4); return false; }
  if (fuelCount() < 1) { toast('没有燃料（木板或煤）', 1.6); return false; }
  const fuelId = FUELS.find(id => countOf(id) > 0);
  takeItem(r.in, 1);
  takeItem(fuelId, 1);
  spawnDrop(r.out, r.n, player.p.x, player.p.y + 0.9, player.p.z);
  toast(`熔炼出 ${nameOf(r.out)}`, 1.5);
  sfx('craft');
  renderHotbar(); renderFurnace(); saveSoon();
  return true;
}

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
let panelOpen = false, lastSpaceT = 0, createMode = 'survival', jumpTouchT = 0;
function renderFurnace() {
  const list = $('smeltList');
  if (!list) return;
  const fuel = fuelCount();
  const fi = $('fuelInfo');
  if (fi) fi.textContent = `${fuel} 份`;
  list.innerHTML = '';
  for (const r of SMELT) {
    if (!r.n) continue;
    const have = countOf(r.in);
    const can = have > 0 && fuel > 0;
    const d = document.createElement('div');
    d.className = 'rec' + (can ? '' : ' no');
    d.innerHTML = `<img src="${iconURL(r.out)}" alt=""><div class="t">${nameOf(r.out)} ×${r.n}`
      + `<i>${nameOf(r.in)} ×1 + 燃料 ×1（已有原料 ${have}）</i></div>`
      + `<div class="go">${can ? '熔炼 →' : have ? '缺燃料' : '缺原料'}</div>`;
    d.onclick = () => { if (can) smelt(r); };
    list.appendChild(d);
  }
}
function openFurnace() { renderFurnace(); $('furnace').classList.remove('hide'); }
function closeFurnace() { $('furnace').classList.add('hide'); }
function openPanel(open) {
  if (open && openChestPos) closeChest();
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
  if (captureAction) {                             // 正在改键：吃掉这次按键
    e.preventDefault();
    if (k !== 'Escape') { keymap[captureAction] = k; saveCfg(); toast(`已绑定 ${prettyKey(k)}`, 1.4); }
    captureAction = null; renderKeyRows();
    return;
  }
  keys.add(k);
  if (started && !panelOpen && player.alive) {
    if (k === keymap.mine) { mineHeld = true; attackQueued = true; }
    if (k === keymap.place) placeQueued = true;
  }
  if (k === 'Space') {
    jumpQueued = true; e.preventDefault();
    if (isCreative() && started) {                     // 创造模式连按两次空格 = 飞行开关
      const now = performance.now();
      if (now - (lastSpaceT || 0) < 320) {
        player.fly = !player.fly;
        player.v.y = 0;
        toast(player.fly ? '飞行：开（空格上升 / Shift 下降）' : '飞行：关', 1.8);
        lastSpaceT = 0;
      } else lastSpaceT = now;
    }
  }
  if (k === keymap.bag) { if (started) openPanel(!panelOpen); e.preventDefault(); }
  if (k.startsWith('Digit')) {
    const n = +k.slice(5);
    if (n >= 1 && n <= 9) { player.sel = n - 1; refreshHeld(); renderHotbar(); }
  }
  if (k === 'Escape') {
    if (!$('settings').classList.contains('hide')) { openSettings(false); e.preventDefault(); return; }
    if (openChestPos) { closeChest(); e.preventDefault(); return; }
    if (!$('furnace').classList.contains('hide')) { closeFurnace(); e.preventDefault(); return; }
    if (panelOpen) { openPanel(false); e.preventDefault(); return; }
  }
});
addEventListener('keyup', e => keys.delete(e.code));
addEventListener('wheel', e => {
  if (!started || panelOpen) return;
  player.sel = (player.sel + (e.deltaY > 0 ? 1 : -1) + 9) % 9;
  refreshHeld(); renderHotbar();
}, { passive: true });

renderer.domElement.addEventListener('mousedown', e => {
  if (!started || panelOpen || !player.alive) return;
  if (document.pointerLockElement !== renderer.domElement) {
    if (userCfg.touchUI && e.button === 0) { dragLook = true; return; }   // 无指针锁：鼠标拖拽转视角
    lockPointer(); return;
  }
  if (e.button === 0) { mineHeld = true; attackQueued = true; if (heldKind() === 'sword') startSwing('attack', 0.5); }
  if (e.button === 2) placeQueued = true;
});
addEventListener('keyup', e => { if (e.code === keymap.mine) mineHeld = false; });
addEventListener('mouseup', e => { if (e.button === 0) { mineHeld = false; dragLook = false; } });
addEventListener('contextmenu', e => e.preventDefault());
let dragLook = false;
addEventListener('mousemove', e => {
  if (!started || panelOpen) return;
  const sens = userCfg.sens;
  if (document.pointerLockElement === renderer.domElement) {
    player.yaw -= e.movementX * 0.0023 * sens;
    player.pitch = clamp(player.pitch - e.movementY * 0.0023 * sens, -1.53, 1.53);
  } else if (dragLook) {                                   // 虚拟按键模式：按住左键拖动看四周
    player.yaw -= e.movementX * 0.0035 * sens;
    player.pitch = clamp(player.pitch - e.movementY * 0.0035 * sens, -1.53, 1.53);
  }
});

/* ---------- 触屏 ---------- */
const isTouchDevice = matchMedia('(pointer:coarse)').matches || 'ontouchstart' in window;
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
        player.yaw -= (t.clientX - lookLast.x) * 0.0052 * userCfg.sens;
        player.pitch = clamp(player.pitch - (t.clientY - lookLast.y) * 0.0052 * userCfg.sens, -1.53, 1.53);
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
bindHold($('tJump'), () => { jumpQueued = true; jumpTouchT = performance.now(); });
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
  if (isCreative()) { player.mining = 1; player.mineTarget = target; breakBlock(target); return true; }   // 创造：秒破
  const pickOk = heldKind() === 'pick';
  let speed = 1 / Math.max(0.12, def.hard);
  if (def.pick) speed *= pickOk ? 1 : 0.28;
  const heldDef = held() ? ITEMS[held().id] : null;
  if (heldDef && heldDef.fast) {
    // 镐对石头/矿石吃满加成；对土、木、沙子这类也有一半加成（手感统一）
    speed *= def.pick ? heldDef.fast : 1 + (heldDef.fast - 1) * 0.5;
  }
  player.mining += dt * speed;
  player.mineTarget = target;
  if (player.mining >= 1) {
    player.mining = 0;
    breakBlock(target);
    useTool(1);                                    // 挖掉一块扣 1 点耐久
    return true;
  }
  return false;
}
function breakBlock(t) {
  const def = BLOCKS[t.id];
  if (!def) return;
  setBlock(t.x, t.y, t.z, 0);
  if (def.bed) {                                       // 床是两格：拆一半就把另一半也拆掉
    for (const [bx, bz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      if (getBlock(t.x + bx, t.y, t.z + bz) === 14) { setBlock(t.x + bx, t.y, t.z + bz, 0); break; }
    }
  }
  sfx('dig');
  const dropAt = (id, n) => spawnDrop(id, n, t.x + 0.5, t.y + 0.6, t.z + 0.5);
  if (def.chest) {                                   // 箱子里的东西一并掉出来
    const slots = chestInv.get(t.x + ',' + t.y + ',' + t.z);
    if (slots) for (const s of slots) if (s) spawnDrop(s.id, s.n, t.x + 0.5, t.y + 0.7, t.z + 0.5);
    chestInv.delete(t.x + ',' + t.y + ',' + t.z);
    if (openChestPos && openChestPos.x === t.x && openChestPos.y === t.y && openChestPos.z === t.z) closeChest();
  }
  if (def.mature) {                                // 成熟小麦：掉 1~3 小麦 + 1~2 种子
    dropAt(107, 1 + Math.floor(Math.random() * 3));
    dropAt(156, 1 + Math.floor(Math.random() * 2));
  } else if (def.plant) {                          // 幼苗/苗：只退回 1 颗种子
    dropAt(156, 1);
  } else if (t.id === 1 && Math.random() < 0.12) { // 割草有概率捡到种子
    dropAt(156, 1);
  }
  if (def.leaf) { if (Math.random() < 0.12) dropAt(105, 1); }
  else if (def.drop) {
    const ironPick = inv.some(s => s && (s.id === 120 || s.id === 130));
    const stonePick = inv.some(s => s && (s.id === 101 || s.id === 120 || s.id === 130));
    if (def.ironPick && !ironPick) toast('钻石矿要用铁镐（或钻石镐）才能挖', 2.0);
    else if (def.stonePick && !stonePick) toast('铁矿需要石镐或更好才能采集', 1.8);
    else if (def.pick && heldKind() !== 'pick') toast('石头需要镐才能采集', 1.8);
    else dropAt(def.drop, 1);
  }
  renderHotbar(); refreshHeld(); saveSoon();
}
function placeBlock() {
  const h = held();
  if (!h || !BLOCKS[h.id]) { toast('手里没有可放置的方块', 1.4); return false; }
  const t = raycastVoxel(eyePos(), cameraDir(), CFG.REACH);
  if (!t) return false;
  const x = t.x + t.nx, y = t.y + t.ny, z = t.z + t.nz;
  if (y < 0 || y >= CFG.WH) return false;
  const cur = getBlock(x, y, z);
  if (cur !== 0 && cur !== 5) return false;
  if (blockBoxBlocks(x, y, z)) { toast('这里放不下（会卡住自己）', 1.4); return false; }
  if (h.id === 14) {                                   // 床：脚 + 头两格，沿玩家朝向摆
    const dir = cameraDir();
    const bx = Math.abs(dir.x) >= Math.abs(dir.z) ? Math.sign(dir.x) : 0;
    const bz = bx === 0 ? Math.sign(dir.z) : 0;
    const hx = x + bx, hz = z + bz;
    const headId = getBlock(hx, y, hz);
    if (headId !== 0 && headId !== 5) { toast('床要两格空间（前面被挡住了）', 1.9); return false; }
    if (y === 0 || !isSolid(getBlock(x, y - 1, z)) || !isSolid(getBlock(hx, y - 1, hz))) {
      toast('床下面要有地面', 1.7); return false;
    }
    if (blockBoxBlocks(hx, y, hz)) { toast('这里放不下（会卡住自己）', 1.4); return false; }
    const bdir = bx > 0 ? 1 : bx < 0 ? 2 : bz > 0 ? 3 : 4;    // 脚 → 头 的方向
    setBlock(x, y, z, 14); setMeta(x, y, z, bdir);            // 脚格（无枕头）
    setBlock(hx, y, hz, 14); setMeta(hx, y, hz, bdir + 4);    // 头格（枕头在远端）
    if (!isCreative()) takeItem(14, 1);
    setSpawnAt(x, y, z);
    sfx('place'); startSwing('place', 0.26);
    renderHotbar(); refreshHeld(); saveSoon();
    return true;
  }
  const bdef = BLOCKS[h.id];
  let meta = 0;
  if (bdef.log) meta = (t.ny !== 0) ? 0 : (t.nx !== 0 ? 1 : 2);        // 按命中面定轴向
  else if (bdef.stair) {                                               // 高侧朝玩家看的方向
    const dir = cameraDir();
    meta = Math.abs(dir.x) >= Math.abs(dir.z) ? (dir.x > 0 ? 1 : 2) : (dir.z > 0 ? 3 : 4);
  }
  setBlock(x, y, z, h.id);
  if (meta) setMeta(x, y, z, meta);
  if (!isCreative()) takeItem(h.id, 1);          // 创造模式无限方块
  sfx('place');
  startSwing('place', 0.26);
  if (h.id === 14) setSpawnAt(x, y, z);
  renderHotbar(); refreshHeld(); saveSoon();
  return true;
}
// ── 种植系统 ──────────────────────────────────────────────────────────────
const compostProg = new Map();                 // 堆肥箱 "x,y,z" → 已放入的食物数（0..3）

function useHoe(t) {                           // 锄地：草地/泥土 → 农田
  if (!t) return false;
  const above = getBlock(t.x, t.y + 1, t.z);
  if ((t.id === 1 || t.id === 2) && (above === 0)) {
    setBlock(t.x, t.y, t.z, 16);
    useTool(1); startSwing('dig', 0.34); sfx('dig'); saveSoon();
    toast('锄成农田了（拿小麦种子右键播种）', 1.8);
    return true;
  }
  toast('只能锄草地或泥土', 1.3);
  return false;
}
function plantSeed(t) {                        // 农田上播种
  if (!t) return false;
  const x = t.x + t.nx, y = t.y + t.ny, z = t.z + t.nz;
  if (getBlock(x, y, z) !== 0) return false;
  if (getBlock(x, y - 1, z) !== 16) { toast('要先锄地（农田）才能种', 1.5); return false; }
  if (countOf(156) < 1) { toast('没有小麦种子', 1.3); return false; }
  takeItem(156, 1);
  setBlock(x, y, z, 23);
  startSwing('place', 0.3); sfx('place'); saveSoon();
  return true;
}
function useFertilizer(t) {                    // 肥料：催熟一阶段
  if (!t) return false;
  const x = t.x + t.nx, y = t.y + t.ny, z = t.z + t.nz;
  const id = getBlock(x, y, z);
  if (id !== 23 && id !== 24) {
    if (t.id === 23 || t.id === 24) return useFertilizerAt(t.x, t.y, t.z);
    toast('肥料要对着小麦幼苗用', 1.4);
    return false;
  }
  return useFertilizerAt(x, y, z);
}
function useFertilizerAt(x, y, z) {
  const id = getBlock(x, y, z);
  if (id !== 23 && id !== 24) return false;
  if (countOf(157) < 1) { toast('没有肥料（堆肥箱里放 4 份食物换 1 份）', 1.6); return false; }
  takeItem(157, 1);
  setBlock(x, y, z, id === 23 ? 24 : 17);
  sfx('place'); saveSoon();
  toast(id === 23 ? '施了一次肥：长高了一节' : '施了一次肥：小麦成熟了', 1.5);
  return true;
}
function useCompost(t) {                       // 堆肥箱：放食物换肥料
  const key = t.x + ',' + t.y + ',' + t.z;
  const food = held();
  if (!food || (ITEMS[food.id] || {}).kind !== 'food') { toast('手里要拿着食物才能堆肥', 1.4); return false; }
  takeItem(food.id, 1);
  const p = (compostProg.get(key) || 0) + 1;
  if (p >= 4) {
    compostProg.set(key, 0);
    addItem(157, 1);
    toast('堆肥完成 → 肥料 ×1', 2.2);
  } else {
    compostProg.set(key, p);
    toast(`堆肥 ${p}/4（再放 ${4 - p} 份食物）`, 1.5);
  }
  sfx('place'); renderHotbar(); refreshHeld(); saveSoon();
  return true;
}
// 作物生长：每 2 秒在玩家周围推一次，幼苗 → 苗 → 成熟
let cropT = 2;
function growCrops(dt) {
  cropT -= dt;
  if (cropT > 0) return;
  cropT = 2;
  const px = Math.floor(player.p.x), py = Math.floor(player.p.y), pz = Math.floor(player.p.z);
  for (let dx = -12; dx <= 12; dx++) for (let dz = -12; dz <= 12; dz++) {
    for (let dy = -2; dy <= 2; dy++) {
      const x = px + dx, y = py + dy, z = pz + dz;
      const id = getBlock(x, y, z);
      if (id !== 23 && id !== 24) continue;
      if (getBlock(x, y - 1, z) !== 16) continue;          // 不在农田上就不长
      if (Math.random() > 0.34) continue;
      setBlock(x, y, z, id === 23 ? 24 : 17);
    }
  }
}

// 玩家射箭：消耗 1 支箭，朝准星方向（带一点重力下坠）
function firePlayerArrow() {
  if (player.bowCd > 0) return false;
  if (countOf(154) < 1) { toast('没有箭了（木棍 + 骨头 合成）', 1.6); return false; }
  takeItem(154, 1);
  const eye = eyePos(), dir = cameraDir();
  const from = new THREE.Vector3(eye.x + dir.x * 0.35, eye.y - 0.12 + dir.y * 0.35, eye.z + dir.z * 0.35);
  const to = from.clone().addScaledVector(dir, 12);
  const bowDef = ITEMS[held() && held().id] || {};
  spawnArrow(from, to, { dmg: bowDef.dmg || 7, speed: 34, fromPlayer: true });
  startSwing('bow', 0.42);
  sfx('place');
  player.bowCd = 0.45;
  useTool(1);
  return true;
}
// 沿视线找水（射线默认会跳过水，这里单独走一条）
function rayWater(maxD) {
  const eye = eyePos(), dir = cameraDir();
  for (let t = 0.25; t < maxD; t += 0.12) {
    const x = Math.floor(eye.x + dir.x * t), y = Math.floor(eye.y + dir.y * t), z = Math.floor(eye.z + dir.z * t);
    const id = getBlock(x, y, z);
    if (id === 5) return { x, y, z };
    if (isSolid(id)) return null;
  }
  return null;
}
function replaceHeld(newId) {
  const s = inv[player.sel];
  if (!s) return false;
  inv[player.sel] = { id: newId, n: 1 };
  refreshHeld(); renderHotbar(); saveSoon();
  return true;
}
// 水桶：full=true 倒水（需要准星对着方块），false 装水（准星对着水）
function useBucket(full, t) {
  if (full) {
    if (!t) return false;
    const x = t.x + t.nx, y = t.y + t.ny, z = t.z + t.nz;
    if (y < 1 || y >= CFG.WH) return false;
    if (getBlock(x, y, z) !== 0) { toast('这里放不下水', 1.3); return false; }
    setBlock(x, y, z, 5);
    wakeWater(x, y, z);
    replaceHeld(151);
    startSwing('place', 0.26); sfx('place');
    toast('倒出一桶水', 1.2);
    return true;
  }
  const src = rayWater(CFG.REACH) || (getBlock(Math.floor(player.p.x), Math.floor(player.p.y), Math.floor(player.p.z)) === 5
    ? { x: Math.floor(player.p.x), y: Math.floor(player.p.y), z: Math.floor(player.p.z) } : null);
  if (!src) { toast('要对着水才能装', 1.3); return false; }
  setBlock(src.x, src.y, src.z, 0);
  waterFlow.delete(src.x + ',' + src.y + ',' + src.z);
  wakeWater(src.x, src.y, src.z);
  replaceHeld(152);
  startSwing('place', 0.26); sfx('place');
  toast('装满一桶水', 1.2);
  return true;
}
function eat() {
  const h = held();
  if (!h || (defOf(h.id) || {}).kind !== 'food') return false;
  if (player.hunger >= 20) { toast('现在不饿', 1.2); return false; }
  player.hunger = Math.min(20, player.hunger + (defOf(h.id).food || 4));
  takeItem(h.id, 1);
  sfx('eat'); toast(`吃掉了 ${nameOf(h.id)}`, 1.2);
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
  const kx = target.p.x - player.p.x, kz = target.p.z - player.p.z;
  const kd = Math.hypot(kx, kz) || 1;
  target.v.x = (kx / kd) * 7.4;              // 沿"玩家 → 怪"方向推开
  target.v.z = (kz / kd) * 7.4;
  target.v.y = 5.2;
  target.knockT = 0.34;                      // 这段时间 AI 不覆盖速度，击退才看得出来
  startSwing('attack', 0.5);
  useTool(1);                                      // 挥砍扣 1 点耐久
  player.atkCd = 0.42;
  player.hits = (player.hits || 0) + 1;
  sfx('hit');
  if (!MOB_DEFS[target.kind].hostile) target.flee = 6;      // 猪/村民被打就跑
  const tname = MOB_DEFS[target.kind].name;
  if (target.hp > 0) toast(`命中 ${tname} −${dmg}（剩 ${Math.max(0, target.hp)}）`, 0.9);
  else {
    player.kills = (player.kills || 0) + 1;
    toast(`击倒 ${tname}`, 1.4);
    startMobDeath(target);          // 立即进入倒地动画（updateMobs 里也会兜底触发）
  }
  return true;
}

/* ============================================================ 更新循环 */
let lastT = 0, acc = 0, fps = 60, frameCount = 0, fpsT = 0, startedAt = 0, camSmoothY = null;
const STEP = 1 / 60;
let saveTimer = 0;

// 玩家被从 (sx,sz) 方向打中：扣血 + 水平击退 + 轻微上抛
function hurtPlayerFrom(sx, sz, dmg, power = 5.4) {
  if (!player.alive) return;
  damagePlayer(dmg);
  const dx = player.p.x - sx, dz = player.p.z - sz;
  const d = Math.hypot(dx, dz) || 1;
  player.v.x = (dx / d) * power;
  player.v.z = (dz / d) * power;
  player.v.y = Math.max(player.v.y, 4.2);
  player.knockT = 0.3;
}
function updatePlayer(dt) {
  player.atkCd = Math.max(0, player.atkCd - dt);
  if (player.bowCd > 0) player.bowCd = Math.max(0, player.bowCd - dt);
  if (!player.alive) { player.v.set(0, 0, 0); return; }
  // 键盘转视角（没有鼠标就靠这个）
  const lookSpd = 1.9 * userCfg.sens;
  if (keyDown('lookLeft')) player.yaw += lookSpd * dt;
  if (keyDown('lookRight')) player.yaw -= lookSpd * dt;
  if (keyDown('lookUp')) player.pitch = clamp(player.pitch + lookSpd * dt, -1.53, 1.53);
  if (keyDown('lookDown')) player.pitch = clamp(player.pitch - lookSpd * dt, -1.53, 1.53);

  let ix = 0, iz = 0;
  if (keyDown('fwd')) iz -= 1;
  if (keyDown('back')) iz += 1;
  if (keyDown('left')) ix -= 1;
  if (keyDown('right')) ix += 1;
  if (joy.active) { ix += joy.x; iz += joy.y; }
  const len = Math.hypot(ix, iz);
  if (len > 1) { ix /= len; iz /= len; }
  const sink = Math.sin(player.yaw), cosk = Math.cos(player.yaw);
  const wx = ix * cosk + iz * sink;
  const wz = -ix * sink + iz * cosk;
  const sprint = keyDown('sprint') || (keymap.sprint === 'ShiftLeft' ? keys.has('ShiftRight') : false);
  const speed = (sprint ? CFG.SPRINT : CFG.WALK) * (player.inWater ? 0.62 : 1);
  if (player.knockT > 0) {                    // 被击退：这几帧不接受方向键，靠冲量滑出去
    player.knockT -= dt;
    const damp = Math.pow(0.03, dt);
    player.v.x *= damp; player.v.z *= damp;
  } else {
    player.v.x = wx * speed;
    player.v.z = wz * speed;
  }

  const feetBlock = getBlock(Math.floor(player.p.x), Math.floor(player.p.y + 0.2), Math.floor(player.p.z));
  player.inWater = feetBlock === 5;
  if (player.fly) {                              // 创造模式飞行：空格上升、Shift 下降
    const up = (keyDown('jump') || keys.has('KeyZ') || performance.now() - jumpTouchT < 120) ? 1 : 0;
    const down = (keys.has('ShiftLeft') || keys.has('ShiftRight')) ? 1 : 0;
    player.v.y = (up - down) * 7.2;
    jumpQueued = false;
    player.fallFrom = null;
  } else if (player.inWater) {
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

  // 饥饿 / 回血（创造模式不饿）
  if (isCreative()) player.hunger = 20;
  else player.hunger = Math.max(0, player.hunger - dt * (moving ? 0.055 : 0.02));
  if (player.hunger <= 0) { player.hp = Math.max(0, player.hp - dt * 0.6); if (player.hp <= 0) die(); }
  else if (player.hunger > 16 && player.hp < 20) player.hp = Math.min(20, player.hp + dt * 0.45);

  // 掉出世界
  if (player.p.y < -8) { damagePlayer(20); respawn(); }
}

function update(dt) {
  worldTime += dt;
  echoTimer -= dt;
  if (echoTimer <= 0) { echoTimer = 0.4; underground = depthBelowSurface() > 2.5; }
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
  updateDrops(dt);
  // 水：每帧跑一点（限流），并每隔半秒把玩家附近的水"唤醒"一次（让瀑布/积水开始流动）
  updateWater(48);
  waterSeedT -= dt;
  if (waterSeedT <= 0) { waterSeedT = 0.5; seedWaterNear(); }
  growCrops(dt);

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
    if (t && t.id === 18) { openChest(t.x, t.y, t.z); startSwing('place', 0.2); }
    else if (t && t.id === 19) { openFurnace(); startSwing('place', 0.2); }
    else if (t && t.id === 10) { openPanel(true); startSwing('place', 0.2); }
    else if (t && BLOCKS[t.id] && BLOCKS[t.id].bed) { setSpawnAt(t.x, t.y, t.z); startSwing('place', 0.26); }
    else if (h && h.id === 153) firePlayerArrow();
    else if (h && ITEMS[h.id] && ITEMS[h.id].kind === 'hoe') useHoe(t);
    else if (h && h.id === 156) plantSeed(t);
    else if (h && h.id === 157) useFertilizer(t);
    else if (h && t && BLOCKS[t.id] && BLOCKS[t.id].compost && ITEMS[h.id] && ITEMS[h.id].kind === 'food') useCompost(t);
    else if (h && h.id === 152) useBucket(true, t);
    else if (h && h.id === 151) useBucket(false, t);
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
  // ① 先卸载远处：这一步每帧必须做，不能因为"建区块超预算"被跳过，
  //    否则一路走一路攒，chunks/heap 无限增长 → 越玩越卡（实测能攒到 3000+ 个区块）
  for (const [k, c] of chunks) {
    const d = Math.max(Math.abs(c.cx - pcx), Math.abs(c.cz - pcz));
    if (d > CFG.UNLOAD_R) {
      if (c.mesh) { scene.remove(c.mesh); c.mesh.geometry.dispose(); }
      if (c.glass) { scene.remove(c.glass); c.glass.geometry.dispose(); }   // 玻璃网格也要释放
      if (c.water) { scene.remove(c.water); c.water.geometry.dispose(); }
      dirty.delete(c);
      chunks.delete(k);
    }
  }
  // ② 建新区块 / 重建脏块：只花 budgetMs 毫秒，超了就留给下一帧
  const tStart = performance.now();
  const budgetMs = perfBudget;
  let built = 0;
  for (let r = 0; r <= CFG.LOAD_R && built < 4; r++) {
    for (let dx = -r; dx <= r && built < 4; dx++) for (let dz = -r; dz <= r && built < 4; dz++) {
      if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
      const c = getChunk(pcx + dx, pcz + dz);
      if (!c.ready) {
        buildChunk(c); built++;
        if (performance.now() - tStart > budgetMs) return;      // 卸载已完成，这里可以提前返回
      }
    }
  }
  // 重建脏区块
  let rebuilt = 0;
  for (const c of dirty) {
    if (rebuilt >= 3 || performance.now() - tStart > budgetMs) break;
    const d = Math.max(Math.abs(c.cx - pcx), Math.abs(c.cz - pcz));
    if (d > CFG.LOAD_R + 1) { dirty.delete(c); continue; }
    buildChunk(c); dirty.delete(c); rebuilt++;
  }
}

/* ============================================================ 帧率自适应预算 */
let perfBudget = 7;
let lastFrameAt = 0;                // 上一帧时间戳
let perfSlow = 0, perfFast = 0;
let frameMsAvg = 16.7;
function noteFrameMs(ms) {
  frameMsAvg += (ms - frameMsAvg) * 0.08;
  if (frameMsAvg > 26) { perfSlow++; perfFast = 0; } else if (frameMsAvg < 19) { perfFast++; perfSlow = 0; }
  if (perfSlow >= 30 && perfBudget > 2.5) { perfBudget = Math.max(2.5, perfBudget - 1.5); perfSlow = 0; }
  else if (perfFast >= 120 && perfBudget < 9) { perfBudget = Math.min(9, perfBudget + 1); perfFast = 0; }
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
    `环境 <b>${underground ? `地下 ${Math.round(depthBelowSurface())} 格` : '地表'}</b>\n` +
    `FPS <b>${Math.round(fps)}</b>  区块 <b>${chunks.size}</b>  ${mem}\n` +
    `坐标 <b>${player.p.x.toFixed(1)} ${player.p.y.toFixed(1)} ${player.p.z.toFixed(1)}</b> 朝${dirName}\n` +
    `时间 <b>${clockText()}</b> ${isNight() ? '夜晚' : '白天'}  怪物 <b>${aliveMobs()}</b>  击倒 <b>${player.kills || 0}</b>\n` +
    `世界 <b>${escHtml((worldMeta(currentId) || {}).name || '—')}</b>  模式 <b>${isCreative() ? '创造' : '生存'}</b>${player.fly ? '（飞行）' : ''}  手持 <b>${held() ? nameOf(held().id) : '空手'}</b>${heldKind() === 'pick' ? '（镐）' : heldKind() === 'sword' ? '（剑）' : ''}  护甲 <b>${armorPoints()}</b>  重生点 <b>${player.spawn && player.spawn.bed ? '床' : '出生点'}</b>`;
  if (s !== lastStatus) { hud.status.innerHTML = s; lastStatus = s; }
  renderHearts();
}

/* ============================================================ 设置 / 改键 */
const CFG_KEY = 'blockwild_cfg_v1';
const DEFAULT_KEYS = {
  fwd: 'KeyW', back: 'KeyS', left: 'KeyA', right: 'KeyD',
  jump: 'Space', sprint: 'ShiftLeft',
  mine: 'KeyF', place: 'KeyG', bag: 'KeyE',
  lookUp: 'ArrowUp', lookDown: 'ArrowDown', lookLeft: 'ArrowLeft', lookRight: 'ArrowRight',
};
const KEY_LABEL = {
  fwd: '前进', back: '后退', left: '左移', right: '右移', jump: '跳跃', sprint: '疾跑',
  mine: '挖 / 攻击（按住）', place: '放置 / 使用', bag: '背包',
  lookUp: '视角上', lookDown: '视角下', lookLeft: '视角左', lookRight: '视角右',
};
const DEFAULT_CFG = { sens: 1, touchUI: false };
let userCfg = { ...DEFAULT_CFG };
let keymap = { ...DEFAULT_KEYS };
let captureAction = null;

function loadCfg() {
  try {
    const raw = localStorage.getItem(CFG_KEY);
    if (!raw) return;
    const d = JSON.parse(raw);
    if (!d || typeof d !== 'object') return;
    if (typeof d.sens === 'number') userCfg.sens = clamp(d.sens, 0.3, 2.5);
    if (typeof d.touchUI === 'boolean') userCfg.touchUI = d.touchUI;
    if (d.keys) for (const k of Object.keys(DEFAULT_KEYS)) if (typeof d.keys[k] === 'string' && d.keys[k]) keymap[k] = d.keys[k];
  } catch (e) {}
}
function saveCfg() {
  try { localStorage.setItem(CFG_KEY, JSON.stringify({ ...userCfg, keys: keymap })); } catch (e) {}
}
const keyDown = act => keys.has(keymap[act]);
function prettyKey(code) {
  if (!code) return '—';
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  const m = {
    Space: '空格', ShiftLeft: '左Shift', ShiftRight: '右Shift', ControlLeft: '左Ctrl', ControlRight: '右Ctrl',
    AltLeft: '左Alt', AltRight: '右Alt', ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→',
    Enter: '回车', Tab: 'Tab', Backquote: '`', Minus: '-', Equal: '=', Comma: ',', Period: '.', Slash: '/',
  };
  return m[code] || code;
}
function applyTouchUI() {
  document.body.classList.toggle('touch', userCfg.touchUI || isTouchDevice);
}
function renderKeyRows() {
  const box = $('keyRows');
  if (!box) return;
  box.innerHTML = '';
  for (const act of Object.keys(DEFAULT_KEYS)) {
    const row = document.createElement('div');
    row.className = 'setrow';
    const name = document.createElement('span');
    name.textContent = KEY_LABEL[act] || act;
    const btn = document.createElement('button');
    btn.className = 'btn keybtn';
    btn.textContent = captureAction === act ? '按一个键…' : prettyKey(keymap[act]);
    if (captureAction === act) btn.style.outline = '2px solid #f5c451';
    btn.onclick = () => { captureAction = act; renderKeyRows(); };
    row.appendChild(name); row.appendChild(btn);
    box.appendChild(row);
  }
}
function openSettings(open) {
  captureAction = null;
  const el = $('settings');
  if (!el) return;
  el.classList.toggle('hide', !open);
  if (open) {
    renderKeyRows();
    $('setSens').value = String(userCfg.sens);
    $('setSensVal').textContent = userCfg.sens.toFixed(1) + '×';
    $('setTouchUI').textContent = userCfg.touchUI ? '开' : '关';
    if (document.pointerLockElement) document.exitPointerLock();
  } else if (started) lockPointer();
}

/* ============================================================ 多世界存档 */
const INDEX_KEY = 'blockwild_index_v1';
const worldKey = id => 'blockwild_world_' + id;
let worlds = [];                 // [{id,name,mode,seed,updated}]
let currentId = null;
let MODE = 'survival';           // 'survival' | 'creative'
const isCreative = () => MODE === 'creative';

function hashString(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
function escHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function saveIndex() {
  try { localStorage.setItem(INDEX_KEY, JSON.stringify({ lastId: currentId, worlds })); } catch (e) {}
}
function loadIndex() {
  worlds = []; currentId = null;
  try {
    const raw = localStorage.getItem(INDEX_KEY);
    if (raw) { const d = JSON.parse(raw); worlds = Array.isArray(d.worlds) ? d.worlds : []; currentId = d.lastId || null; }
  } catch (e) { worlds = []; }
  // 老版本单存档 → 自动迁移成一个世界
  if (!worlds.length) {
    const old = localStorage.getItem(CFG.SAVE_KEY);
    if (old) {
      try {
        const d = JSON.parse(old);
        if (d && d.seed) {
          const id = 'w' + Date.now().toString(36);
          localStorage.setItem(worldKey(id), old);
          worlds.push({ id, name: '我的旧世界', mode: 'survival', seed: d.seed, updated: Date.now(), seedText: String(d.seed) });
          currentId = id;
          localStorage.removeItem(CFG.SAVE_KEY);
          saveIndex();
        }
      } catch (e) {}
    }
  }
  if (!worlds.find(w => w.id === currentId)) currentId = worlds[0] ? worlds[0].id : null;
}
function worldMeta(id) { return worlds.find(w => w.id === id) || null; }
function createWorld(opts = {}) {
  const id = 'w' + Date.now().toString(36) + Math.floor(Math.random() * 999);
  const seedText = (opts.seedText || '').trim();
  let seed;
  if (seedText) seed = /^[+-]?[0-9]+$/.test(seedText) ? (parseInt(seedText, 10) | 0) : (hashString(seedText) | 0);
  else seed = (Math.random() * 1e6) | 0;
  const w = {
    id, name: (opts.name || '').trim() || `世界 ${worlds.length + 1}`,
    mode: opts.mode === 'creative' ? 'creative' : 'survival',
    seed, seedText, updated: Date.now(),
  };
  worlds.push(w); currentId = id; saveIndex();
  return w;
}
function deleteWorld(id) {
  const wasCurrent = id === currentId;
  worlds = worlds.filter(w => w.id !== id);
  try { localStorage.removeItem(worldKey(id)); } catch (e) {}
  if (wasCurrent) {
    currentId = null;                 // 正在玩的世界被删了：停止自动存档，回世界列表
    saveIndex();
    if (started) { location.reload(); return; }
  }
  if (!currentId) currentId = worlds[0] ? worlds[0].id : null;
  saveIndex();
}

let saveSoonT = 0, saveErr = null, saveWarned = false;
function save() {
  if (!currentId || !started) return;
  try {
    const data = {
      seed: SEED, mode: MODE, time: worldTime,
      player: { x: player.p.x, y: player.p.y, z: player.p.z, yaw: player.yaw, pitch: player.pitch, hp: player.hp, hunger: player.hunger },
      inv, edits: Array.from(edits.entries()), spawn: player.spawn, armor: player.armor, chests: Array.from(chestInv.entries()),
      compost: Array.from(compostProg.entries()), meta: Array.from(blockMeta.entries()),
    };
    localStorage.setItem(worldKey(currentId), JSON.stringify(data));
    saveErr = null;
    const meta = worldMeta(currentId);
    if (meta) { meta.updated = Date.now(); saveIndex(); }
  } catch (e) {
    // 配额满/隐私模式：存档静默失败会让人以为进度还在，必须让玩家看见
    saveErr = String((e && e.message) || e);
    if (!saveWarned) { saveWarned = true; toast('存档写入失败（浏览器空间已满）：先去世界列表删掉不用的世界', 7); }
  }
}
function saveSoon() { clearTimeout(saveSoonT); saveSoonT = setTimeout(save, 600); }
function loadSave(id) {
  try {
    const raw = localStorage.getItem(worldKey(id));
    if (!raw) return false;
    const d = JSON.parse(raw);
    if (!d || !d.seed) return false;
    SEED = d.seed;
    worldTime = d.time || 0;
    inv = new Array(SLOTS).fill(null);
    (d.inv || []).filter(s => s && isItem(s.id) && s.n > 0).forEach((s, i) => { if (i < SLOTS) inv[i] = { id: s.id, n: s.n, d: s.d }; });
    player.spawn = d.spawn || null;
    if (d.armor) for (const s of ARMOR_SLOTS) player.armor[s] = ITEMS[d.armor[s]] ? d.armor[s] : null;
    compostProg.clear();
    if (Array.isArray(d.compost)) for (const e of d.compost) if (Array.isArray(e)) compostProg.set(e[0], e[1] | 0);
    if (Array.isArray(d.chests)) for (const entry of d.chests) {
      if (!Array.isArray(entry) || !Array.isArray(entry[1])) continue;   // 兼容旧存档
      chestInv.set(entry[0], entry[1].map(s => (s && isItem(s.id) && s.n > 0) ? { id: s.id, n: s.n } : null));
    }
    for (const [k, v] of (d.edits || [])) edits.set(k, v);
    reindexEdits();
    blockMeta.clear();
    if (Array.isArray(d.meta)) for (const e of d.meta) if (Array.isArray(e)) blockMeta.set(e[0], e[1]);
    if (d.player) {
      player.p.set(d.player.x, d.player.y, d.player.z);
      player.yaw = d.player.yaw || 0; player.pitch = d.player.pitch || 0;
      player.hp = d.player.hp ?? 20; player.hunger = d.player.hunger ?? 20;
    }
    return true;
  } catch (e) { return false; }
}

/* ============================================================ 帧循环 */
function frame(now) {
  const __ft = lastFrameAt ? (now - lastFrameAt) : 16.7;
  lastFrameAt = now;
  noteFrameMs(__ft);
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

/* ============================================================ 世界列表 UI */
function fmtTime(ts) {
  const d = new Date(ts || Date.now()), p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
function renderWorldList() {
  const box = $('worldList');
  if (!box) return;
  if ($('worldCount')) $('worldCount').textContent = `${worlds.length} 个`;
  box.innerHTML = '';
  if (!worlds.length) {
    box.innerHTML = '<p style="color:#8ea3ba;font-size:12px;margin:8px 0">还没有世界，点下面「创建新世界」开始。</p>';
    return;
  }
  const sorted = worlds.slice().sort((a, b) => (b.updated || 0) - (a.updated || 0));
  for (const w of sorted) {
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:10px;padding:10px 12px;margin:6px 0;background:#16202e;border:2px solid #27384a;border-radius:8px';
    const info = document.createElement('div');
    info.innerHTML = `<b style="color:#e8f0f8;font-size:13px">${escHtml(w.name)}</b>`
      + `<div style="color:#8ea3ba;font-size:11px;margin-top:3px">${w.mode === 'creative' ? '创造' : '生存'}`
      + ` · 种子 ${escHtml(w.seedText || w.seed)} · ${fmtTime(w.updated)}</div>`;
    const btns = document.createElement('div');
    btns.style.cssText = 'display:flex;gap:6px;flex-shrink:0';
    const play = document.createElement('button');
    play.className = 'btn gold'; play.textContent = '进入';
    play.onclick = () => { currentId = w.id; saveIndex(); startGame(w); };
    const del = document.createElement('button');
    del.className = 'btn'; del.textContent = '删除';
    del.onclick = () => {
      if (!confirm(`删除世界「${w.name}」？存档不可恢复。`)) return;
      deleteWorld(w.id); renderWorldList();
    };
    btns.appendChild(play); btns.appendChild(del);
    row.appendChild(info); row.appendChild(btns);
    box.appendChild(row);
  }
}
function setCreateMode(m) {
  createMode = m === 'creative' ? 'creative' : 'survival';
  $('modeSurvival').style.outline = createMode === 'survival' ? '2px solid #f5c451' : 'none';
  $('modeCreative').style.outline = createMode === 'creative' ? '2px solid #f5c451' : 'none';
  $('modeDesc').textContent = createMode === 'creative'
    ? '创造：不会受伤、不会饿、秒破方块、方块无限，连按两次空格可以飞行。'
    : '生存：会被怪打、会饿、要合成装备，挖到的资源要靠近才能捡起。';
}

/* ============================================================ 启动 */
function startGame(world) {
  if (started) return;
  currentId = world.id;
  MODE = world.mode === 'creative' ? 'creative' : 'survival';
  SEED = world.seed | 0;
  const loaded = loadSave(world.id);          // 有存档就接着玩，没有就用这个世界自己的种子生成
  if (!loaded) {
    const sp = spawnNearHouse(findSpawn());
    player.p.set(sp.x, sp.y, sp.z);
    if (sp.yaw !== undefined) { player.yaw = sp.yaw; player.pitch = -0.06; }
    player.spawn = { x: sp.x, y: sp.y, z: sp.z, bed: false };
    player.hp = 20; player.hunger = 20;
    inv = new Array(SLOTS).fill(null);
    if (isCreative()) { addItem(9, 64); addItem(8, 64); addItem(6, 32); addItem(10, 1); addItem(104, 64); }
    else { addItem(10, 1); addItem(105, 2); addItem(8, 8); }
    worldTime = CFG.DAY * 0.03;
  }
  player.fly = isCreative();
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
  toast(`「${world.name}」· ${isCreative() ? '创造模式' : '生存模式'} · 按 E 打开背包`, 4.5);
  lockPointer();
  window.__BW_STARTED = true;
}

$('btnNewWorld').onclick = () => {
  $('wName').value = `世界 ${worlds.length + 1}`;
  $('wSeed').value = '';
  setCreateMode('survival');
  $('createPanel').classList.remove('hide');
};
$('btnCancelCreate').onclick = () => $('createPanel').classList.add('hide');
$('modeSurvival').onclick = () => setCreateMode('survival');
$('modeCreative').onclick = () => setCreateMode('creative');
$('btnCreate').onclick = () => {
  const w = createWorld({ name: $('wName').value, mode: createMode, seedText: $('wSeed').value });
  $('createPanel').classList.add('hide');
  startGame(w);
};
$('btnReset').onclick = () => { save(); location.reload(); };   // 回世界列表
loadCfg();
applyTouchUI();
$('btnSettings').onclick = () => openSettings(true);
$('btnSettings2').onclick = () => openSettings(true);
$('btnCloseSettings').onclick = () => openSettings(false);
$('setSens').oninput = () => {
  userCfg.sens = +$('setSens').value;
  $('setSensVal').textContent = userCfg.sens.toFixed(1) + '×';
  saveCfg();
};
$('setTouchUI').onclick = () => {
  userCfg.touchUI = !userCfg.touchUI;
  $('setTouchUI').textContent = userCfg.touchUI ? '开' : '关';
  applyTouchUI(); saveCfg();
  toast(userCfg.touchUI ? '虚拟按键：开（鼠标按住拖动可转视角）' : '虚拟按键：关', 2);
};
$('btnResetKeys').onclick = () => {
  keymap = { ...DEFAULT_KEYS };
  saveCfg(); renderKeyRows();
  toast('键位已恢复默认', 1.6);
};
STRUCT_TYPES.push(
  { name: 'village', cell: VS_CELL, get: villageFor, cache: villageCache },
  { name: 'haunted', cell: HS_CELL, get: hauntedFor, cache: hsCache },
  { name: 'tower', cell: TW_CELL, get: towerFor, cache: towerCache },
  { name: 'well', cell: WL_CELL, get: wellFor, cache: wellCache },
  { name: 'circle', cell: SC_CELL, get: circleFor, cache: circleCache },
  { name: 'camp', cell: CP_CELL, get: campFor, cache: campCache },
  { name: 'cabin', cell: CB_CELL, get: cabinFor, cache: cabinCache },
);
loadIndex();
renderWorldList();
$('btnBag').onclick = () => openPanel(!panelOpen);
$('btnClose').onclick = () => openPanel(false);
$('btnFurnaceClose').onclick = () => closeFurnace();
$('btnChestClose').onclick = () => closeChest();
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
    oreVeins,
    oreStats() {                                     // 统计已加载区块里的矿石分布
      const cnt = { 13: 0, 15: 0, 20: 0 }, ys = { 13: [99, 0], 15: [99, 0], 20: [99, 0] };
      for (const ch of chunks.values()) {
        const b = ch.blocks, CH = CFG.CH, WH = CFG.WH;
        for (let y = 0; y < WH; y++) for (let i = 0; i < CH * CH; i++) {
          const id = b[(y * CH * CH) + i];
          if (id !== 13 && id !== 15 && id !== 20) continue;
          cnt[id]++;
          if (y < ys[id][0]) ys[id][0] = y;
          if (y > ys[id][1]) ys[id][1] = y;
        }
      }
      return { chunks: chunks.size, counts: cnt, yRange: ys };
    },
  icons: { armR, armL, handScene, solidMat, waterMat, scene, camera, handCam, renderer, crackMesh, crackTex, heldGroup },
  debug: {
    start(fresh = false) {
      if (!started) {
        let w = fresh ? null : worldMeta(currentId);
        if (!w) w = createWorld({ name: fresh ? '调试世界' : (worldMeta(currentId) ? worldMeta(currentId).name : '调试世界'), mode: 'survival' });
        startGame(w);
      }
      return started;
    },
    startCreative() {
      if (!started) startGame(createWorld({ name: '调试·创造', mode: 'creative' }));
      return started;
    },
    worlds: () => worlds.map(w => ({ id: w.id, name: w.name, mode: w.mode, seed: w.seed, seedText: w.seedText, updated: w.updated })),
    createWorld: (opts) => createWorld(opts),
    deleteWorld: (id) => deleteWorld(id),
    startWorld: (id) => { const w = worldMeta(id); if (!w) return false; startGame(w); return true; },
    currentWorld: () => ({ id: currentId, mode: MODE, seed: SEED, name: worldMeta(currentId) ? worldMeta(currentId).name : null }),
    fly: (on) => { player.fly = on === undefined ? !player.fly : !!on; return player.fly; },
    mode: () => MODE,
    save: () => { save(); return { err: saveErr, size: (localStorage.getItem(worldKey(currentId)) || '').length }; },
    saveError: () => ({ err: saveErr, warned: saveWarned }),
    esc: (s) => escHtml(s),
    storage: () => Object.keys(localStorage),
    steps(n = 60) { for (let i = 0; i < n; i++) { update(STEP); } },
    look(yaw, pitch) { player.yaw = yaw; player.pitch = pitch; },
    tp(x, y, z) { player.p.set(x, y, z); player.v.set(0, 0, 0); },
    give(id, n = 1) { addItem(id, n); renderHotbar(); refreshHeld(); },
    clearInv() { inv = new Array(SLOTS).fill(null); renderHotbar(); refreshHeld(); },
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
    mobKinds: () => { const o = {}; for (const m of mobs) if (!m.dying) o[m.kind] = (o[m.kind] || 0) + 1; return o; },
    spawnAt: (kind, dx, dz) => { const x = Math.floor(player.p.x + dx), z = Math.floor(player.p.z + dz); const m = spawnMobAt(kind, x, surfaceY(x, z) + 1, z); return m ? [kind, +m.p.x.toFixed(1), +m.p.y.toFixed(1)] : null; },
    villages: (r = 2) => {
      const pcx = Math.floor(player.p.x / VS_CELL), pcz = Math.floor(player.p.z / VS_CELL);
      const out = [];
      for (let dx = -r; dx <= r; dx++) for (let dz = -r; dz <= r; dz++) {
        const v = villageFor(pcx + dx, pcz + dz);
        if (v) out.push({ cx: v.cx, cz: v.cz, gy: v.gy, houses: v.houses, ops: v.ops });
      }
      return out;
    },
    gotoVillage: () => {
      const v = nearestVillage(400);
      if (!v) return null;
      player.p.set(v.cx + 0.5, v.gy + 2, v.cz + 0.5);
      player.v.set(0, 0, 0);
      camSmoothY = null;
      return v;
    },
    chestAt: (x, y, z) => openChest(x, y, z),
    seedHouse: (seed) => {              // 扫种子：出生点 → 最近鬼屋
      SEED = seed | 0;
      hsCache.clear(); villageCache.clear(); veinCache.clear();
      if (typeof ravineCache !== 'undefined' && ravineCache.clear) ravineCache.clear();
      const sp = findSpawn();
      const cx = Math.floor(sp.x / HS_CELL), cz = Math.floor(sp.z / HS_CELL);
      let best = null;
      for (let dx = -2; dx <= 2; dx++) for (let dz = -2; dz <= 2; dz++) {
        const hs = hauntedFor(cx + dx, cz + dz);
        if (!hs) continue;
        const d = Math.round(Math.hypot(sp.x - hs.cx, sp.z - hs.cz));
        if (!best || d < best.d) best = { d, hx: hs.cx, hz: hs.cz, y0: hs.y0, floors: hs.floors };
      }
      return { seed: SEED, spawn: sp, house: best };
    },
    structs: (r = 3) => {
      const px = player.p.x, pz = player.p.z, out = [];
      for (const t of STRUCT_TYPES) {
        const cx = Math.floor(px / t.cell), cz = Math.floor(pz / t.cell);
        for (let dx = -r; dx <= r; dx++) for (let dz = -r; dz <= r; dz++) {
          const o = t.get(cx + dx, cz + dz);
          if (o) out.push({ type: t.name, label: o.label || t.name, cx: o.cx, cz: o.cz, gy: o.gy, ops: o.ops, dist: Math.round(Math.hypot(o.cx - px, o.cz - pz)) });
        }
      }
      return out.sort((a, b) => a.dist - b.dist);
    },
    gotoStruct: (type) => {
      const t = STRUCT_TYPES.find(x => x.name === type);
      if (!t) return null;
      const cx = Math.floor(player.p.x / t.cell), cz = Math.floor(player.p.z / t.cell);
      for (let r = 0; r <= 4; r++) for (let dx = -r; dx <= r; dx++) for (let dz = -r; dz <= r; dz++) {
        const o = t.get(cx + dx, cz + dz);
        if (!o) continue;
        player.p.set(o.cx + 0.5, (o.gy || 40) + 2, o.cz + 12.5);
        player.v.set(0, 0, 0);
        const ccx = Math.floor(o.cx / CFG.CH), ccz = Math.floor(o.cz / CFG.CH);
        for (let a = -2; a <= 2; a++) for (let bb = -2; bb <= 2; bb++) buildChunk(getChunk(ccx + a, ccz + bb));
        return { type: t.name, cx: o.cx, cz: o.cz, gy: o.gy, ops: o.ops };
      }
      return null;
    },
    haunted: (r = 2) => {
      const pcx = Math.floor(player.p.x / HS_CELL), pcz = Math.floor(player.p.z / HS_CELL);
      const out = [];
      for (let dx = -r; dx <= r; dx++) for (let dz = -r; dz <= r; dz++) {
        const hs = hauntedFor(pcx + dx, pcz + dz);
        if (hs) out.push({ cx: hs.cx, cz: hs.cz, y0: hs.y0, floors: hs.floors, ops: hs.ops });
      }
      return out;
    },
    gotoHaunted: () => {
      const pcx = Math.floor(player.p.x / HS_CELL), pcz = Math.floor(player.p.z / HS_CELL);
      for (let rr = 0; rr <= 3; rr++) for (let dx = -rr; dx <= rr; dx++) for (let dz = -rr; dz <= rr; dz++) {
        const hs = hauntedFor(pcx + dx, pcz + dz);
        if (!hs) continue;
        player.p.set(hs.cx + 0.5, hs.y0 + 2, hs.cz + hs.D + 6.5);
        player.v.set(0, 0, 0); camSmoothY = null;
        const ccx = Math.floor(hs.cx / CFG.CH), ccz = Math.floor(hs.cz / CFG.CH);
        for (let a = -2; a <= 2; a++) for (let b = -2; b <= 2; b++) buildChunk(getChunk(ccx + a, ccz + b));
        return { cx: hs.cx, cz: hs.cz, y0: hs.y0, floors: hs.floors };
      }
      return null;
    },
    ravines: (r = 2) => {
      const pcx = Math.floor(player.p.x / RV_CELL), pcz = Math.floor(player.p.z / RV_CELL);
      const out = [];
      for (let dx = -r; dx <= r; dx++) for (let dz = -r; dz <= r; dz++) {
        const rv = ravineFor(pcx + dx, pcz + dz);
        if (rv) out.push({ x0: rv.minX, x1: rv.maxX, z0: rv.minZ, z1: rv.maxZ, pts: rv.n, water: rv.water,
                           depth: Math.round(rv.points.reduce((a, p) => a + (p.top - p.bot), 0) / rv.n) });
      }
      return out;
    },
    gotoRavine: () => {
      const pcx = Math.floor(player.p.x / RV_CELL), pcz = Math.floor(player.p.z / RV_CELL);
      for (let rr = 0; rr <= 3; rr++) for (let dx = -rr; dx <= rr; dx++) for (let dz = -rr; dz <= rr; dz++) {
        const rv = ravineFor(pcx + dx, pcz + dz);
        if (!rv) continue;
        const pt = rv.points[Math.floor(rv.n / 2)];
        player.p.set(pt.x + 4.5, pt.top + 2, pt.z + 0.5); player.v.set(0, 0, 0); camSmoothY = null;
        const ccx = Math.floor(pt.x / CFG.CH), ccz = Math.floor(pt.z / CFG.CH);
        for (let a = -1; a <= 1; a++) for (let bb = -1; bb <= 1; bb++) buildChunk(getChunk(ccx + a, ccz + bb));
        return { x: pt.x, z: pt.z, top: pt.top, bot: pt.bot, w: pt.w, water: rv.water, span: pt.top - pt.bot };
      }
      return null;
    },
    water: (x, y, z, lvl) => { if (lvl === undefined) { setBlock(x, y, z, 5); } else setWater(x, y, z, lvl); wakeWater(x, y, z); },
    perf: () => ({
      frameMs: +frameMsAvg.toFixed(1), budgetMs: +perfBudget.toFixed(1),
      chunks: chunks.size, edits: edits.size,
      waterQueued: waterQueue.length - waterHead, flowing: waterFlow.size,
      mobs: mobs.length, drops: drops.length, arrows: arrows.length,
      geoms: renderer.info.memory.geometries, textures: renderer.info.memory.textures,
      calls: renderer.info.render.calls, tris: renderer.info.render.triangles,
      heapMB: performance.memory ? +(performance.memory.usedJSHeapSize / 1048576).toFixed(1) : null,
    }),
    waterInfo: () => ({ flowing: waterFlow.size, queued: waterQueue.length - waterHead }),
    cfg: () => ({ sens: userCfg.sens, touchUI: userCfg.touchUI, keys: { ...keymap } }),
    setKey: (act, code) => { if (!DEFAULT_KEYS[act]) return false; keymap[act] = code; saveCfg(); renderKeyRows(); return true; },
    press: (code) => { keys.add(code); return true; },
    release: (code) => { keys.delete(code); if (code === keymap.mine) mineHeld = false; },
    useHeld: () => {                            // 等价于右键（探针用，绕开 pointer lock）
      const h = held(), t = raycastVoxel(eyePos(), cameraDir(), CFG.REACH);
      if (h && h.id === 153) return firePlayerArrow();
      if (h && ITEMS[h.id] && ITEMS[h.id].kind === 'hoe') return useHoe(t);
      if (h && h.id === 156) return plantSeed(t);
      if (h && h.id === 157) return useFertilizer(t);
      if (h && t && BLOCKS[t.id] && BLOCKS[t.id].compost) return useCompost(t);
      if (h && h.id === 152) return useBucket(true, t);
      if (h && h.id === 151) return useBucket(false, t);
      return null;
    },
    waterLevel: (x, y, z) => flowLvl(x, y, z),
    waterTop: (x, y, z) => waterTopH(x, y, z),
    scrub: () => { scrubWaterNear(9); return true; },
    waterCells: (r = 6) => {
      const px = Math.floor(player.p.x), py = Math.floor(player.p.y), pz = Math.floor(player.p.z);
      let n = 0, list = [];
      for (let dx = -r; dx <= r; dx++) for (let dz = -r; dz <= r; dz++) for (let y = py - r; y <= py + r; y++) {
        if (getBlock(px + dx, y, pz + dz) === 5) { n++; if (list.length < 6) list.push([px + dx, y, pz + dz]); }
      }
      return { count: n, list };
    },
    stepWater: (n = 40) => { for (let i = 0; i < n; i++) updateWater(48); return waterFlow.size; },
    drops: () => drops.map(d => ({ id: d.id, name: nameOf(d.id), n: d.n, t: +d.t.toFixed(2), y: +d.p.y.toFixed(2), dist: +d.p.distanceTo(player.p).toFixed(2) })),
    dropCount: () => drops.length,
    spawnDrop: (id, n) => spawnDrop(id, n, player.p.x + 1.2, player.p.y + 1.2, player.p.z),
    stepDrops: (n = 1) => { for (let i = 0; i < n; i++) updateDrops(1 / 60); },
    smeltIdx: (i) => smelt(SMELT[i]),
    fuel: () => fuelCount(),
    inVillage: (x, z) => inVillage(x, z),
    leavesInVillages: (r = 1) => {
      const pcx = Math.floor(player.p.x / VS_CELL), pcz = Math.floor(player.p.z / VS_CELL);
      let total = 0, perVillage = [];
      for (let dx = -r; dx <= r; dx++) for (let dz = -r; dz <= r; dz++) {
        const v = villageFor(pcx + dx, pcz + dz);
        if (!v) continue;
        let n = 0;
        for (let x = v.minX; x <= v.maxX; x++) for (let z = v.minZ; z <= v.maxZ; z++)
          for (let y = v.gy - 2; y < v.gy + 14; y++) if (getBlock(x, y, z) === 7) n++;
        perVillage.push({ cx: v.cx, cz: v.cz, leaves: n });
        total += n;
      }
      return { total, perVillage };
    },
    furnaceOpen: () => !$('furnace').classList.contains('hide'),
    openFurnace: () => openFurnace(),
    openedChestCount: () => chestInv.size,
    chestContents: () => openChestPos ? chestSlots(openChestPos.x, openChestPos.y, openChestPos.z).map(s => s ? s.id + ':' + s.n : null) : null,
    cursor: () => cursor,
    clickChestSlot: (i) => { if (!openChestPos) return null; slotClick(chestSlots(openChestPos.x, openChestPos.y, openChestPos.z), i); return cursor; },
    clickInvSlot: (i) => { slotClick(inv, i); return cursor; },
    clickArmorSlot: (s) => { const el = $('armorGrid').children[ARMOR_SLOTS.indexOf(s)]; if (el) el.click(); return cursor; },
    closeChest: () => closeChest(),
    chestOpen: () => !!openChestPos,
    findBlockAny: (id, r = 40) => {
      const px = Math.floor(player.p.x), pz = Math.floor(player.p.z);
      for (let d = 0; d < r; d++) for (let dx = -d; dx <= d; dx++) for (let dz = -d; dz <= d; dz++) {
        if (Math.max(Math.abs(dx), Math.abs(dz)) !== d) continue;
        for (let y = CFG.WH - 1; y > 0; y--) if (getBlock(px + dx, y, pz + dz) === id) return [px + dx, y, pz + dz];
      }
      return null;
    },
    mobsInfo: () => mobs.map(m => ({
      kind: m.kind, hp: m.hp, dying: m.dying, dieT: +m.dieT.toFixed(2), scale: +m.obj.scale.x.toFixed(3),
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
