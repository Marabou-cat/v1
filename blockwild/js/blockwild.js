// BLOCKWILD — 方块荒野
// 单页体素生存：程序化地形（草/土/石/沙/水/树）、挖掘与放置、合成、第一人称手臂、昼夜与夜行怪。
import * as THREE from '../vendor/three.module.js';

/* ============================================================ CFG */
var NET = null;                          // 联机层（P0）：默认 null = 单机，行为完全不变
const CFG = {
  CH: 16, WH: 192, SEA: 98,          // WH 64→192、SEA 26→98：配合下面的 SURF_OFF，主世界深度从 ~40 格变成 ~112 格
  LOAD_R: 5, UNLOAD_R: 8,
  GRAV: 27, JUMP: 8.5, WALK: 4.7, SPRINT: 6.9,
  REACH: 6, DAY: 300, MAX_MOBS: 6, SAVE_KEY: 'blockwild_save_v1',
  EYE: 1.62, HW: 0.3, PH: 1.78,
};

/* ============================================================ 噪声 */
let SEED = (() => {                          // 支持 ?seed=12345 直接用指定种子开新世界
  const m = location.search.match(/[?&]seed=(-?\d+)/);
  return m ? (parseInt(m[1], 10) | 0) : ((Math.random() * 1e6) | 0);
})();
/* ── 维度：'overworld' | 'nether'（冥界）。冥界放在 +1,000,000 的世界坐标里，
   区块/存档天然分开（不会和主世界撞），切换时只换 DIM + 清空区块缓存。 */
let DIM = 'overworld';
const NETHER_OFF = 1000000;
let portalCd = 0, lavaT = 0;
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
const SURF_OFF = 72;                  // 地表整体抬高：脚下到基岩的深度从 ~40 格 → ~112 格
const DEEP_Y = SURF_OFF - 14;         // 这层以下换成深板岩（底部的深板岩层，钻石只在这里）
const MOUNT_Y = SURF_OFF + 45;        // 高出这个高度就是裸岩山峰
function heightAt(x, z) {
  // fbm 会把方差压得很小，先以 0.5 为中心放大对比度，才能得到真正起伏的地形
  const cont = clamp01(0.5 + (fbm2(x * 0.011, z * 0.011, 4) - 0.5) * 2.8);
  const hill = clamp01(0.5 + (fbm2(x * 0.047 + 13.7, z * 0.047 - 7.1, 3) - 0.5) * 2.4);
  return SURF_OFF + Math.floor(15 + cont * 30 + hill * 7);
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
  7: { name: '树叶', top: 7, side: 7, bottom: 7, hard: 0.22, drop: 0, leaf: true, hollow: true },
  8: { name: '木板', top: 8, side: 8, bottom: 8, hard: 0.65, drop: 8 },
  9: { name: '圆石', top: 9, side: 9, bottom: 9, hard: 1.9, drop: 9, pick: true },
  10: { name: '工作台', top: 11, side: 12, bottom: 8, hard: 0.8, drop: 10 },
  13: { name: '煤矿石', top: 13, side: 13, bottom: 13, hard: 2.2, drop: 13, pick: true },
  14: { name: '床', top: 14, side: 15, bottom: 8, hard: 0.6, drop: 14, bed: true, half: 0.45 },
  15: { name: '铁矿石', top: 16, side: 16, bottom: 16, hard: 2.6, drop: 15, pick: true, stonePick: true },
  16: { name: '农田', top: 17, side: 2, bottom: 2, hard: 0.5, drop: 2 },
  17: { name: '小麦', top: 18, side: 18, bottom: 18, hard: 0.12, drop: 107, crop: true, plant: true, mature: true, cross: true, crossH: 0.95 },
  23: { name: '小麦幼苗', top: 26, side: 26, bottom: 26, hard: 0.1, drop: 156, plant: true, stage: 0, cross: true, crossH: 0.38 },
  24: { name: '小麦苗', top: 27, side: 27, bottom: 27, hard: 0.1, drop: 156, plant: true, stage: 1, cross: true, crossH: 0.66 },
  25: { name: '堆肥箱', top: 28, side: 29, bottom: 8, hard: 0.9, drop: 25, compost: true },
  26: { name: '花岗岩', top: 30, side: 30, bottom: 30, hard: 2.6, drop: 26, pick: true },
  27: { name: '石灰岩', top: 31, side: 31, bottom: 31, hard: 1.9, drop: 27, pick: true },
  28: { name: '云杉原木', top: 33, side: 32, bottom: 33, hard: 1.5, drop: 28, log: true },
  29: { name: '云杉木板', top: 34, side: 34, bottom: 34, hard: 1.2, drop: 29 },
  30: { name: '白桦原木', top: 36, side: 35, bottom: 36, hard: 1.5, drop: 30, log: true },
  31: { name: '白桦木板', top: 37, side: 37, bottom: 37, hard: 1.2, drop: 31 },
  33: { name: '石砖楼梯', top: 24, side: 24, bottom: 24, hard: 2.1, drop: 33, pick: true, stair: true },
  34: { name: '木板楼梯', top: 8, side: 8, bottom: 8, hard: 1.2, drop: 34, stair: true },
  35: { name: '木门', top: 40, side: 40, bottom: 40, hard: 0.6, drop: 35, door: true },
  36: { name: '草丛', top: 42, side: 42, bottom: 42, hard: 0.05, drop: 0, plant: true, cross: true },
  37: { name: '红花', top: 43, side: 43, bottom: 43, hard: 0.05, drop: 37, plant: true, cross: true },
  39: { name: '铜矿石', top: 45, side: 45, bottom: 45, hard: 2.4, drop: 39, pick: true },
  40: { name: '木头加工器', top: 46, side: 46, bottom: 8, hard: 1.1, drop: 40, processor: true },
  // ── 传送门（结构）+ 冥界方块 ──
  41: { name: '传送门框', top: 47, side: 47, bottom: 47, hard: 9, drop: 0, frame: true, unbreakable: true },
  42: { name: '传送门', top: 48, side: 48, bottom: 48, hard: 0, drop: 0, cross: true, plant: true, portal: true, unbreakable: true, crossH: 0.99 },
  45: { name: '传送门核心', top: 47, side: 47, bottom: 47, hard: 9, drop: 0, core: true, unbreakable: true },
  43: { name: '冥界岩', top: 49, side: 49, bottom: 49, hard: 1.6, drop: 43, pick: true },
  44: { name: '岩浆', top: 50, side: 50, bottom: 50, hard: 0, drop: 0, lava: true, liquid: true },
  46: { name: '冥界碳矿', top: 51, side: 51, bottom: 51, hard: 2.8, drop: 177, pick: true, stonePick: true },
  47: { name: '液压机', top: 52, side: 52, bottom: 52, hard: 2.4, drop: 47, pick: true, press: true },
  48: { name: '灵魂沙', top: 53, side: 53, bottom: 53, hard: 0.6, drop: 48 },
  49: { name: '玄武岩', top: 54, side: 54, bottom: 54, hard: 2.2, drop: 49, pick: true },
  50: { name: '深板岩', top: 55, side: 55, bottom: 55, hard: 3.0, drop: 50, pick: true },
  51: { name: '基岩', top: 56, side: 56, bottom: 56, hard: 999, drop: 0, unbreakable: true },
  38: { name: '火把', top: 44, side: 44, bottom: 44, hard: 0.05, drop: 38, plant: true, cross: true, crossH: 0.92, torch: true },
  18: { name: '箱子', top: 20, side: 19, bottom: 19, hard: 0.9, drop: 18, chest: true },
  19: { name: '熔炉', top: 22, side: 21, bottom: 21, hard: 1.3, drop: 19, furnace: true },
  20: { name: '钻石矿石', top: 23, side: 23, bottom: 23, hard: 3.6, drop: 125, pick: true, stonePick: true, ironPick: true },
  21: { name: '石砖', top: 24, side: 24, bottom: 24, hard: 2.1, drop: 21, pick: true },
  22: { name: '玻璃', top: 25, side: 25, bottom: 25, hard: 0.4, drop: 22, glass: true },
  // ── 电路 / 能量：铀矿 →（充电器）→ 能量炮 ──
  52: { name: '铀矿石', top: 57, side: 57, bottom: 57, hard: 4.0, drop: 187, pick: true, stonePick: true, ironPick: true },
  53: { name: '充电器', top: 58, side: 59, bottom: 21, hard: 1.8, drop: 53, charger: true },
  // ── 熔岩沼泽：冥界树 + 缠魂藤 + 沼泽泥 ──
  54: { name: '冥血木', top: 61, side: 60, bottom: 61, hard: 1.8, drop: 54, pick: true },
  55: { name: '冥血叶', top: 62, side: 62, bottom: 62, hard: 0.2, drop: 0, leaf: true, hollow: true },
  56: { name: '灰烬木', top: 61, side: 63, bottom: 61, hard: 1.8, drop: 56, pick: true },
  57: { name: '灰烬叶', top: 64, side: 64, bottom: 64, hard: 0.2, drop: 0, leaf: true, hollow: true },
  58: { name: '缠魂藤', top: 65, side: 65, bottom: 65, hard: 0.1, drop: 0, cross: true, plant: true, crossH: 0.9, vine: true },
  59: { name: '沼泽泥', top: 66, side: 66, bottom: 66, hard: 0.8, drop: 59 },
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
  145: { name: '生羊肉', kind: 'food', food: 4 },
  146: { name: '熟羊肉', kind: 'food', food: 8 },
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
  161: { name: '骨粉', kind: 'bonemeal' },
  162: { name: '铜锭', kind: 'mat' },
  163: { name: '铜镐', kind: 'pick', fast: 2.2, dur: 190 },
  164: { name: '铜剑', kind: 'sword', dmg: 8, dur: 190 },
  165: { name: '铜锄', kind: 'hoe', dur: 190 },
  166: { name: '铜头盔', kind: 'armor', slot: 'head', ap: 2 },
  167: { name: '铜胸甲', kind: 'armor', slot: 'chest', ap: 5 },
  168: { name: '铜护腿', kind: 'armor', slot: 'legs', ap: 3 },
  169: { name: '铜靴', kind: 'armor', slot: 'feet', ap: 2 },
  170: { name: '木片', kind: 'mat' },
  171: { name: '木头盔', kind: 'armor', slot: 'head', ap: 1 },
  172: { name: '木胸甲', kind: 'armor', slot: 'chest', ap: 3 },
  173: { name: '木护腿', kind: 'armor', slot: 'legs', ap: 2 },
  174: { name: '木靴', kind: 'armor', slot: 'feet', ap: 1 },
  175: { name: '传送块', kind: 'mat' },
  176: { name: '冥火碎片', kind: 'mat' },
  177: { name: '冥界碳', kind: 'mat' },
  178: { name: '冥界钢', kind: 'mat' },
  // ── 冥界钢装备：比钻石强一档（MC 下界合金的定位） ──
  179: { name: '冥界钢剑', kind: 'sword', dmg: 16, dur: 2031 },
  180: { name: '冥界钢头盔', kind: 'armor', slot: 'head', ap: 4 },
  181: { name: '冥界钢胸甲', kind: 'armor', slot: 'chest', ap: 9 },
  182: { name: '冥界钢护腿', kind: 'armor', slot: 'legs', ap: 7 },
  183: { name: '冥界钢靴', kind: 'armor', slot: 'feet', ap: 4 },
  184: { name: '冥界钢镐', kind: 'pick', fast: 4.2, dur: 2031 },
  // ── 电路系统：铜 → 电路板 / 电线 → 能量炮（4 档金属，dmg/cap/cd/speed 逐档递增）──
  185: { name: '电路板', kind: 'mat' },
  186: { name: '电线', kind: 'mat' },
  187: { name: '铀', kind: 'mat' },
  188: { name: '铜能量炮',   kind: 'gun', dmg: 8,  cap: 8,  cd: 0.50, speed: 48, boltColor: 0xffb066 },
  189: { name: '铁能量炮',   kind: 'gun', dmg: 12, cap: 10, cd: 0.45, speed: 54, boltColor: 0xbfe4ff },
  190: { name: '钻石能量炮', kind: 'gun', dmg: 17, cap: 12, cd: 0.40, speed: 60, boltColor: 0x7dffe8 },
  191: { name: '冥界钢能量炮', kind: 'gun', dmg: 22, cap: 14, cd: 0.35, speed: 66, boltColor: 0xc08cff },
  // ── 熔岩沼泽掉落 ──
  192: { name: '鳄鱼皮', kind: 'mat' },
  193: { name: '噩梦之心', kind: 'mat' },
  194: { name: '噩梦之刃', kind: 'sword', dmg: 26, dur: 2600 },
};
const isItem = id => !!BLOCKS[id] || !!ITEMS[id];
const defOf = id => BLOCKS[id] || ITEMS[id];
const nameOf = id => (defOf(id) || { name: '?' }).name;

let atlasCanvas = null, atlasTex = null;
// 瓦片序号 → 图集 (col,row)：4 列 × 10 行 = 0..39。
// ⚠ 原来是 4×8（只有 0..31），但 32~37 号瓦片（云杉/白桦）也在画，画到画布外 ⇒
// 采样被 clamp 到最底行，云杉/白桦方块显示成「堆肥箱/石灰岩」的花纹。
const ATLAS_COLS = 4, ATLAS_ROWS = 20;   // …56 基岩 57 铀矿 58~59 充电器 60~66 熔岩沼泽（4 列 × 20 行 = 80 格）
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
  // 26 小麦幼苗（透明底，矮）：三片小叶
  {
    const c = 26 % ATLAS_COLS, r = (26 / ATLAS_COLS) | 0;
    for (const [bx, h] of [[5, 5], [8, 6], [11, 4]]) {
      for (let k = 0; k < h; k++) px(c, r, bx, 15 - k, k > h - 2 ? '#6db544' : (bx === 8 ? '#4f8a33' : '#3f7a2a'));
      px(c, r, bx + (bx === 11 ? -1 : 1), 15 - (h >> 1), '#5fa03c');
    }
  }
  // 27 小麦苗：更高的绿秆 + 小穗
  // 27 小麦苗（透明底，中等高）：绿秆 + 叶
  {
    const c = 27 % ATLAS_COLS, r = (27 / ATLAS_COLS) | 0;
    for (const x of [4, 8, 12]) {
      for (let y = 4; y < 16; y++) { px(c, r, x, y, '#4f8a33'); px(c, r, x + 1, y, '#5fa03c'); }
      px(c, r, x - 1, 9, '#6db544'); px(c, r, x + 2, 11, '#6db544');
    }
  }
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
  // 40 门板：竖纹木板 + 深色门框 + 中间横档
  T(40, '#a87a44', 0.04, (c, r) => {
    for (let x = 0; x < S; x++) {
      const edge = x === 0 || x === 15;
      for (let y = 0; y < S; y++) {
        if (edge) { px(c, r, x, y, '#6a4a20'); continue; }
        if (x === 4 || x === 11) { px(c, r, x, y, '#7d5729'); continue; }      // 两扇门的立缝
        if (y === 0 || y === 15) { px(c, r, x, y, '#7d5729'); continue; }      // 上下横档
        if (y === 7 || y === 8) { px(c, r, x, y, '#8d6534'); continue; }       // 中间横档
        const k = (x * 7 + y * 11) % 9;
        px(c, r, x, y, shade(k === 0 ? '#9c703c' : '#a87a44', 1));
      }
    }
  });
  // 41 铁件：门把手 / 合页
  T(41, '#c2c8d0', 0.05, (c, r) => {
    for (let y = 2; y < 14; y++) for (let x = 2; x < 14; x++) px(c, r, x, y, shade('#cdd3da', 0.96 + ((x + y) % 3) * 0.03));
    for (let x = 2; x < 14; x++) { px(c, r, x, 2, '#8b939c'); px(c, r, x, 13, '#8b939c'); }
  });
  // 42 草丛：透明底 + 几根草叶（十字面片用，靠 alphaTest 抠形）
  {
    const c = 42 % ATLAS_COLS, r = (42 / ATLAS_COLS) | 0;
    for (let i = 0; i < 6; i++) {
      const bx = Math.min(13, 2 + i * 2), hgt = 5 + ((i * 7) % 8);
      for (let k = 0; k < hgt; k++) {
        const y = 15 - k, x = Math.min(15, bx + (k > hgt * 0.6 && (i % 2) ? 1 : 0));
        px(c, r, x, y, k > hgt - 3 ? '#6db544' : (i % 2 ? '#3f7a2a' : '#4f8a33'));
      }
    }
  }
  // 43 红花：茎 + 叶 + 花瓣
  {
    const c = 43 % ATLAS_COLS, r = (43 / ATLAS_COLS) | 0;
    for (let y = 6; y < 16; y++) px(c, r, 8, y, '#3f7a2a');
    px(c, r, 7, 11, '#4f8a33'); px(c, r, 6, 10, '#4f8a33');
    px(c, r, 9, 12, '#4f8a33'); px(c, r, 10, 11, '#4f8a33');
    for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
      px(c, r, 8 + dx, 5 + dy, '#d8443f');
      px(c, r, 8 + dx * 2, 5 + dy * 2, '#b8322e');
    }
    px(c, r, 8, 5, '#ffe066');
  }
  // 44 火把：木杆 + 火焰（透明底，放在植物网格里用不受光材质 → 白天黑夜都亮）
  {
    const c = 44 % ATLAS_COLS, r = (44 / ATLAS_COLS) | 0;
    for (let y = 7; y < 16; y++) for (let x = 7; x <= 8; x++) px(c, r, x, y, x === 7 ? '#7a5330' : '#8d6039');
    px(c, r, 7, 8, '#5f3f24'); px(c, r, 8, 11, '#5f3f24');
    for (let y = 3; y < 7; y++) for (let x = 6; x <= 9; x++) px(c, r, x, y, y < 5 ? '#ffcf4a' : '#ff8a2b');
    px(c, r, 7, 2, '#ffe066'); px(c, r, 8, 2, '#fff0a8'); px(c, r, 7, 4, '#fff6d0'); px(c, r, 8, 5, '#ffffff');
  }
  // 45 铜矿石：石头底 + 橙绿色铜斑
  T(45, '#8f8f8f', 0.08, (c, r) => {
    for (let i = 0; i < 5; i++) {
      const bx = 2 + ((i * 5) % 11), by = 2 + ((i * 7) % 11);
      for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [2, 1], [1, 2]]) px(c, r, Math.min(15, bx + dx), Math.min(15, by + dy), (dx + dy) % 2 ? '#3fae8a' : '#d08a3c');
    }
  });
  // 46 木头加工器：木框 + 中间一圈锯片（右边按右键把原木削成木片）
  T(46, '#9a6b34', 0.05, (c, r) => {
    for (let x = 2; x < 15; x += 4) for (let y = 2; y < 14; y++) if ((y * 3 + x) % 7 < 5) px(c, r, x, y, '#7d5527');
    for (let x = 0; x < 16; x++) {
      px(c, r, x, 0, '#5e3f1c'); px(c, r, x, 1, '#6f4a20');
      px(c, r, x, 15, '#5e3f1c'); px(c, r, x, 14, '#6f4a20');
    }
    const cx2 = 7.5, cy2 = 7.5;
    for (let a = 0; a < 28; a++) {                       // 锯齿
      const ang = a / 28 * Math.PI * 2, rr = a % 2 ? 6.3 : 5.1;
      const x = Math.round(cx2 + Math.cos(ang) * rr), y = Math.round(cy2 + Math.sin(ang) * rr);
      if (x >= 0 && x < 16 && y >= 0 && y < 16) px(c, r, x, y, '#cfd6de');
    }
    for (let y = 5; y < 11; y++) for (let x = 5; x < 11; x++) px(c, r, x, y, (x + y) % 3 ? '#b9c1cb' : '#98a1ab');
    px(c, r, 7, 7, '#59616b'); px(c, r, 8, 8, '#59616b');
  });
  // 47 传送门框：深色金属板 + 青色电路（高科技）
  T(47, '#2b3240', 0.06, (c, r) => {
    for (let x = 0; x < 16; x++) { px(c, r, x, 0, '#5b6a80'); px(c, r, x, 15, '#12161d'); }
    for (let y = 0; y < 16; y++) { px(c, r, 0, y, '#465062'); px(c, r, 15, y, '#12161d'); }
    for (const y of [4, 11]) for (let x = 3; x < 13; x++) px(c, r, x, y, '#181d26');
    for (let x = 3; x < 13; x += 3) { px(c, r, x, 5, '#39e0d0'); px(c, r, x, 6, '#39e0d0'); px(c, r, x, 9, '#2aa89c'); px(c, r, x, 10, '#2aa89c'); }
    for (const [x, y] of [[7, 7], [8, 7], [7, 8], [8, 8]]) px(c, r, x, y, '#7ff3e8');
  });
  // 48 传送门：紫色能量面（四周留透明边 —— 十字面片靠 alphaTest 裁出来）
  {
    const c = 48 % ATLAS_COLS, r = (48 / ATLAS_COLS) | 0;
    for (let y = 1; y < 15; y++) for (let x = 1; x < 15; x++) {
      const k = ((x * 13 + y * 7) % 11) / 11;
      px(c, r, x, y, k > 0.62 ? '#c58bff' : k > 0.3 ? '#8b3fd8' : '#54208f');
    }
    for (const [x, y] of [[4, 4], [11, 5], [6, 11], [12, 12], [8, 7], [3, 9]]) px(c, r, x, y, '#f2d9ff');
  }
  // 49 冥界岩：暗红岩石 + 血色纹
  T(49, '#6b2b2b', 0.12, (c, r) => {
    for (let i = 0; i < 26; i++) {
      const x = (i * 5 + 3) % 16, y = (i * 11 + 1) % 16;
      px(c, r, x, y, i % 3 === 0 ? '#8d3a34' : '#4b1a1a');
    }
  });
  // 50 岩浆：发光橙红
  T(50, '#e0641a', 0.10, (c, r) => {
    for (let i = 0; i < 30; i++) {
      const x = (i * 7 + 2) % 16, y = (i * 13 + 5) % 16;
      px(c, r, x, y, i % 2 ? '#ffd24a' : '#ff8a2b');
    }
  });
  // 51 冥界碳矿：暗红岩底 + 会反光的黑碳晶
  T(51, '#4b1a1a', 0.10, (c, r) => {
    for (let i = 0; i < 7; i++) {
      const bx = 2 + ((i * 5) % 11), by = 2 + ((i * 7) % 11);
      for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
        px(c, r, Math.min(15, bx + dx), Math.min(15, by + dy), (dx + dy) % 2 ? '#170e10' : '#7a1f2a');
      }
      px(c, r, Math.min(15, bx + 1), Math.min(15, by), '#d8405a');
    }
  });
  // 52 液压机：钢制机壳 + 上下压板 + 中间活塞 + 警示灯
  T(52, '#59616b', 0.06, (c, r) => {
    for (let x = 0; x < 16; x++) { px(c, r, x, 0, '#8c98a6'); px(c, r, x, 15, '#2b323b'); }
    for (let y = 0; y < 16; y++) { px(c, r, 0, y, '#79838f'); px(c, r, 15, y, '#2b323b'); }
    for (let x = 3; x < 13; x++) { px(c, r, x, 4, '#b8c2cc'); px(c, r, x, 5, '#8d98a4'); px(c, r, x, 11, '#8d98a4'); px(c, r, x, 12, '#2b323b'); }
    for (let y = 6; y < 11; y++) { px(c, r, 7, y, '#39404a'); px(c, r, 8, y, '#39404a'); }
    px(c, r, 4, 8, '#e0a24a'); px(c, r, 11, 8, '#e0a24a');
  });
  // 53 灵魂沙：土黄底 + 一张张悲鸣的脸
  T(53, '#6b5335', 0.10, (c, r) => {
    for (const [x, y] of [[3, 5], [10, 8], [6, 11]]) {
      px(c, r, x, y, '#2b2016'); px(c, r, x + 1, y, '#2b2016');
      px(c, r, x - 1, y + 1, '#2b2016'); px(c, r, x, y + 1, '#2b2016'); px(c, r, x + 1, y + 1, '#2b2016'); px(c, r, x + 2, y + 1, '#2b2016');
    }
  });
  // 54 玄武岩：深灰柱状节理
  T(54, '#3b4045', 0.07, (c, r) => {
    for (let x = 0; x < 16; x += 5) for (let y = 0; y < 16; y++) px(c, r, x, y, '#282c31');
    for (let i = 0; i < 12; i++) px(c, r, (i * 7) % 16, (i * 11) % 16, '#4a5057');
  });
  // 55 深板岩：暗灰蓝 + 细斜纹
  T(55, '#3d4048', 0.09, (c, r) => {
    for (let i = 0; i < 22; i++) {
      const x = (i * 5 + 1) % 16, y = (i * 9 + 3) % 16;
      px(c, r, x, y, i % 3 ? '#2c2f35' : '#4c515b');
      if (x < 15) px(c, r, x + 1, y, '#34383f');
    }
  });
  // 56 基岩：深黑 + 杂乱方块
  T(56, '#2a2a2e', 0.16, (c, r) => {
    for (let i = 0; i < 30; i++) {
      const x = (i * 7 + 3) % 16, y = (i * 11 + 5) % 16;
      px(c, r, x, y, i % 2 ? '#141416' : '#55555c');
    }
  });
  // 57 铀矿石：深板岩底 + 荧光绿晶粒（只在深板岩层生成）
  T(57, '#3d4048', 0.09, (c, r) => {
    for (const [x, y] of [[3, 4], [8, 3], [12, 7], [5, 9], [10, 11], [2, 12], [13, 13], [7, 6]]) {
      px(c, r, x, y, '#8dff5a'); px(c, r, x + 1, y, '#4fbf2a');
      px(c, r, x, y + 1, '#d9ff9a'); px(c, r, x + 1, y + 1, '#6fdc3a');
    }
  });
  // 58 充电器顶：金属外壳 + 中央铜线圈 + 青色能量核
  T(58, '#4a525c', 0.06, (c, r) => {
    for (let x = 0; x < 16; x++) { px(c, r, x, 0, '#7c8794'); px(c, r, x, 15, '#262c33'); }
    for (let y = 0; y < 16; y++) { px(c, r, 0, y, '#6b7581'); px(c, r, 15, y, '#262c33'); }
    for (let x = 5; x < 11; x++) for (let y = 5; y < 11; y++) px(c, r, x, y, '#b8702f');
    for (let x = 6; x < 10; x++) for (let y = 6; y < 10; y++) px(c, r, x, y, '#4de0d0');
  });
  // 59 充电器侧：外壳 + 散热格栅
  T(59, '#4a525c', 0.06, (c, r) => {
    for (let x = 0; x < 16; x++) { px(c, r, x, 0, '#7c8794'); px(c, r, x, 15, '#262c33'); }
    for (let y = 0; y < 16; y++) { px(c, r, 0, y, '#6b7581'); px(c, r, 15, y, '#262c33'); }
    for (let y = 3; y < 14; y += 3) for (let x = 3; x < 13; x++) px(c, r, x, y, '#2b323b');
    for (let x = 3; x < 13; x++) px(c, r, x, 2, '#8c98a6');
  });
  // 60 充电器正面：能量槽（青蓝发光）
  T(60, '#4a525c', 0.05, (c, r) => {
    for (let x = 0; x < 16; x++) { px(c, r, x, 0, '#7c8794'); px(c, r, x, 15, '#262c33'); }
    for (let y = 0; y < 16; y++) { px(c, r, 0, y, '#6b7581'); px(c, r, 15, y, '#262c33'); }
    for (let x = 3; x < 13; x++) for (let y = 4; y < 12; y++) px(c, r, x, y, '#101820');
    for (let x = 4; x < 12; x++) for (let y = 5; y < 11; y++) px(c, r, x, y, (x + y) % 3 ? '#2ad0c0' : '#9dfff2');
    for (let x = 4; x < 12; x++) px(c, r, x, 12, '#b8702f');
  });
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
  // 7 树叶：镂空（四角与随机小洞透明）→ 方块看起来是空心的、能透光
  {
    const c = 7 % ATLAS_COLS, r = (7 / ATLAS_COLS) | 0;
    for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
      const corner = (x < 2 && y < 2) || (x > 13 && y < 2) || (x < 2 && y > 13) || (x > 13 && y > 13);
      const hole = ((x * 7 + y * 11) % 9 === 0) || ((x * 5 + y * 3) % 14 === 0);
      if (corner || hole) continue;                                  // 透明像素 → alphaTest 抠掉
      const d = Math.hypot(x - 7.5, y - 7.5);
      px(c, r, x, y, shade(d < 4 ? '#57a13f' : '#3d7a2e', 0.9 + ((x + y) % 3) * 0.06));
    }
  }
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
  // ── 60/61 冥血木（侧 / 年轮）──────────────────────────────────────
  T(60, '#5e1e22', 0.10, (c, r) => {
    for (let x = 3; x < 16; x += 5) for (let y = 0; y < 16; y++) px(c, r, x, y, '#43141a');
    for (let y = 0; y < 16; y += 4) for (let x = 0; x < 16; x++) if (Math.random() < 0.5) px(c, r, x, y, '#77262c');
    for (let i = 0; i < 6; i++) { const x = (Math.random() * 14) | 0, y = (Math.random() * 14) | 0; px(c, r, x, y, '#a83b3f'); }
  });
  T(61, '#7d3438', 0.08, (c, r) => {
    for (let i = 0; i < 4; i++) for (let rr = 1; rr <= 6; rr += 2) {
      for (let a = 0; a < 6.28; a += 0.5) {
        const x = 8 + Math.round(Math.cos(a + i) * rr), y = 8 + Math.round(Math.sin(a + i) * rr);
        if (x >= 0 && x < 16 && y >= 0 && y < 16) px(c, r, x, y, rr > 4 ? '#5b2226' : '#9c4448');
      }
    }
  });
  // ── 62 冥血叶 / 64 灰烬叶（带透明孔的树冠）──────────────────────────
  {
    const c = 62 % ATLAS_COLS, r = (62 / ATLAS_COLS) | 0;
    g.clearRect(c * 16, r * 16, 16, 16);
    for (let i = 0; i < 150; i++) {
      const x = (Math.random() * 16) | 0, y = (Math.random() * 16) | 0;
      px(c, r, x, y, Math.random() < 0.35 ? '#8e2f33' : (Math.random() < 0.5 ? '#6d2227' : '#4a161b'));
    }
  }
  {
    const c = 64 % ATLAS_COLS, r = (64 / ATLAS_COLS) | 0;
    g.clearRect(c * 16, r * 16, 16, 16);
    for (let i = 0; i < 150; i++) {
      const x = (Math.random() * 16) | 0, y = (Math.random() * 16) | 0;
      px(c, r, x, y, Math.random() < 0.3 ? '#8b8f80' : (Math.random() < 0.5 ? '#5d6157' : '#3a3d36'));
    }
  }
  // ── 63 灰烬木（侧）────────────────────────────────────────────────
  T(63, '#4c4a42', 0.12, (c, r) => {
    for (let x = 2; x < 16; x += 4) for (let y = 0; y < 16; y++) px(c, r, x, y, '#33322c');
    for (let i = 0; i < 10; i++) { const x = (Math.random() * 15) | 0, y = (Math.random() * 15) | 0; px(c, r, x, y, '#6f6c5e'); }
  });
  // ── 65 缠魂藤（透明底 + 血丝）────────────────────────────────────
  {
    const c = 65 % ATLAS_COLS, r = (65 / ATLAS_COLS) | 0;
    g.clearRect(c * 16, r * 16, 16, 16);
    for (const sxx of [4, 8, 12]) {
      for (let y = 0; y < 16; y++) {
        const x = sxx + Math.round(Math.sin(y * 0.9 + sxx) * 1.4);
        px(c, r, x, y, y % 5 === 0 ? '#c2434a' : '#6b1f27');
        if (y % 4 === 0) { px(c, r, x - 1, y, '#8a2b33'); px(c, r, x + 1, y, '#8a2b33'); }
      }
    }
    for (let i = 0; i < 8; i++) px(c, r, 2 + ((Math.random() * 12) | 0), 4 + ((Math.random() * 10) | 0), '#e05a62');
  }
  // ── 66 沼泽泥 ────────────────────────────────────────────────────
  T(66, '#3d1a1c', 0.16, (c, r) => {
    for (let i = 0; i < 14; i++) {
      const x = (Math.random() * 14) | 0, y = (Math.random() * 14) | 0;
      px(c, r, x, y, '#60302f'); px(c, r, x + 1, y, '#4d2526');
    }
    for (let x = 0; x < 16; x += 3) for (let y = 0; y < 16; y++) if (Math.random() < 0.25) px(c, r, x, y, '#2a1012');
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
    const metal = id === 159 ? '#9a9a9a' : id === 165 ? '#d98b4a' : id === 160 ? '#d9dee5' : '#c8a06a';
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
  } else if (id === 35) { // 木门
    g.fillStyle = '#a87a44'; g.fillRect(8, 4, 16, 25);
    g.fillStyle = '#8d6534'; g.fillRect(8, 4, 16, 3);
    g.fillStyle = '#7d5729'; g.fillRect(8, 4, 2, 25); g.fillRect(22, 4, 2, 25);
    g.fillStyle = '#b98a4e'; g.fillRect(11, 9, 10, 8); g.fillRect(11, 19, 10, 8);
    g.fillStyle = '#6a4a20'; g.beginPath(); g.arc(20.5, 18.5, 1.9, 0, 7); g.fill();
  } else if (id === 161) { // 骨粉：一小堆白粉
    g.fillStyle = '#ded8c6'; g.beginPath(); g.ellipse(16, 22, 9, 4.6, 0, 0, 7); g.fill();
    g.fillStyle = '#efeade'; g.beginPath(); g.ellipse(15, 19, 6.5, 4.2, 0, 0, 7); g.fill();
    g.fillStyle = '#fbf8f0'; g.beginPath(); g.ellipse(14, 17, 4, 2.6, 0, 0, 7); g.fill();
    g.fillStyle = '#b9b2a0';
    for (const [x, y] of [[10, 21], [17, 22], [21, 20], [13, 24], [19, 24]]) g.fillRect(x, y, 2, 2);
  } else if (id === 145 || id === 146) { // 羊肉（生 / 熟）：肉块 + 骨头
    const cooked = id === 146;
    g.fillStyle = cooked ? '#a9622f' : '#e0837f';
    g.beginPath(); g.ellipse(15, 18, 9.5, 6.6, -0.15, 0, 7); g.fill();
    g.fillStyle = cooked ? '#c98a4a' : '#f0a3a0';
    g.beginPath(); g.ellipse(14, 16.4, 5.6, 3.4, -0.15, 0, 7); g.fill();
    g.fillStyle = cooked ? '#e6cba0' : '#efe6d2';
    g.fillRect(21, 12.6, 6, 3.2);
    g.beginPath(); g.arc(27.6, 12.2, 2.6, 0, 7); g.fill();
    g.beginPath(); g.arc(27.6, 16.2, 2.6, 0, 7); g.fill();
    g.fillStyle = 'rgba(255,255,255,.32)';
    g.beginPath(); g.ellipse(12, 14.6, 2.6, 1.4, -0.3, 0, 7); g.fill();
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
    const metal = id === 184 ? '#7d6890' : id === 130 ? '#5fe6d8' : id === 163 ? '#d98b4a' : id === 101 ? '#9a9a9a' : id === 120 ? '#d9dee5' : '#c8a06a';
    g.strokeStyle = '#b98a4e'; g.lineWidth = 4; g.lineCap = 'round';
    g.beginPath(); g.moveTo(9, 27); g.lineTo(21, 12); g.stroke();
    g.strokeStyle = metal; g.lineWidth = 5;
    g.beginPath(); g.moveTo(9, 9); g.quadraticCurveTo(20, 5, 27, 13); g.stroke();
  } else if (ITEMS[id] && ITEMS[id].kind === 'sword') { // 剑
    const metal = id === 179 ? '#7d6890' : id === 131 ? '#5fe6d8' : id === 164 ? '#d98b4a' : id === 149 ? '#efe9d8' : id === 103 ? '#b9b9b9' : id === 121 ? '#e3e8ef' : '#c8a06a';
    g.strokeStyle = metal; g.lineWidth = 5; g.lineCap = 'round';
    g.beginPath(); g.moveTo(10, 25); g.lineTo(24, 7); g.stroke();
    g.strokeStyle = '#8d6534'; g.lineWidth = 4;
    g.beginPath(); g.moveTo(7, 21); g.lineTo(14, 28); g.stroke();
  } else if (id === 106) { // 铁锭
    g.fillStyle = '#c9d0d8'; g.beginPath();
    g.moveTo(8, 21); g.lineTo(24, 21); g.lineTo(21, 12); g.lineTo(11, 12); g.closePath(); g.fill();
    g.fillStyle = '#e8eef4'; g.beginPath();
    g.moveTo(10, 19); g.lineTo(22, 19); g.lineTo(20, 14); g.lineTo(12, 14); g.closePath(); g.fill();
  } else if (id === 177) { // 冥界碳：黑红晶体
    g.fillStyle = '#170e10';
    g.beginPath(); g.moveTo(16, 3); g.lineTo(26, 15); g.lineTo(16, 29); g.lineTo(6, 15); g.closePath(); g.fill();
    g.fillStyle = '#7a1f2a';
    g.beginPath(); g.moveTo(16, 7); g.lineTo(22, 15); g.lineTo(16, 25); g.lineTo(10, 15); g.closePath(); g.fill();
    g.fillStyle = '#d8405a'; g.fillRect(15, 11, 3, 7);
    g.fillStyle = '#ff9ab0'; g.fillRect(16, 12, 1, 4);
  } else if (id === 178) { // 钢锭
    g.fillStyle = '#5b6874';
    g.beginPath(); g.moveTo(7, 21); g.lineTo(25, 21); g.lineTo(22, 11); g.lineTo(10, 11); g.closePath(); g.fill();
    g.fillStyle = '#95a3b0';
    g.beginPath(); g.moveTo(9, 19); g.lineTo(23, 19); g.lineTo(21, 13); g.lineTo(11, 13); g.closePath(); g.fill();
    g.fillStyle = '#dfe7ee'; g.fillRect(12, 14, 8, 2);
  } else if (id === 175) { // 传送块：紫色能量方块
    g.fillStyle = '#3a1a5c'; g.fillRect(7, 7, 18, 18);
    g.fillStyle = '#8b3fd8'; g.fillRect(9, 9, 14, 14);
    g.fillStyle = '#c58bff'; g.fillRect(11, 11, 10, 10);
    g.fillStyle = '#f2d9ff'; g.fillRect(14, 14, 4, 4);
    g.strokeStyle = '#39e0d0'; g.lineWidth = 1.5; g.strokeRect(6.5, 6.5, 19, 19);
  } else if (id === 176) { // 冥火碎片：橙色尖晶
    g.fillStyle = '#ff7a18';
    g.beginPath(); g.moveTo(16, 4); g.lineTo(24, 17); g.lineTo(16, 28); g.lineTo(8, 17); g.closePath(); g.fill();
    g.fillStyle = '#ffd24a';
    g.beginPath(); g.moveTo(16, 8); g.lineTo(20, 17); g.lineTo(16, 24); g.lineTo(12, 17); g.closePath(); g.fill();
    g.fillStyle = '#fff2c0'; g.fillRect(15, 12, 3, 6);
  } else if (id === 170) { // 木片：几片薄木屑
    for (const [x, y, w, a] of [[5, 19, 13, -0.16], [9, 13, 13, 0.2], [6, 8, 11, -0.06]]) {
      g.save(); g.translate(x, y); g.rotate(a);
      g.fillStyle = '#c0955a'; g.fillRect(0, 0, w, 4);
      g.fillStyle = '#8a6134'; g.fillRect(0, 3, w, 1.2);
      g.restore();
    }
  } else if (id === 162) { // 铜锭
    g.fillStyle = '#b8702f'; g.beginPath();
    g.moveTo(8, 21); g.lineTo(24, 21); g.lineTo(21, 12); g.lineTo(11, 12); g.closePath(); g.fill();
    g.fillStyle = '#d98b4a'; g.beginPath();
    g.moveTo(10, 19); g.lineTo(22, 19); g.lineTo(20, 14); g.lineTo(12, 14); g.closePath(); g.fill();
    g.fillStyle = '#eaa96a'; g.fillRect(13, 15, 6, 2);
  } else if (id === 185) { // 电路板：绿板 + 铜走线 + 金焊盘
    g.fillStyle = '#1f6b46'; g.fillRect(5, 6, 22, 20);
    g.fillStyle = '#2e9a63'; g.fillRect(6, 7, 20, 18);
    g.strokeStyle = '#d98b4a'; g.lineWidth = 2;
    g.beginPath(); g.moveTo(9, 11); g.lineTo(16, 11); g.lineTo(16, 17); g.lineTo(23, 17); g.stroke();
    g.beginPath(); g.moveTo(9, 21); g.lineTo(14, 21); g.lineTo(14, 15); g.stroke();
    g.fillStyle = '#f5c451';
    for (const [x, y] of [[8, 10], [22, 16], [8, 20], [13, 14]]) g.fillRect(x, y, 3, 3);
    g.fillStyle = '#0f3a28';
    for (const [x, y] of [[10, 24], [18, 24]]) g.fillRect(x, y, 3, 2);
  } else if (id === 186) { // 电线：铜色线圈
    g.strokeStyle = '#b8702f'; g.lineWidth = 3;
    for (let i = 0; i < 4; i++) { g.beginPath(); g.ellipse(16, 7 + i * 6, 8, 3.2, 0, 0, 7); g.stroke(); }
    g.strokeStyle = '#eaa96a'; g.lineWidth = 1.4;
    g.beginPath(); g.moveTo(8, 6); g.lineTo(8, 26); g.stroke();
    g.beginPath(); g.moveTo(24, 6); g.lineTo(24, 26); g.stroke();
  } else if (id === 187) { // 铀：荧光绿晶体
    g.fillStyle = '#2f4a22';
    g.beginPath(); g.moveTo(16, 4); g.lineTo(26, 14); g.lineTo(16, 29); g.lineTo(6, 14); g.closePath(); g.fill();
    g.fillStyle = '#6fdc3a';
    g.beginPath(); g.moveTo(16, 7); g.lineTo(22, 14); g.lineTo(16, 25); g.lineTo(10, 14); g.closePath(); g.fill();
    g.fillStyle = '#d9ff9a'; g.fillRect(15, 11, 3, 8);
    g.fillStyle = '#8dff5a'; g.fillRect(12, 13, 1, 5); g.fillRect(20, 13, 1, 5);
  } else if (ITEMS[id] && ITEMS[id].kind === 'gun') { // 能量炮：机匣 + 炮管 + 发光炮口
    const metal = id === 191 ? '#7d6890' : id === 190 ? '#5fe6d8' : id === 189 ? '#d9dee5' : '#d98b4a';
    const glow = id === 191 ? '#c08cff' : id === 190 ? '#7dffe8' : id === 189 ? '#bfe4ff' : '#ffb066';
    g.fillStyle = '#2b323b'; g.fillRect(5, 12, 18, 7);
    g.fillStyle = metal; g.fillRect(9, 9, 9, 4); g.fillRect(21, 13, 7, 3);
    g.fillStyle = '#1b2028'; g.fillRect(11, 19, 5, 8);
    g.fillStyle = metal; g.fillRect(12, 20, 3, 6);
    g.fillStyle = glow; g.fillRect(27, 12, 2, 5); g.fillRect(6, 15, 3, 2);
  } else if (ITEMS[id] && ITEMS[id].kind === 'armor') { // 盔甲
    const nether = id >= 180 && id <= 183;          // 冥界钢护甲 180~183：黑铁色
    const wood = id >= 171 && id <= 174;            // 木护甲：木色（最弱的一套）
    const cop = id >= 166 && id <= 169;             // 铜护甲：铜橙色
    const dia = id >= 132 && !cop && !wood && !nether;
    const steel = dia ? '#5fe6d8' : nether ? '#7d6890' : cop ? '#d98b4a' : wood ? '#c0955a' : '#d3dae2',
          dark = dia ? '#2fa89c' : nether ? '#3a2f45' : cop ? '#8a5525' : wood ? '#7a5527' : '#8c98a6';
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
  if (inMyCabin(wx, wz)) return null;                 // 小屋范围内不长树
  if (inPlain(wx, wz) && h2(wx * 1.73 + 3.1, wz * 2.37 - 5.9) > 0.10) return null;   // 平原：树非常少
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
  const vein = (count, tile, size, yMin, yMax, chance = 1, deepOnly = false) => {
    for (let i = 0; i < count; i++) {
      if (chance < 1 && rnd() > chance) continue;
      let x = 1 + Math.floor(rnd() * 14), z = 1 + Math.floor(rnd() * 14);
      let y = yMin + Math.floor(rnd() * Math.max(1, yMax - yMin));
      const len = 3 + Math.floor(rnd() * size);
      for (let k = 0; k < len; k++) {
        out.push({ x, y, z, t: tile, deep: deepOnly });
        const d = rnd();
        if (d < 0.3) x = Math.min(15, Math.max(0, x + (rnd() < 0.5 ? 1 : -1)));
        else if (d < 0.62) z = Math.min(15, Math.max(0, z + (rnd() < 0.5 ? 1 : -1)));
        else y = Math.min(CFG.WH - 4, Math.max(2, y + (rnd() < 0.5 ? 1 : -1)));
      }
    }
  };
  vein(48, 13, 5, 60, 150);      // 煤：中上层（地表抬到 87~124 之后，60~150 是"地下主开采带"）
  vein(10, 15, 4, 30, 120);      // 铁：中层
  // 钻石：设计目标 = 铁的 1/10。铁 10 条/区块 × 平均 4.5 块 = 45 块/区块；
  // 钻石 1 条/区块 × 平均 4 块 = 4 块/区块（只在 y<10）。深层洞穴少、留存率高，
  // 所以名义给 11:1，实测（200 区块）落在 9.5~10:1。
  // 铜：石→铜→铁的中间档，出现频率要和铁接近（约 6:5），否则新人根本凑不齐第一把铜镐。
  // 实测（169 区块）：vein(6,39,3,16,42) 只有铁的 41%（1748 vs 4247 块）→ 提到 10 条、size 4、y12~44。
  vein(10, 39, 4, 45, 130);      // 铜：10 条/区块，中浅层
  vein(1, 20, 3, 6, 54, 0.85);   // 钻石：只在深板岩层（y 6~54 < DEEP_Y=58）→ 必须挖到深板岩才见得到
  // 铀：条数/规模照抄铁（10 条 × size4 = 与铁 10 条 × size4 同档），但 deep=true ⇒
  // 只替换深板岩(50)，石头层(3)里绝不出现 ⇒ 只能挖到深板岩层才见得到。
  vein(10, 52, 4, 8, 56, 1, true);
  veinCache.set(key, out);
  return out;
}

// ── 特殊岩层：花岗岩（深）/ 石灰岩（中）成团自然生成。
// 直接写进区块数组（不建中间对象数组，否则每区块几千次分配、生成卡顿）；
// 团块中心用「邻区块种子」算 → 跨区块连续，不会在边界切出方形接缝。
function applyStoneBlobs(b, idx, cx, cz) {
  const putStone = (lx, y, lz, t) => {
    if (lx < 0 || lx > 15 || lz < 0 || lz > 15 || y < 1 || y >= CFG.WH - 1) return;
    const i = idx(lx, y, lz);
    if (b[i] === 3) b[i] = t;                       // 只替换还是石头的地方（土层/空气/矿脉都不动）
  };
  const blobType = (t, count, rMin, rMax, yMin, yMax) => {
    for (let nx = -1; nx <= 1; nx++) for (let nz = -1; nz <= 1; nz++) {
      const sx = cx + nx, sz = cz + nz;
      const rnd = mulberry32((Math.imul(sx, 19349663) ^ Math.imul(sz, 83492791) ^ Math.imul(SEED, 73856093) ^ Math.imul(t, 2654435761)) | 0);
      for (let i = 0; i < count; i++) {
        const bx = sx * 16 + Math.floor(rnd() * 16), bz = sz * 16 + Math.floor(rnd() * 16);
        const by = yMin + Math.floor(rnd() * Math.max(1, yMax - yMin));
        const rx = rMin + rnd() * (rMax - rMin), rz = rMin + rnd() * (rMax - rMin);
        const ry = rx * (0.45 + rnd() * 0.45);
        const x0 = Math.max(cx * 16, Math.floor(bx - rx)), x1 = Math.min(cx * 16 + 15, Math.ceil(bx + rx));
        const z0 = Math.max(cz * 16, Math.floor(bz - rz)), z1 = Math.min(cz * 16 + 15, Math.ceil(bz + rz));
        const y0 = Math.max(1, Math.floor(by - ry)), y1 = Math.min(CFG.WH - 2, Math.ceil(by + ry));
        for (let x = x0; x <= x1; x++) for (let z = z0; z <= z1; z++) for (let y = y0; y <= y1; y++) {
          const dx = (x - bx) / rx, dy = (y - by) / ry, dz = (z - bz) / rz;
          if (dx * dx + dy * dy + dz * dz <= 1) putStone(x - cx * 16, y, z - cz * 16, t);
        }
      }
    }
  };
  blobType(26, 3, 2.8, 5.0, 12, 46);     // 花岗岩：偏深（跟着整体抬高到深板岩层附近）
  blobType(27, 4, 3.0, 5.2, 52, 86);     // 石灰岩：中层
}

/* ────────────────────────────────────────────────────────────────
   熔岩沼泽（冥界新结构）：112×112 一格的网格，每格按哈希决定有没有。
   中央是岩浆湖，外圈沼泽泥 + 冥血木/灰烬木 + 垂下来的缠魂藤；矿极富（冥界碳 + 钻石）。
   全部由世界坐标哈希决定，所以任何区块单独生成结果都一致（跨区块不会错位）。 */
const LS_CELL = 112, LS_R = 34;
const lsCache = new Map();
function lavaSwamp(rx, rz) {
  const key = rx + ',' + rz;
  if (lsCache.has(key)) return lsCache.get(key);
  let sw = null;
  if (h3(rx * 13 + 5, 977, rz * 17 - 3) > 0.62) {
    const cx = rx * LS_CELL + 56 + Math.round((h3(rx * 7 + 1, 13, rz * 7 + 9) - 0.5) * 44);
    const cz = rz * LS_CELL + 56 + Math.round((h3(rx * 3 + 2, 29, rz * 3 + 4) - 0.5) * 44);
    const trees = [];
    for (let i = 0; i < 30 && trees.length < 15; i++) {
      const a = h3(rx * 31 + i, 41, rz * 31 + i * 7) * 6.28318;
      const rr = 15 + h3(rx * 17 + i * 3, 53, rz * 11 + i) * (LS_R - 12);
      const x = Math.round(cx + Math.cos(a) * rr), z = Math.round(cz + Math.sin(a) * rr);
      if (Math.hypot(x - cx, z - cz) < 13) continue;
      if (trees.some(t => Math.hypot(t.x - x, t.z - z) < 6)) continue;
      trees.push({ x, z, h: 7 + Math.round(h3(x, 3, z) * 6), k: h3(x, 9, z) > 0.55 ? 1 : 0 });
    }
    sw = { rx, rz, x: cx, z: cz, trees };
  }
  lsCache.set(key, sw);
  return sw;
}
/* ── 冥界地形：岩浆海底 + 冥界岩穹顶 + 钟乳石。没有水、没有树、没有矿脉。
   区块 (0,0) 额外挖一条出生走廊并预置「回程传送门」（已激活，玩家一进去就能回）。 */
function genNetherChunk(cx, cz) {
  const CH = CFG.CH, WH = CFG.WH;
  const b = new Uint8Array(CH * WH * CH);
  const idx = (x, y, z) => (y * CH + z) * CH + x;
  const ox = cx * CH, oz = cz * CH;
  const pillar = h3;                                             // 玄武岩柱用稀疏哈希
  for (let lx = 0; lx < CH; lx++) for (let lz = 0; lz < CH; lz++) {
    const wx = ox + lx, wz = oz + lz;
    b[idx(lx, 0, lz)] = 51; b[idx(lx, 1, lz)] = 51;                          // 冥界底部基岩
    for (let y = 2; y < NETHER_LAVA_Y; y++) b[idx(lx, y, lz)] = 44;            // 岩浆海（MC 风：海底全是岩浆）
    for (let y = NETHER_LAVA_Y; y < WH; y++) {
      if (!netherSolid(wx, y, wz)) continue;
      const i = idx(lx, y, lz);
      b[i] = 43;                                                            // 冥界岩
      // 冥界碳：2×2×2 一簇、极稀（约和钻石同级，~4 块/区块），挖到时会连续出几块
      if (y > NETHER_LAVA_Y && y <= 52 && h3(Math.floor(wx / 2), Math.floor(y / 2) + 7, Math.floor(wz / 2)) > 0.9985) b[i] = 46;
    }
    // 灵魂沙滩：任何「露天顶面」的冥界岩（低处更容易，形成 MC 那种灵魂沙谷）
    for (let y = NETHER_LAVA_Y + 1; y <= NETHER_LAVA_Y + 14; y++) {
      const i = idx(lx, y, lz);
      if (b[i] !== 43 || b[idx(lx, y + 1, lz)] !== 0) continue;
      // 按 7×7 的「区块」整片铺（MC 的灵魂沙谷就是一整片，不是零星几点）
      if (h2(Math.floor(wx / 7) * 3.7 + 2.2, Math.floor(wz / 7) * 5.1 - 4.4) > 0.84) b[i] = 48;
    }
    for (let y = 62; y <= 64; y++) b[idx(lx, y, lz)] = 51;                     // 冥界顶部基岩（三层，写在岩体之后才盖得住）
    // 玄武岩柱：2×2 一簇，从岩浆面直通穹顶
    if (pillar(Math.floor(wx / 2), 77, Math.floor(wz / 2)) > 0.988) {
      const top = netherCeilAt(wx, wz);
      for (let y = NETHER_LAVA_Y; y < top; y++) { const i = idx(lx, y, lz); if (!b[i]) b[i] = 49; }
    }
  }
  if (ox === NETHER_OFF && oz === NETHER_OFF) {                     // 出生走廊 + 回程门（冥界原点那块区块）
    for (let lx = 0; lx < 16; lx++) for (let lz = 0; lz < 16; lz++) {
      for (let y = 34; y <= 41; y++) {
        const i = idx(lx, y, lz);
        if (b[i] === 43 || b[i] === 44) b[i] = 0;
      }
      if (b[idx(lx, 33, lz)] === 0) b[idx(lx, 33, lz)] = 43;      // 铺地板
    }
    for (let dx = -2; dx <= 2; dx++) for (let dy = 0; dy <= 5; dy++) {   // 门框 5×6（贴着 z=8）
      const edge = Math.abs(dx) === 2 || dy === 0 || dy === 5;
      b[idx(8 + dx, 34 + dy, 8)] = edge ? 41 : 0;
    }
    b[idx(8, 35, 8)] = 45;                                        // 核心
    for (let dx = -1; dx <= 1; dx++) for (let dy = 2; dy <= 4; dy++) b[idx(8 + dx, 34 + dy, 8)] = 42;   // 已激活
  }
  // ── 熔岩沼泽地形：岩浆湖 + 沼泽泥 + 冥界树 + 缠魂藤 + 富矿 ──
  {
    const put = (lx, y, lz, id, onlyAir) => {
      if (lx < 0 || lx >= CH || lz < 0 || lz >= CH || y < 1 || y >= WH) return;
      const i = idx(lx, y, lz);
      if (onlyAir && b[i] !== 0) return;
      b[i] = id;
    };
    const r0x = Math.floor(ox / LS_CELL), r0z = Math.floor(oz / LS_CELL);
    for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
      const sw = lavaSwamp(r0x + dx, r0z + dz);
      if (!sw) continue;
      if (sw.x + LS_R + 10 < ox || sw.x - LS_R - 10 >= ox + CH) continue;
      if (sw.z + LS_R + 10 < oz || sw.z - LS_R - 10 >= oz + CH) continue;
      // ① 地形：中间凹成岩浆湖，四周沼泽泥台地，上方挖空
      for (let lx = 0; lx < CH; lx++) for (let lz = 0; lz < CH; lz++) {
        const wx = ox + lx, wz = oz + lz;
        const d = Math.hypot(wx - sw.x, wz - sw.z);
        if (d > LS_R) continue;
        const t = d / LS_R;
        const floorY = NETHER_LAVA_Y + 3 + Math.round(t * t * t * 5);
        for (let y = NETHER_LAVA_Y + 2; y <= floorY; y++) put(lx, y, lz, y === floorY ? 59 : 43);
        for (let y = floorY + 1; y <= Math.min(WH - 2, floorY + 12); y++) put(lx, y, lz, 0);
        if (d < 12) for (let y = floorY; y > floorY - 3; y--) put(lx, y, lz, 44);       // 岩浆湖
        for (let y = NETHER_LAVA_Y + 1; y < floorY - 1; y++) {                            // 富矿
          const hv = h3(Math.floor(wx / 2), y, Math.floor(wz / 2));
          if (hv > 0.993) put(lx, y, lz, 46);
          else if (hv > 0.986) put(lx, y, lz, 20);
        }
      }
      // ② 冥界树 + 垂藤
      for (const tr of sw.trees) {
        const lx0 = tr.x - ox, lz0 = tr.z - oz;
        if (lx0 < -4 || lx0 > CH + 4 || lz0 < -4 || lz0 > CH + 4) continue;
        const d0 = Math.hypot(tr.x - sw.x, tr.z - sw.z), t0 = Math.min(1, d0 / LS_R);
        const base = NETHER_LAVA_Y + 3 + Math.round(t0 * t0 * t0 * 5) + 1;
        const logId = tr.k ? 56 : 54, leafId = tr.k ? 57 : 55;
        for (let y = base; y <= base + tr.h; y++) put(lx0, y, lz0, logId);
        for (let dy = tr.h - 3; dy <= tr.h + 1; dy++) {
          const rad = dy >= tr.h ? 1 : 2;
          for (let ax = -rad; ax <= rad; ax++) for (let az = -rad; az <= rad; az++) {
            if (ax * ax + az * az > rad * rad + 1) continue;
            put(lx0 + ax, base + dy, lz0 + az, leafId, true);
          }
        }
        for (let v = 0; v < 3; v++) {                                                    // 垂下来的缠魂藤
          const ax = Math.round((h3(tr.x + v, 7, tr.z) - 0.5) * 4);
          const az = Math.round((h3(tr.x, 11, tr.z + v) - 0.5) * 4);
          const len = 2 + Math.round(h3(tr.x + v * 3, 5, tr.z + v) * 4);
          for (let y = base + tr.h - 2; y > base + tr.h - 3 - len; y--) put(lx0 + ax, y, lz0 + az, 58, true);
        }
      }
      // ③ 地面缠魂藤（走进去会被缠住）
      for (let i = 0; i < 46; i++) {
        const a = h3(sw.rx + 3, i * 3 + 1, sw.rz + 5) * 6.28318;
        const rr = 11 + h3(sw.rx + 1, i, sw.rz + 2) * (LS_R - 9);
        const lx = Math.round(sw.x + Math.cos(a) * rr) - ox, lz = Math.round(sw.z + Math.sin(a) * rr) - oz;
        if (lx < 0 || lx >= CH || lz < 0 || lz >= CH) continue;
        for (let y = NETHER_LAVA_Y + 14; y > NETHER_LAVA_Y; y--) {
          if (b[idx(lx, y - 1, lz)] === 59 && b[idx(lx, y, lz)] === 0) { put(lx, y, lz, 58); break; }
        }
      }
    }
  }
  // 冥界也会自然生成传送门（已激活）；按区块 key 把结构 ops 写进来
  {
    const selfKey = (ox >> 4) + ',' + (oz >> 4);
    const pcx0 = Math.floor(ox / PT_CELL), pcz0 = Math.floor(oz / PT_CELL);
    for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
      const st = portalFor(pcx0 + dx, pcz0 + dz);
      if (!st || !st.active) continue;
      const arr = st.byChunk.get(selfKey);
      if (!arr) continue;
      for (const op of arr) {
        if (op.x < ox || op.x >= ox + CH || op.z < oz || op.z >= oz + CH) continue;
        if (op.y < 1 || op.y >= WH) continue;
        const i = idx(op.x - ox, op.y, op.z - oz);
        if (op.t === 0) { if (b[i] !== 44) b[i] = 0; }
        else b[i] = op.t;
      }
    }
  }
  return b;
}
function genChunk(cx, cz) {
  if (DIM === 'nether') return genNetherChunk(cx, cz);            // 冥界走另一套地形
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
      const deep = y < DEEP_Y;                                                     // 深处换成深板岩
      if (y <= 1) id = 51;                                                         // 基岩底（挖不动）
      else if (beach) id = d <= 3 ? 4 : (deep ? 50 : 3);
      else if (h >= MOUNT_Y) id = deep ? 50 : 3;
      else id = d === 0 ? 1 : (d <= 3 ? 2 : (deep ? 50 : 3));
      if (id !== 4 && id !== 51 && caveCarve(wx, y, wz, h)) id = 0;                 // 洞穴（含天然洞口）
      if (id) b[idx(lx, y, lz)] = id;
    }
    for (let y = Math.max(h + 1, 0); y <= SEA && y < WH; y++) b[idx(lx, y, lz)] = 5;  // 水
  }
  // 矿脉：成簇埋进石头里（只在还是石头的地方替换，不动土/沙/水）
  for (const v of oreVeins(cx, cz)) {
    const i = idx(v.x, v.y, v.z);
    if (v.deep) { if (b[i] === 50) b[i] = v.t; }          // 铀：只替换深板岩
    else if (b[i] === 3 || b[i] === 50) b[i] = v.t;       // 石头和深板岩里都能长矿
  }
  // 特殊岩层（花岗岩/石灰岩）：同样只替换还是石头的地方，矿脉优先保留
  applyStoneBlobs(b, idx, cx, cz);
  // 地表植被：草丛 / 红花（十字面片，不挡路，只长在草地上）
  for (let lx = 0; lx < CH; lx++) for (let lz = 0; lz < CH; lz++) {
    const wx = ox + lx, wz = oz + lz, h = heightAt(wx, wz);
    if (h + 1 >= WH) continue;
    if (b[idx(lx, h, lz)] !== 1) continue;                 // 脚下是草地
    if (b[idx(lx, h + 1, lz)] !== 0) continue;             // 上方空着
    const r = h3(wx * 7 + 11, 3, wz * 13 + 5);
    if (r > 0.975) b[idx(lx, h + 1, lz)] = 37;             // 2.5% 红花
    else if (r > 0.86) b[idx(lx, h + 1, lz)] = 36;         // 11.5% 草丛
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
  /* ── 半张床修复：床是「脚格 + 头格」两格方块。结构生成时只写了一格，或者另一半被相邻结构/自己的
     挖空（carve）清掉，玩家就会看到「床只有半个」。这里在区块数据定稿前把缺的那格补回来。
     ⚠ 只碰本区块内的空格，绝不调用 getBlock/getChunk —— 生成期跨区块取方块会 getChunk↔getBlock
     互相递归 ⇒ RangeError: Maximum call stack size exceeded（而且只在走到那片区域时才崩）。 */
  {
    const metaOf = (lx, yy, lz) => getMeta(ox + lx, yy, oz + lz);
    const solidBelow = v => v !== 0 && v !== 5 && v !== 22 && !(BLOCKS[v] && BLOCKS[v].cross);
    const OFF = [[1, 0], [-1, 0], [0, 1], [0, -1]];           // dir1=+X dir2=-X dir3=+Z dir4=-Z（脚→头）
    for (let y = 1; y < WH - 1; y++) for (let lz = 0; lz < CH; lz++) for (let lx = 0; lx < CH; lx++) {
      if (b[(y * CH + lz) * CH + lx] !== 14) continue;
      const m = metaOf(lx, y, lz);
      const head = m > 4, dir0 = head ? m - 4 : m;
      let d = dir0;
      if (!d) {                                              // meta 0（旧存档）：按同伴推断朝向
        d = 3;
        for (let k = 0; k < 4; k++) {
          const ax = lx + OFF[k][0], az = lz + OFF[k][1];
          if (ax < 0 || ax >= CH || az < 0 || az >= CH) continue;
          if (b[(y * CH + az) * CH + ax] === 14) { d = k + 1; break; }
        }
      }
      const sgn = head ? -1 : 1;                              // 头格 → 脚在反方向；脚格 → 头在 dir 方向
      const tx = lx + OFF[d - 1][0] * sgn, tz = lz + OFF[d - 1][1] * sgn;
      if (tx < 0 || tx >= CH || tz < 0 || tz >= CH) continue;  // 跨区块的交给对面那个区块去修
      const ti = (y * CH + tz) * CH + tx;
      if (b[ti] !== 0) continue;                               // 那里有东西 / 本来就是床：不动
      if (!solidBelow(b[((y - 1) * CH + tz) * CH + tx])) continue;
      b[ti] = 14;
      setMeta(ox + tx, y, oz + tz, head ? d : d + 4, true);
    }
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
/* 区块查询缓存：网格化时同一区块会被查上十万次，原来是每次都拼 "cx,cz" 字符串 + Map.get。
   只缓存「上一次查到的区块」（比 cx/cz 两个数字，不用算 key），命中率 >95%。 */
let _pkC = null;
function invalidateChunkCache() { _pkC = null; }
function chunkAt(cx, cz) {
  if (_pkC && _pkC.cx === cx && _pkC.cz === cz) return _pkC;
  const c = chunks.get(cx + ',' + cz);
  if (c) _pkC = c;
  return c;
}
function getBlock(x, y, z) {
  if (y < 0) return 3;
  if (y >= CFG.WH) return 0;
  const c = chunkAt(x >> 4, z >> 4) || getChunk(x >> 4, z >> 4);
  return c.blocks[(y * CFG.CH + (z & 15)) * CFG.CH + (x & 15)];
}
/* peekBlock：只读已加载的区块，**绝不触发生成**。
   返回 255 表示「这一格所在的区块还没加载」——网格化时代码会把它当实心（那一面不画），
   等邻居区块补上后由 streamChunks 把这块重建一次。
   （旧代码用 getBlock 查邻居 → 建一块会连锁生成周围 8 块地形，走路/换维度时卡成幻灯片） */
function peekBlock(x, y, z) {
  if (y < 0) return 3;
  if (y >= CFG.WH) return 0;
  const c = chunkAt(x >> 4, z >> 4);
  if (!c) return 255;
  return c.blocks[(y * CFG.CH + (z & 15)) * CFG.CH + (x & 15)];
}
const isSolid = id => id !== 0 && id !== 5 && !(BLOCKS[id] && (BLOCKS[id].plant || BLOCKS[id].liquid));   // 作物/液体可穿过

// 存档改动按区块分桶：key "cx,cz" → Map(区块内线性下标 → 方块 id)
const editsByChunk = new Map();
function indexEdit(x, y, z, id) {
  const ck = (x >> 4) + ',' + (z >> 4);
  let m = editsByChunk.get(ck);
  if (!m) editsByChunk.set(ck, m = new Map());
  const li = (y * CFG.CH + (z & 15)) * CFG.CH + (x & 15);
  // ★ 挖空（id 0）也必须留在索引里。以前这里是 `if (id === 0) m.delete(li)`，
  //   于是「挖出来的洞」读档后被天然地形重新填满 —— 人物卡在石头里被抬到地表，
  //   这就是「在地底矿洞退出、回来到了地表」的老 bug 真正的根因。
  m.set(li, id);
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
  const netHook = NET && NET.active && record && !NET.applying;    // 联机：本地先改，再推服务端
  const prevId = netHook ? getBlock(x, y, z) : 0;
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
  if (netHook) NET.onLocalEdit(x, y, z, id, prevId);
}
/* ---------- 岩浆流动 ----------
   岩浆是液体（liquid:true，不挡路），被挖开后会往低处/旁边慢慢铺。
   为了不拖帧：每 0.6 秒只处理玩家附近 11×11×6 的范围，每拍最多填 10 格。 */
let lavaT2 = 0, burnT = 0;
function setBurnFx(on) {
  const el = $('burnFx');
  if (el) el.classList.toggle('on', !!on);
}
function updateLava(dt) {
  lavaT2 -= dt;
  if (lavaT2 > 0) return;
  lavaT2 = 0.6;
  const px = Math.floor(player.p.x), py = Math.floor(player.p.y), pz = Math.floor(player.p.z);
  const fill = [];
  for (let dx = -5; dx <= 5; dx++) for (let dz = -5; dz <= 5; dz++) for (let dy = -3; dy <= 4; dy++) {
    const x = px + dx, y = py + dy, z = pz + dz;
    if (getBlock(x, y, z) !== 44) continue;
    if (y > 1 && getBlock(x, y - 1, z) === 0) { fill.push([x, y - 1, z]); continue; }
    for (const [ax, az] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) if (getBlock(x + ax, y, z + az) === 0) fill.push([x + ax, y, z + az]);
  }
  for (let i = 0; i < Math.min(fill.length, 10); i++) setBlock(fill[i][0], fill[i][1], fill[i][2], 44);
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
      if (h > CFG.SEA + 3 && h < SURF_OFF + 42) return { x: x + 0.5, y: h + 1.05, z: z + 0.5 };   // 阈值跟着地表抬高
    }
  }
  return { x: 8.5, y: SURF_OFF + 40, z: 8.5 };
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
renderer.shadowMap.enabled = true;                      // 真正的实时阴影（方向光 + 火把点光源）
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.shadowMap.autoUpdate = true;
app.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(74, innerWidth / innerHeight, 0.08, 420);
camera.rotation.order = 'YXZ';
scene.fog = new THREE.Fog(0x8fc9ff, 34, 92);
// 方块本身是 MeshBasicMaterial（光照烘在顶点色里），但怪物用 Lambert → 主场景必须有灯，否则全黑
const worldLight = new THREE.HemisphereLight(0xffffff, 0x4a5568, 1.0);
const worldDir = new THREE.DirectionalLight(0xffffff, 0.5);
worldDir.position.set(0.6, 1, 0.35);
worldDir.castShadow = true;
worldDir.shadow.mapSize.set(1024, 1024);
worldDir.shadow.camera.near = 1;
worldDir.shadow.camera.far = 160;
worldDir.shadow.camera.left = -48; worldDir.shadow.camera.right = 48;
worldDir.shadow.camera.top = 48; worldDir.shadow.camera.bottom = -48;
worldDir.shadow.bias = -0.0006;
worldDir.shadow.normalBias = 0.06;
scene.add(worldDir.target);                             // 方向光的朝向目标必须在场景里才会更新
const worldAmb = new THREE.AmbientLight(0xffffff, 0.30);   // 兜底环境光（UE 里的 skylight 味道）
scene.add(worldAmb);
scene.add(worldLight, worldDir);

makeAtlas();
const solidMat = new THREE.MeshLambertMaterial({ map: atlasTex, vertexColors: true, fog: true,
  alphaTest: 0.5 });   // 受光材质：接受太阳/火把的光照与阴影；alphaTest 抠镂空树叶
// 植物（草丛/花）：透明贴图 + alphaTest 抠形，双面可见
const plantMat = new THREE.MeshBasicMaterial({ map: atlasTex, vertexColors: true, transparent: true,
  alphaTest: 0.45, side: THREE.DoubleSide, fog: true, depthWrite: true });
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

/* ── 视觉光影：顶点 AO（方块凹角/贴地处变暗）+ 火把照亮（烘焙进顶点色） ── */
function vertexAO(wx, y, wz, f, V) {
  const n = f.n, axes = [];
  for (let a = 0; a < 3; a++) if (n[a] === 0) axes.push(a);
  if (axes.length < 2) return 1;
  const dirs = [V[axes[0]] === 1 ? 1 : -1, V[axes[1]] === 1 ? 1 : -1];
  const bx = wx + n[0], by = y + n[1], bz = wz + n[2];
  const occ = (o1, o2) => {
    const q = [bx, by, bz];
    if (o1) q[axes[0]] += dirs[0];
    if (o2) q[axes[1]] += dirs[1];
    const id = peekBlock(q[0], q[1], q[2]);
    if (!id) return 0;
    const d = BLOCKS[id];
    if (d && (d.cross || d.plant)) return 0;         // 草/花/火把不挡光
    return 1;
  };
  const s1 = occ(1, 0), s2 = occ(0, 1), c = occ(1, 1);
  if (s1 && s2) return 0.5;                          // 凹角最暗
  return 1 - 0.16 * (s1 + s2 + c);
}
function torchLightAt(wx, y, wz) {                   // 附近火把的亮度（0..~1.1）
  if (!torchCells.size) return 0;
  let best = 0;
  for (const t of torchCells.values()) {
    const dx = t.x - wx, dy = t.y - y, dz = t.z - wz;
    const d2 = dx * dx + dy * dy + dz * dz;
    if (d2 > 81) continue;
    const k = 1 - Math.sqrt(d2) / 9;
    if (k > best) best = k;
  }
  return best * best * 1.15;
}
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
  const isBed = (dx, dz) => peekBlock(wx + dx, y, wz + dz) === 14;
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

// ── 门：薄门板 + 门把手，占两格（下格 meta 与上格同值 + bit3 标「上半」）。
// meta 位：bit0-1 = dir-1（1=贴 -Z 面 2=贴 +Z 3=贴 -X 4=贴 +X），bit2 = 开，bit3 = 上半。
function doorState(meta) {
  return { dir: (meta & 3) + 1, open: !!(meta & 4), top: !!(meta & 8) };
}
function emitDoor(lx, y, lz, def, meta, P, U, C, I, base) {
  const { dir, open, top } = doorState(meta);
  const T = 0.16, E = 0.03;                       // 门板厚度 / 两侧门框边距
  let x0, x1, z0, z1;
  if (!open) {                                    // 关门：门板铺满门洞，厚度贴墙那一侧
    if (dir === 1) { x0 = E; x1 = 1 - E; z0 = 0.02; z1 = 0.02 + T; }
    else if (dir === 2) { x0 = E; x1 = 1 - E; z0 = 1 - 0.02 - T; z1 = 1 - 0.02; }
    else if (dir === 3) { z0 = E; z1 = 1 - E; x0 = 0.02; x1 = 0.02 + T; }
    else { z0 = E; z1 = 1 - E; x0 = 1 - 0.02 - T; x1 = 1 - 0.02; }
  } else {                                        // 开门：绕铰链转 90°，门板贴门轴那一端
    if (dir === 1 || dir === 2) { const xs = dir === 1 ? 0.02 : 1 - 0.02 - T; x0 = xs; x1 = xs + T; z0 = E; z1 = 1 - E; }
    else { const zs = dir === 3 ? 0.02 : 1 - 0.02 - T; z0 = zs; z1 = zs + T; x0 = E; x1 = 1 - E; }
  }
  const y0 = top ? 0.04 : 0, y1 = top ? 0.95 : 0.98;  // 上下半格之间留缝，看得出是两截门
  let n = emitBox(P, U, C, I, base, lx, y, lz, x0, x1, y0, y1, z0, z1, 40);
  if (!top) {                                      // 门把手：自由端、朝室内那一面
    let kx0, kx1, kz0, kz1;
    if (!open) {
      if (dir === 1) { kx0 = 0.72; kx1 = 0.80; kz0 = 0.18; kz1 = 0.24; }
      else if (dir === 2) { kx0 = 0.20; kx1 = 0.28; kz0 = 0.76; kz1 = 0.82; }
      else if (dir === 3) { kz0 = 0.72; kz1 = 0.80; kx0 = 0.18; kx1 = 0.24; }
      else { kz0 = 0.20; kz1 = 0.28; kx0 = 0.76; kx1 = 0.82; }
    } else {
      if (dir === 1) { kz0 = 0.72; kz1 = 0.80; kx0 = 0.18; kx1 = 0.24; }
      else if (dir === 2) { kz0 = 0.72; kz1 = 0.80; kx0 = 0.76; kx1 = 0.82; }
      else if (dir === 3) { kx0 = 0.72; kx1 = 0.80; kz0 = 0.18; kz1 = 0.24; }
      else { kx0 = 0.72; kx1 = 0.80; kz0 = 0.76; kz1 = 0.82; }
    }
    n += emitBox(P, U, C, I, base + n, lx, y, lz, kx0, kx1, 0.46, 0.60, kz0, kz1, 41);
  }
  return n;
}

// ── 十字面片植物（草丛/花）：两片正交薄面 + 透明贴图 → 不是方块，玩家可以直接走过去
function emitCross(lx, y, lz, def, P, U, C, I, base) {
  const tile = def.top;
  const u0 = (tile % ATLAS_COLS) / ATLAS_COLS + 0.002;
  const v0 = 1 - (((tile / ATLAS_COLS) | 0) + 1) / ATLAS_ROWS + 0.002;
  const iu = 1 / ATLAS_COLS - 0.004, iv = 1 / ATLAS_ROWS - 0.004;
  const A = 0.14, B = 0.86, H = def.crossH || 0.95;    // 面片在格内的范围与高度（小麦按生长阶段变高）
  const quad = (ax, az, bx, bz) => {                   // 一个竖面片（左下→右下→右上→左上）
    const pts = [[ax, 0, az], [bx, 0, bz], [bx, H, bz], [ax, H, az]];
    const uv = [[0, 0], [1, 0], [1, 1], [0, 1]];
    const v = base + (quad.n || 0);
    for (let k = 0; k < 4; k++) {
      P.push(lx + pts[k][0], y + pts[k][1], lz + pts[k][2]);
      U.push(u0 + uv[k][0] * iu, v0 + uv[k][1] * iv);
      C.push(0.94, 0.94, 0.94);
    }
    I.push(v, v + 1, v + 2, v, v + 2, v + 3);
    quad.n = (quad.n || 0) + 4;
  };
  quad(A, A, B, B);
  quad(A, B, B, A);
  return 8;
}

/* ── 门的运行时对象：门不进区块网格，改成每扇一个 Group，绕铰链缓动旋转（丝滑开关） ──
   ⚠ 开门必须让门板「转进本格内」：门板长 0.84 + 厚 0.14 < 1.0，铰链放在门板内角，
   旋转后门板刚好贴着门洞侧壁 —— 旧版铰链在外角，开门时门板会探出格子 0.16 米插进旁边方块（穿模）。 */
const DOOR_DEF = [null,
  { x0: 0.11, x1: 0.89, z0: 0.04, z1: 0.16, hx: 0.11, hz: 0.16, a: -Math.PI / 2 },   // 贴 -Z
  { x0: 0.11, x1: 0.89, z0: 0.84, z1: 0.96, hx: 0.89, hz: 0.84, a: -Math.PI / 2 },   // 贴 +Z
  { x0: 0.04, x1: 0.16, z0: 0.11, z1: 0.89, hx: 0.16, hz: 0.11, a: Math.PI / 2 },    // 贴 -X
  { x0: 0.84, x1: 0.96, z0: 0.11, z1: 0.89, hx: 0.84, hz: 0.89, a: Math.PI / 2 },    // 贴 +X
];
const doorGeoCache = new Map();
const doorObjs = new Map();            // 'x,y,z'（下格）→ { group, dir, p, targetP, a }
function doorGeometry(dir) {
  if (doorGeoCache.has(dir)) return doorGeoCache.get(dir);
  const d = DOOR_DEF[dir];
  const P = [], U = [], C = [], I = [];
  let n = 0;
  n += emitBox(P, U, C, I, n, 0, 0, 0, d.x0 - d.hx, d.x1 - d.hx, 0, 0.98, d.z0 - d.hz, d.z1 - d.hz, 40);        // 下半
  n += emitBox(P, U, C, I, n, 0, 0, 0, d.x0 - d.hx, d.x1 - d.hx, 1.04, 1.95, d.z0 - d.hz, d.z1 - d.hz, 40);     // 上半
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(U, 2));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(C, 3));
  geo.setIndex(I);
  // ⚠ 门是独立 Mesh（不跟着区块一起烘焙），用的是受光的 MeshLambertMaterial：
  // 没有 normal 属性时 NdotL 恒为 0 ⇒ 整扇门渲染成纯黑方块。法线必须在 setIndex 之后算。
  geo.computeVertexNormals();
  geo.computeBoundingSphere();
  geo.userData.shared = true;
  doorGeoCache.set(dir, geo);
  return geo;
}
function ensureDoorObj(d) {
  const key = d.x + ',' + d.y + ',' + d.z;
  const openNow = !!(getMeta(d.x, d.y, d.z) & 4);
  const dd = DOOR_DEF[d.dir] || DOOR_DEF[1];
  let o = doorObjs.get(key);
  if (!o) {
    const g = new THREE.Group();
    const dm = new THREE.Mesh(doorGeometry(d.dir), solidMat);
    dm.castShadow = true; dm.receiveShadow = true;         // 和区块网格一致：门也挡光/吃光
    g.add(dm);
    g.position.set(d.x + dd.hx, d.y, d.z + dd.hz);
    g.rotation.y = openNow ? dd.a : 0;
    scene.add(g);
    o = { group: g, dir: d.dir, p: openNow ? 1 : 0, targetP: openNow ? 1 : 0, a: dd.a };
    doorObjs.set(key, o);
  }
  o.targetP = openNow ? 1 : 0;
  return o;
}
function syncDoors() {
  const live = new Set();
  for (const ch of chunks.values()) {
    const ds = ch.doors;
    if (!ds || !ds.length) continue;
    for (const d of ds) { live.add(d.x + ',' + d.y + ',' + d.z); ensureDoorObj(d); }
  }
  for (const [k, o] of doorObjs) if (!live.has(k)) { scene.remove(o.group); doorObjs.delete(k); }
}
function updateDoorAnims(dt) {
  const step = dt / 0.28;                                          // 固定 0.28 秒转完，跟帧率无关
  for (const o of doorObjs.values()) {
    if (o.p === o.targetP) continue;
    o.p = o.p < o.targetP ? Math.min(o.targetP, o.p + step) : Math.max(o.targetP, o.p - step);
    o.group.rotation.y = o.a * easeOutCubic(o.p);                  // 先快后慢 = 丝滑
  }
}
let doorSyncT = 0, torchT = 0;

/* ── 分片网格化 ────────────────────────────────────────────────────
   一块 = 16×16×96，整块网格化要 5~6ms，一帧吃掉这么多就会掉帧。
   拆成「开始 / 每次推进若干层 / 收尾三步」，streamChunks 每帧只推进到预算用完为止。 */
function startChunkMesh(chunk) {
  const CH = CFG.CH, WH = CFG.WH;
  const ox = chunk.cx * CH, oz = chunk.cz * CH;
  // 邻居还没加载时，边界面会被当成实心（省掉 8 次连锁生成）。记下来，等邻居齐了再重建一次。
  let missingNb = false;
  for (let ax = -1; ax <= 1 && !missingNb; ax++) for (let az = -1; az <= 1; az++) {
    if (!ax && !az) continue;
    if (!chunks.has((chunk.cx + ax) + ',' + (chunk.cz + az))) { missingNb = true; break; }
  }
  chunk.stale = missingNb;
  chunk.ready = false;
  chunk.job = {
    y: 0, ox, oz, doorCells: [], torches: [],
    P: [], U: [], C: [], I: [], P2: [], U2: [], C2: [], I2: [],
    P3: [], U3: [], C3: [], I3: [], P4: [], U4: [], C4: [], I4: [],   // P4 = 植物十字面片
    vc: 0, vw: 0, vg: 0, vp: 0,
  };
}
function stepChunkMesh(chunk, yTo) {                    // 推进到第 yTo 层（不含），返回当前层
  const j = chunk.job;
  if (!j) return CFG.WH;
  const CH = CFG.CH, WH = CFG.WH, ox = j.ox, oz = j.oz;
  const { P, U, C, I, P2, U2, C2, I2, P3, U3, C3, I3, P4, U4, C4, I4 } = j;
  let vc = j.vc, vw = j.vw, vg = j.vg, vp = j.vp;
  const yEnd = Math.min(WH, Math.max(j.y + 1, yTo | 0));
  for (let y = j.y; y < yEnd; y++) for (let z = 0; z < CH; z++) for (let x = 0; x < CH; x++) {
    const id = chunk.blocks[(y * CH + z) * CH + x];
    if (!id) continue;
    const def = BLOCKS[id];
    if (!def) continue;
    const wx = ox + x, wz = oz + z;
    const meta = (blockMeta.size || genMeta.size) ? getMeta(wx, y, wz) : 0;
    if (def.stair) { vc += emitStair(x, y, z, def, meta, P, U, C, I, vc); continue; }
    if (def.bed) { vc += emitBed(x, y, z, wx, wz, meta, P, U, C, I, vc); continue; }
    if (def.cross) { vp += emitCross(x, y, z, def, P4, U4, C4, I4, vp); if (def.torch) j.torches.push(wx + ',' + y + ',' + wz); continue; }
    if (def.door) {                                      // 门：独立 Mesh（可平滑旋转），只记下位置
      if (!(meta & 8)) j.doorCells.push({ x: wx, y, z: wz, dir: (meta & 3) + 1 });
      continue;
    }
    const water = id === 5;
    const glass = id === 22;
    const solidTop = def.half || 1;                       // 床这类半格方块
    let wch = null;                                       // 水面角点高度缓存
    for (let fi = 0; fi < 6; fi++) {
      const f = FACES[fi];
      const nb = peekBlock(wx + f.n[0], y + f.n[1], wz + f.n[2]);
      if (water) { if (nb !== 0) continue; }
      else if (glass) { if (nb === 22 || nb === 5) continue; }          // 玻璃之间不画内面
      // ⚠ 半格方块（床）和门都不是满格：照旧把邻面剔掉，邻居朝向它们的那一面会整面消失
      // → 从床上/门缝看过去能直接穿进方块里。非满格邻居一律照画。
      else if (nb !== 0 && nb !== 5 && nb !== 22 && !(BLOCKS[nb] && (BLOCKS[nb].half || BLOCKS[nb].door || BLOCKS[nb].cross))) continue;
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
        const sv = water || glass ? s
          : Math.min(1.1, s * (0.78 + 0.22 * (def.leaf ? 1 : vertexAO(wx, y, wz, f, V))));   // 只留轻 AO，明暗交给实时光照
        dc.push(sv, sv, sv);
      }
      const di = water ? I2 : glass ? I3 : I;
      di.push(base, base + 1, base + 2, base, base + 2, base + 3);
      if (water) vw += 4; else if (glass) vg += 4; else vc += 4;
    }
  }
  j.y = yEnd; j.vc = vc; j.vw = vw; j.vg = vg; j.vp = vp;
  return j.y;
}
function finishChunkMesh(chunk) {
  const j = chunk.job;
  if (!j || j.y < CFG.WH) return false;
  const ox = j.ox, oz = j.oz;
  const { P, U, C, I, P2, U2, C2, I2, P3, U3, C3, I3, P4, U4, C4, I4, doorCells } = j;
  const mk = (P_, U_, C_, I_, mat) => {
    if (!P_.length) return null;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(P_, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(U_, 2));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(C_, 3));
    geo.setIndex(I_);
    geo.computeVertexNormals();          // 受光材质必须有法线，否则整片全黑
    geo.computeBoundingSphere();
    const m = new THREE.Mesh(geo, mat);
    m.castShadow = true;
    m.receiveShadow = true;
    m.position.set(ox, 0, oz);
    m.frustumCulled = true;
    return m;
  };
  const nm = mk(P, U, C, I, solidMat);
  const ng = mk(P3, U3, C3, I3, glassMat);
  const np = mk(P4, U4, C4, I4, plantMat);
  const nw = mk(P2, U2, C2, I2, waterMat);
  if (chunk.mesh) { scene.remove(chunk.mesh); chunk.mesh.geometry.dispose(); }
  if (chunk.glass) { scene.remove(chunk.glass); chunk.glass.geometry.dispose(); }
  if (chunk.water) { scene.remove(chunk.water); chunk.water.geometry.dispose(); }
  if (chunk.plant) { scene.remove(chunk.plant); chunk.plant.geometry.dispose(); }
  chunk.mesh = nm; chunk.glass = ng; chunk.water = nw; chunk.plant = np;
  if (nm) scene.add(nm);
  if (ng) { ng.renderOrder = 1; scene.add(ng); }
  if (nw) { nw.renderOrder = 2; scene.add(nw); }
  if (np) { np.renderOrder = 3; scene.add(np); }
  chunk.ready = true;
  chunk.doors = doorCells;
  for (const t of j.torches) { const q = t.split(','); registerTorch(+q[0], +q[1], +q[2]); }
  chunk.job = null;
  return true;
}
function buildChunk(chunk) {                           // 同步整块（换维度 / 脏块重建 / 调试用）
  startChunkMesh(chunk);
  stepChunkMesh(chunk, CFG.WH);
  finishChunkMesh(chunk);
}

/* ============================================================ 玩家 */
const player = {
  p: new THREE.Vector3(8, 40, 8), v: new THREE.Vector3(),
  yaw: 0, pitch: 0, onGround: false,
  hp: 20, hunger: 20, alive: true, fly: false,
  swing: 0, walkPhase: 0, fallFrom: null, inWater: false, inLava: false, burn: 0,
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
  if (idef.dur || idef.kind === 'gun') {           // 工具/剑/能量炮：一把一格（炮还带电量 c）
    let left = n;
    for (let i = 0; i < SLOTS && left > 0; i++) if (!inv[i]) {
      inv[i] = idef.kind === 'gun' ? { id, n: 1, c: idef.cap || 8 } : { id, n: 1, d: idef.dur };
      left--;
    }
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
    if (BLOCKS[id] && BLOCKS[id].door && (getMeta(x, y, z) & 4)) continue;   // 开着的门可以直接穿过
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
  const copM = new THREE.MeshLambertMaterial({ color: 0xd98b4a });    // 铜：石与铁之间的中间档
  const netherM = new THREE.MeshLambertMaterial({ color: 0x7d6890 });  // 冥界钢：暗紫灰，比钻石更强的一档
  const diaM = new THREE.MeshLambertMaterial({ color: 0x5fe6d8 });
  if (id === 100 || id === 101 || id === 120 || id === 130 || id === 163 || id === 184) {  // 镐
    const head = id === 184 ? netherM : id === 130 ? diaM : id === 163 ? copM : id === 101 ? stoneM : id === 120 ? ironM : wood;
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
  } else if (id === 102 || id === 103 || id === 121 || id === 131 || id === 149 || id === 164 || id === 179) {       // 剑
    const bladeMat = id === 179 ? netherM : id === 131 ? diaM : id === 164 ? copM : id === 149 ? new THREE.MeshLambertMaterial({ color: 0xefe9d8 }) : id === 103 ? stoneD : id === 121 ? ironM : new THREE.MeshLambertMaterial({ color: 0xd9c49b });
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
  } else if (id === 158 || id === 159 || id === 160 || id === 165) {   // 锄头
    const headMat = id === 159 ? stoneM : id === 165 ? copM : id === 160 ? ironM : wood;
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
  } else if (id === 162) {                     // 铜锭（橙铜色，和铁锭同造型免得手里是空的）
    const a = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.07, 0.1), copM);
    a.position.y = 0.1;
    const b2 = new THREE.Mesh(new THREE.BoxGeometry(0.17, 0.055, 0.088), new THREE.MeshLambertMaterial({ color: 0xeaa96a }));
    b2.position.y = 0.15;
    g.add(a, b2);
  } else if (id === 177) {                     // 冥界碳：黑红晶体
    const cr = new THREE.Mesh(new THREE.OctahedronGeometry(0.13),
      new THREE.MeshLambertMaterial({ color: 0x1a1012, emissive: 0x7a1f2a, emissiveIntensity: 0.6 }));
    cr.position.y = 0.14; cr.scale.y = 1.35; cr.rotation.y = 0.6;
    g.add(cr);
  } else if (id === 178) {                     // 钢锭
    const steelM = new THREE.MeshLambertMaterial({ color: 0x95a3b0 });
    const a1 = new THREE.Mesh(new THREE.BoxGeometry(0.21, 0.07, 0.11), steelM);
    a1.position.y = 0.1;
    const sh = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.02, 0.06),
      new THREE.MeshLambertMaterial({ color: 0xdfe7ee }));
    sh.position.y = 0.145;
    g.add(a1, sh);
  } else if (id === 185) {                     // 电路板
    const board = new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.018, 0.2),
      new THREE.MeshLambertMaterial({ color: 0x2e9a63 }));
    board.position.y = 0.08;
    const trace = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.01, 0.03),
      new THREE.MeshLambertMaterial({ color: 0xd98b4a }));
    trace.position.set(0, 0.094, 0.03);
    const chip = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.03, 0.06),
      new THREE.MeshLambertMaterial({ color: 0x101820 }));
    chip.position.set(-0.03, 0.1, -0.03);
    g.add(board, trace, chip);
  } else if (id === 186) {                     // 电线：一圈铜色线圈
    const cop = new THREE.MeshLambertMaterial({ color: 0xb8702f });
    for (let i = 0; i < 3; i++) {
      const ring = new THREE.Mesh(new THREE.TorusGeometry(0.12, 0.028, 6, 14), cop);
      ring.position.y = 0.06 + i * 0.09;
      ring.rotation.x = Math.PI / 2;
      g.add(ring);
    }
  } else if (id === 187) {                     // 铀：荧光绿晶体
    const u = new THREE.Mesh(new THREE.OctahedronGeometry(0.13),
      new THREE.MeshLambertMaterial({ color: 0x6fdc3a, emissive: 0x2f8f18, emissiveIntensity: 0.9 }));
    u.position.y = 0.15; u.scale.y = 1.3; u.rotation.y = 0.5;
    g.add(u);
  } else if (ITEMS[id] && ITEMS[id].kind === 'gun') {   // 能量炮：机匣 + 炮管 + 线圈 + 发光炮口
    const metal = id === 191 ? 0x7d6890 : id === 190 ? 0x5fe6d8 : id === 189 ? 0xd9dee5 : 0xd98b4a;
    const glow = id === 191 ? 0xc08cff : id === 190 ? 0x7dffe8 : id === 189 ? 0xbfe4ff : 0xffb066;
    const bodyM = new THREE.MeshLambertMaterial({ color: 0x2b323b });
    const metalM = new THREE.MeshLambertMaterial({ color: metal });
    const glowM = new THREE.MeshBasicMaterial({ color: glow });
    const body = new THREE.Mesh(new THREE.BoxGeometry(0.11, 0.12, 0.44), bodyM);
    body.position.set(0, 0.01, -0.05);
    const barrel = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.07, 0.3), metalM);
    barrel.position.set(0, 0.03, -0.33);
    const coil = new THREE.Mesh(new THREE.TorusGeometry(0.075, 0.014, 6, 14), metalM);
    coil.position.set(0, 0.03, -0.18);
    const muzzle = new THREE.Mesh(new THREE.TorusGeometry(0.055, 0.012, 6, 12), glowM);
    muzzle.position.set(0, 0.03, -0.46);
    const grip = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.18, 0.07), bodyM);
    grip.position.set(0, -0.12, 0.04); grip.rotation.x = 0.22;
    const cell = new THREE.Mesh(new THREE.BoxGeometry(0.045, 0.045, 0.045), glowM);
    cell.position.set(0, 0.09, 0.04);
    g.add(body, barrel, coil, muzzle, grip, cell);
  } else if (id === 175) {                     // 传送块：发光紫色立方
    const cube = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.2, 0.2),
      new THREE.MeshLambertMaterial({ color: 0x8b3fd8, emissive: 0x5a1f9c, emissiveIntensity: 0.9 }));
    cube.position.y = 0.12; cube.rotation.y = 0.5;
    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.13, 0.012, 6, 16),
      new THREE.MeshBasicMaterial({ color: 0x7ff3e8 }));
    ring.position.y = 0.12; ring.rotation.x = Math.PI / 2;
    g.add(cube, ring);
  } else if (id === 176) {                     // 冥火碎片
    const shard = new THREE.Mesh(new THREE.ConeGeometry(0.09, 0.26, 4),
      new THREE.MeshLambertMaterial({ color: 0xff7a18, emissive: 0xff5a08, emissiveIntensity: 0.7 }));
    shard.position.y = 0.16; shard.rotation.y = 0.7;
    g.add(shard);
  } else if (id === 170) {                     // 木片：三片薄木屑叠着
    const chipMat = new THREE.MeshLambertMaterial({ color: 0xc0955a });
    for (const [x, y, z, a] of [[0, 0.05, 0, 0.18], [-0.05, 0.11, 0.05, -0.35], [0.06, 0.16, -0.04, 0.5]]) {
      const chip = new THREE.Mesh(new THREE.BoxGeometry(0.21, 0.022, 0.07), chipMat);
      chip.position.set(x, y, z); chip.rotation.z = a; chip.rotation.y = a * 1.4;
      g.add(chip);
    }
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
  hoe: { rx: -0.3, ry: 0.9, rz: 0.3, py: 0.07, pz: -0.12, s: 0.95 },
  food: { rx: 0.1, ry: 0.45, rz: 0.18, py: 0.06, pz: -0.1, s: 1.0 },
  gun: { rx: -0.06, ry: 0.12, rz: 0.02, py: 0.02, pz: -0.02, s: 1.0 },
};
function refreshHeld() {
  refreshGunHud();                     // 手上的能量炮电量读数（不是炮就自己隐藏）
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
  if (b && b.cross) {                          // 火把/草丛/花：手里也是十字面片，跟地上一致
    kind = 'mat';
    const tile = b.top;
    const u0 = (tile % ATLAS_COLS) / ATLAS_COLS, v0 = 1 - (((tile / ATLAS_COLS) | 0) + 1) / ATLAS_ROWS;
    const iu = 1 / ATLAS_COLS, iv = 1 / ATLAS_ROWS;
    const g = new THREE.Group();
    for (const ry of [0, Math.PI / 2]) {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(
        [-0.2, -0.22, 0, 0.2, -0.22, 0, 0.2, 0.22, 0, -0.2, 0.22, 0], 3));
      geo.setAttribute('uv', new THREE.Float32BufferAttribute(
        [u0, v0, u0 + iu, v0, u0 + iu, v0 + iv, u0, v0 + iv], 2));
      geo.setAttribute('color', new THREE.Float32BufferAttribute([1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1], 3));
      geo.setIndex([0, 1, 2, 0, 2, 3]);
      geo.computeVertexNormals();
      const q = new THREE.Mesh(geo, plantMat);
      q.rotation.y = ry;
      g.add(q);
    }
    heldMesh = g;
  } else if (b) {
    kind = 'block';
    const mats = [b.side, b.side, b.top, b.bottom ?? b.top, b.side, b.side].map(blockFaceMat);
    heldMesh = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.2, 0.2), mats);
  } else if (it && (it.kind === 'pick' || it.kind === 'sword' || it.kind === 'hoe' || it.kind === 'mat' || it.kind === 'food' || it.kind === 'gun')) {
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
  // ── Action & Stuff 风格：二阶弹簧滞后 + 各种状态权重 + 连击方向
  lagX: 0, lagY: 0, lagVX: 0, lagVY: 0,
  sprintK: 0, airK: 0, hurtK: 0, waterK: 0,
  swingN: 0, biteK: 0, bowK: 0,
};
const BASE_POSE = { x: 0.27, y: -0.22, z: -0.27, rx: -0.2, ry: -0.34, rz: 0.12 };
function startSwing(type = 'attack', dur = 0.5) {
  anim.swingType = type;
  anim.swingDur = dur;
  anim.swing = dur;
  if (type === 'attack' || type === 'dig') anim.swingN++;    // 连击交替方向（左一下右一下，像 A&S）
  // 联机：把这一下动作广播出去，别人的画面里我也要挥起来
  if (typeof NET !== 'undefined' && NET && NET.active && NET.castAct) { try { NET.castAct(type); } catch (e) {} }
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
  // ── 视角拖尾改成二阶弹簧（不是一阶 lerp）：镜头甩过去手会「跟一下再回弹」，这是 A&S 的核心手感
  const wantX = clamp(-dyaw * 2.4, -0.13, 0.13);
  const wantY = clamp(dpitch * 2.4, -0.13, 0.13);
  const K = 62, D = 13;                                  // 刚度/阻尼（dt 已 clamp 到 0.1，稳定）
  anim.lagVX += ((wantX - anim.lagX) * K - anim.lagVX * D) * dt;
  anim.lagVY += ((wantY - anim.lagY) * K - anim.lagVY * D) * dt;
  anim.lagX += anim.lagVX * dt;
  anim.lagY += anim.lagVY * dt;
  anim.swayX = anim.lagX; anim.swayY = anim.lagY;        // 后面的代码继续用 swayX/swayY

  // ── 状态权重（帧率无关的指数平滑，60fps/30fps 手感一致）
  const easeK = (rate) => 1 - Math.exp(-rate * dt);
  const spd0 = Math.hypot(player.v.x, player.v.z);
  const sprintT = clamp01((spd0 - CFG.WALK * 0.92) / Math.max(0.1, CFG.SPRINT - CFG.WALK * 0.92));
  anim.sprintK += ((player.onGround ? sprintT : sprintT * 0.7) - anim.sprintK) * easeK(7);
  anim.airK += ((player.onGround || player.inWater || player.inLava ? 0 : 1) - anim.airK) * easeK(9);
  anim.waterK += ((player.inWater || player.inLava ? 1 : 0) - anim.waterK) * easeK(5);
  anim.hurtK = Math.max(0, anim.hurtK - dt * 3.4);
  const fallSpd = clamp01(Math.max(0, -player.v.y) / 14);   // 下落越快手抬得越高
  const riseSpd = clamp01(Math.max(0, player.v.y) / 9);     // 起跳瞬间手往下压

  let px = BASE_POSE.x + anim.swayX;
  let py = BASE_POSE.y + anim.swayY;
  let pz = BASE_POSE.z;
  let rx = BASE_POSE.rx, ry = BASE_POSE.ry + anim.swayX * 0.4, rz = BASE_POSE.rz;

  // 呼吸 + 走路摆动（疾跑幅度更大、节奏更快；水里幅度减半）
  const t = now / 1000;
  const walkAmt = clamp01(spd0 / CFG.WALK) * (1 - anim.waterK * 0.55);
  const bobAmp = 0.013 + 0.011 * anim.sprintK;
  py += Math.sin(t * 1.5) * 0.0045
      + Math.sin(player.walkPhase * 2) * bobAmp * walkAmt
      + Math.sin(t * 2.2) * 0.004 * anim.waterK;              // 水里慢半拍的浮动
  px += Math.cos(player.walkPhase) * (0.008 + 0.006 * anim.sprintK) * walkAmt;
  rz += Math.sin(player.walkPhase) * (0.022 + 0.018 * anim.sprintK) * walkAmt;
  rx += Math.cos(player.walkPhase * 2) * 0.010 * walkAmt;

  // 疾跑：手往后方收 + 外翻（A&S 的冲刺姿态），顺带压低一点
  px -= 0.018 * anim.sprintK; py -= 0.022 * anim.sprintK; pz += 0.030 * anim.sprintK;
  rz -= 0.070 * anim.sprintK; ry += 0.090 * anim.sprintK; rx += 0.050 * anim.sprintK;
  // 腾空：起跳往下压、下落往上飘（下落越快抬得越高），落地再接一下缓冲
  px += 0.012 * anim.airK;
  py += (0.030 * fallSpd - 0.045 * riseSpd) * anim.airK;
  rz += 0.020 * anim.airK;
  // 受伤：手被震得往后缩一下
  pz += 0.055 * anim.hurtK; px -= 0.020 * anim.hurtK;
  rx -= 0.200 * anim.hurtK; rz += 0.160 * anim.hurtK;

  // 挖掘：0.5 秒一轮的缓慢抬砸，并且**每轮换一侧斜着凿**（A&S 的挖掘会左右交替，不像机器）
  const mining = mineHeld && player.alive && !!player.mineTarget;
  anim.mineW += ((mining ? 1 : 0) - anim.mineW) * Math.min(1, dt * 9);
  if (mining) anim.mineT += dt; else anim.mineT = 0;
  let aTotal = 0, mSide = 1;
  if (anim.mineW > 0.01) {
    const cyc = anim.mineT / 0.5;
    const p = cyc % 1;
    const a = swingCurve(p, 0.52, 0.70);
    mSide = (Math.floor(cyc) % 2) ? -1 : 1;
    aTotal += a * anim.mineW;
  }
  // 单次挥击（攻击 / 放置 / 用工具）
  if (anim.swing > 0) {
    anim.swing = Math.max(0, anim.swing - dt);
    const p = 1 - anim.swing / anim.swingDur;
    if (anim.swingType === 'bow') {
      anim.bowK = p < 0.55 ? p / 0.55 : Math.max(0, 1 - (p - 0.55) / 0.18);
      anim.swingA = 0;
    } else {
      anim.bowK = 0;
      const a = anim.swingType === 'place' ? Math.sin(clamp01(p) * Math.PI)   // 放置 = 轻轻一推
              : anim.swingType === 'dig'   ? swingCurve(p, 0.42, 0.66)        // 用工具凿
              : swingCurve(p, 0.3, 0.52);                                     // 攻击 = 蓄力再砸
      anim.swingA = a;
      aTotal += a * (anim.swingType === 'place' ? 0.55 : 1);
    }
  } else { anim.swingA = 0; anim.bowK = 0; }

  // 每种手持物的挥击手感不同：剑=斜劈、镐=斜下凿、锄/材料=小幅度、空手/方块=直推
  const PROF = {
    sword: { rx: 0.80, ry: 0.26, rz: 0.36, push: 0.075 },
    pick:  { rx: 0.64, ry: 0.16, rz: 0.20, push: 0.055 },
    hoe:   { rx: 0.56, ry: 0.18, rz: 0.24, push: 0.050 },
    mat:   { rx: 0.42, ry: 0.10, rz: 0.16, push: 0.040 },
    block: { rx: 0.34, ry: 0.08, rz: 0.10, push: 0.060 },
    food:  { rx: 0.30, ry: 0.08, rz: 0.10, push: 0.040 },
    bow:   { rx: 0.30, ry: 0.08, rz: 0.10, push: 0.040 },
  };
  const prof = PROF[heldKindNow] || PROF.block;
  const side = anim.swing > 0 ? ((anim.swingN % 2) ? -1 : 1) : mSide;
  rx += aTotal * prof.rx;
  ry += aTotal * prof.ry * side;
  rz += aTotal * prof.rz * side;
  px += 0.020 * Math.max(0, aTotal) * side;
  pz += -prof.push * Math.max(0, aTotal);
  // 弓：前 55% 往后拉弦，之后啪地弹回去
  if (anim.bowK > 0) {
    const k = anim.bowK;
    px -= 0.02 * k; py -= 0.035 * k; pz += 0.11 * k;
    rx -= 0.5 * k; rz -= 0.14 * k;
  }

  // 装备动画：从下方甩上来（钟形曲线 + 一点旋转，像把东西"拎"出来）
  if (anim.equip > 0) {
    anim.equip = Math.max(0, anim.equip - dt);
    const dip = Math.sin(clamp01(anim.equip / anim.equipDur) * Math.PI);
    py -= 0.30 * dip; rz += 0.26 * dip; rx += 0.26 * dip; ry -= 0.10 * dip;
  }
  // 落地缓冲：按冲击强度缩放（anim.land = 1 表示从 6 格高摔下来）
  anim.land = Math.max(0, anim.land - dt * 3.2);
  py -= anim.land * 0.055;
  rx += anim.land * 0.10;
  rz += anim.land * 0.04;

  // 吃东西：手抬到嘴边 + 每口一下的咀嚼（Action & Stuff 手感）
  anim.biteK = Math.max(0, (anim.biteK || 0) - dt * 3.2);
  if (eatState.on) {
    const k = clamp01(eatState.t / 0.22);                  // 抬手进度
    const ch = anim.biteK;                                 // 0..1 每口冲击
    const nib = Math.sin(now / 52) * 0.007 * k;            // 细微啃咬抖动
    px = BASE_POSE.x - 0.10 * k + anim.swayX * 0.5;
    py = BASE_POSE.y + 0.06 * k - 0.035 * ch + nib;        // 抬到嘴边（手保持在画面右下，别糊屏）
    pz = BASE_POSE.z - 0.02 * k;
    rx = BASE_POSE.rx + 0.15 * k + 0.12 * ch;
    ry = BASE_POSE.ry + anim.swayX * 0.25;
    rz = BASE_POSE.rz - 0.12 * k + 0.04 * ch;
  }
  armR.position.set(px, py, pz);
  armR.rotation.set(rx, ry, rz);
  // 左手：比右手更"慢"、并且反向摆（走路时两手交替），A&S 里两只手都有存在感
  armL.position.set(
    -0.28 - anim.swayX * 0.62 - Math.cos(player.walkPhase) * 0.010 * walkAmt,
    -0.26 + anim.swayY * 0.72 - anim.land * 0.050
        + Math.sin(player.walkPhase * 2) * 0.010 * walkAmt - 0.020 * anim.sprintK,
    -0.25 + 0.020 * anim.sprintK
  );
  armL.rotation.set(
    -0.26 + anim.swayY * 0.25 - aTotal * 0.10 + anim.airK * 0.10,
    0.40 + anim.swayX * 0.30,
    -0.12 - Math.sin(player.walkPhase) * 0.030 * walkAmt + 0.030 * anim.sprintK
  );

  // 手里的东西也跟着挥（幅度按手持物类型走）
  if (heldMesh) {
    const pose = HOLD_POSE[heldKindNow] || HOLD_POSE.block;
    heldGroup.rotation.set(pose.rx + aTotal * prof.rx * 0.45,
                           pose.ry - aTotal * prof.ry * 0.60 * side,
                           pose.rz + aTotal * prof.rz * 0.70 * side);
    heldGroup.position.set(0.01, pose.py - Math.max(0, aTotal) * 0.02, -0.54 + pose.pz - Math.max(0, aTotal) * 0.05);
    if (eatState.on) {                                     // 吃东西：把食物端到嘴边（抬手时略微上抬 + 每口前送）
      const ch2 = anim.biteK;
      heldGroup.position.set(0.02, 0.05 - 0.03 * ch2, -0.34 - 0.04 * ch2);
      heldGroup.rotation.set(-0.2, 0.3, 0.1);
    }
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
  if (torchNear(x, y, z, 8)) return false;      // 火把照亮的地方不会刷怪
  if (!isSkyLit(x, y, z)) return true;
  return lightLevel < 0.35;
}
/* ── 火把光照：只在玩家附近点亮 6 个点光源（性能友好），并且照亮周围方块/生物 ── */
const torchCells = new Map();               // 'x,y,z' → {x,y,z}
const torchLights = [];
for (let i = 0; i < 6; i++) {
  const pl = new THREE.PointLight(0xffb45a, 0, 22, 0.85);
  pl.castShadow = false;                                  // 点光源阴影 = 6 次全场景重绘，手机上太贵：只保留太阳阴影
  if (pl.castShadow) { pl.shadow.mapSize.set(512, 512); pl.shadow.bias = -0.004; pl.shadow.camera.far = 16; }
  pl.visible = false;
  scene.add(pl);
  torchLights.push(pl);
}
function registerTorch(x, y, z) {
  const k = x + ',' + y + ',' + z;
  if (torchCells.has(k)) return;                 // 重建时重复登记不算变动（否则会无限重建）
  torchCells.set(k, { x, y, z });
  torchLastKey = x + ',' + z;
}
function unregisterTorch(x, y, z) {
  const k = x + ',' + y + ',' + z;
  if (!torchCells.has(k)) return;
  torchCells.delete(k);
  torchLastKey = x + ',' + z;
}
let torchSig = -1, torchLastKey = null;
function refreshTorchArea() {                    // 只重建「变动的那一支火把」周围的区块（原来是全场火把 → 一次放火把重建上百区块 = 卡 1 秒）
  if (!torchLastKey) return;
  const [tx, tz] = torchLastKey.split(',').map(Number);
  const cx = Math.floor(tx / CFG.CH), cz = Math.floor(tz / CFG.CH);
  markDirty(cx, cz);
  markDirty(cx + 1, cz); markDirty(cx - 1, cz);
  markDirty(cx, cz + 1); markDirty(cx, cz - 1);
}
function updateTorchLights() {
  torchSig = torchCells.size;                    // 只记录，不重建区块（实时光照不用重烘焙）
  if (!torchCells.size) { for (const l of torchLights) l.visible = false; return; }
  const px = player.p.x, py = player.p.y, pz = player.p.z;
  const near = [];
  for (const t of torchCells.values()) {
    const d = (t.x - px) * (t.x - px) + (t.y - py) * (t.y - py) + (t.z - pz) * (t.z - pz);
    if (d > 26 * 26) continue;
    near.push({ t, d });
  }
  near.sort((a, b) => a.d - b.d);
  for (let i = 0; i < torchLights.length; i++) {
    const l = torchLights[i], e = near[i];
    if (!e) { l.visible = false; continue; }
    l.position.set(e.t.x + 0.5, e.t.y + 0.62, e.t.z + 0.5);
    l.intensity = 11.0 + Math.sin(worldTime * 6 + e.t.x) * 1.2;   // 大幅加强（原来 3.4）
    l.visible = true;
  }
}
/* ── 手持火把发光 ──────────────────────────────────────────────────
   玩家或村民手里拿着火把（方块 38）时，一个共享点光源跟着「离镜头最近的那个火把」走。
   只加 1 盏灯：点位光每多一盏都会让所有材质重编一次着色器，手机上吃不消。 */
const heldTorchLight = new THREE.PointLight(0xffb45a, 0, 17, 0.9);
heldTorchLight.visible = false;
scene.add(heldTorchLight);
let heldTorchT = 0;
function updateHeldTorchLight(dt) {
  heldTorchT -= dt;
  if (heldTorchT > 0) return;
  heldTorchT = 0.2;
  const cand = [];
  const h = held();
  if (h && h.id === 38) cand.push({ x: player.p.x, y: player.p.y + 1.15, z: player.p.z });
  for (const m of mobs) {
    if (m.dying || !m.give || m.give.id !== 38) continue;
    cand.push({ x: m.p.x, y: m.p.y + 1.3, z: m.p.z });
  }
  let best = null, bd = 40 * 40;
  const cx = camera.position.x, cy = camera.position.y, cz = camera.position.z;
  for (const c of cand) {
    const d2 = (c.x - cx) ** 2 + (c.y - cy) ** 2 + (c.z - cz) ** 2;
    if (d2 < bd) { bd = d2; best = c; }
  }
  if (!best) { heldTorchLight.visible = false; return; }
  heldTorchLight.position.set(best.x, best.y, best.z);
  heldTorchLight.intensity = 8.5 + Math.sin(performance.now() * 0.0062) * 0.9;
  heldTorchLight.visible = true;
}
function torchNear(x, y, z, r) {            // 附近有没有火把（用来阻止刷怪）
  const r2 = r * r;
  for (const t of torchCells.values()) {
    const dx = t.x - x, dy = t.y - y, dz = t.z - z;
    if (dx * dx + dy * dy + dz * dz <= r2) return true;
  }
  return false;
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
const skyNow = new THREE.Color();
function updateNetherSky() {
  lightLevel = 0.55;                                  // 冥界没有昼夜，固定昏暗
  skyNow.setHex(0x2a0a10);
  scene.background = skyNow;
  scene.fog.color.copy(skyNow);
  scene.fog.near = 10; scene.fog.far = 46;
  worldLight.intensity = 0.55; worldAmb.intensity = 0.32; worldDir.intensity = 0.10;
  worldDir.visible = false;                           // 冥界没有太阳，别算阴影
  solidMat.color.setScalar(0.92);
  waterMat.color.setScalar(1);
  dl.intensity = 0.72;
  return 0.55;
}
function updateSky() {
  if (DIM === 'nether') return updateNetherSky();
  const f = ((worldTime / CFG.DAY) % 1 + 1) % 1;
  const sunAlt = Math.sin(f * Math.PI * 2); // f=0 黎明, .25 正午, .5 黄昏, .75 午夜
  const day = smooth(-0.12, 0.3, sunAlt);
  lightLevel = 0.22 + 0.78 * day;
  skyNow.copy(skyNight).lerp(skyDay, day);
  const sunset = clamp01(1 - Math.abs(sunAlt) / 0.32) * clamp01(day * 3 + 0.2);
  skyNow.lerp(skySet, sunset * 0.55);
  // ⚠ 已按用户要求【去掉「进洞穴天空变黑」这个特性】：地下不再改天空颜色、不再收窄雾、也不再整体压暗。
  //    白天进洞就是正常天光（caveMix 仍照旧更新，留给音效回响等其它用途）。
  scene.background = skyNow;
  scene.fog.color.copy(skyNow);
  scene.fog.near = 34;
  scene.fog.far = 92;
  const f2 = 0.4 + 0.6 * lightLevel;
  worldLight.intensity = 0.55 + 0.45 * lightLevel;      // 半球光：夜里也有基础亮度
  worldAmb.intensity = 0.26 + 0.10 * lightLevel;        // 环境光兜底
  worldDir.intensity = 0.12 + 0.95 * lightLevel;        // 太阳：白天强投影，夜里几乎没有
  worldDir.visible = lightLevel > 0.25;                 // 夜里关掉太阳阴影（省钱且更真实）
  const sa = ((worldTime / CFG.DAY) % 1) * Math.PI * 2; // 太阳绕一圈 → 影子会转
  worldDir.position.set(player.p.x + Math.cos(sa) * 60, player.p.y + 70, player.p.z + Math.sin(sa) * 60);
  worldDir.target.position.set(player.p.x, player.p.y, player.p.z);
  worldDir.target.updateMatrixWorld();
  worldDir.shadow.camera.updateProjectionMatrix();
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
const STRUCT_MIN_GAP = 48;                 // 结构之间的最小间隔（原来 34，太密：同一个视野里能看见好几座）
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
/* ── 结构「落地」：自然生成的结构用「footprint 里最高的地形」当 gy，
   斜坡下坡那侧就会悬空（实测小屋地板离草皮空 1 格、塔/井/石阵同理）。
   这里把「地面那一层」（y <= gy+1）每个方块下面、直到地形高度之间的空隙用基础块填实。
   ⚠ 只填到地形，不往洞里填；遇到结构自己的方块就停（说明这列本来就接着）。
   ⚠ 必须在结构自己的 put 之后调用（只往 ops 末尾追加，不会覆盖结构本身的方块）。 */
function supportBase(ops, gy, blockId = 9, yMax = null) {
  const top = yMax === null ? gy + 1 : yMax;
  const has = new Set();
  for (const op of ops) if (op.t) has.add(op.x + ',' + op.y + ',' + op.z);
  const add = [];
  for (const op of ops) {
    if (!op.t || op.t === 5 || op.y > top) continue;
    // heightAt 是「地表高度」，但地表下面可能正好有条洞穴把这一列掏空了（小屋压洞上照样悬空）。
    // 所以往下多补 8 格：空地/洞穴会被填实，已经实心的地形被覆盖成圆石也无所谓（都在地下看不见）。
    const ground = heightAt(op.x, op.z) - 8;
    for (let y = op.y - 1; y > ground && y > 0; y--) {
      const key = op.x + ',' + y + ',' + op.z;
      if (has.has(key)) break;
      add.push({ x: op.x, y, z: op.z, t: blockId });
    }
  }
  for (const a of add) ops.push(a);
  return add.length;
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
    if (roll > 0.62) {                      // 石塔：58% → 38% 的格子
      const rnd = mulberry32((Math.floor(roll * 1e9) ^ Math.imul(cellX, 2246822519) ^ Math.imul(cellZ, 3266489917)) | 0);
      const cx = cellX * TW_CELL + 60 + Math.floor(rnd() * (TW_CELL - 120));
      const cz = cellZ * TW_CELL + 60 + Math.floor(rnd() * (TW_CELL - 120));
      const ops = [], put = (x, y, z, t, m) => ops.push({ x, y, z, t, m }), carve = (x, y, z) => ops.push({ x, y, z, t: 0 });
      let gy = 0;
      for (let dx = -3; dx <= 3; dx++) for (let dz = -3; dz <= 3; dz++) gy = Math.max(gy, heightAt(cx + dx, cz + dz));
      if (gy > CFG.SEA + 3 && gy < SURF_OFF + 40 && !structNear(cx, cz, 'tower')) {
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
        supportBase(ops, gy, 9);                              // 落地：斜坡下坡侧补地基
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
    if (roll > 0.68) {                      // 水井：50% → 32%
      const rnd = mulberry32((Math.floor(roll * 1e9) ^ Math.imul(cellX, 668265263) ^ Math.imul(cellZ, 374761393)) | 0);
      const cx = cellX * WL_CELL + 40 + Math.floor(rnd() * (WL_CELL - 80));
      const cz = cellZ * WL_CELL + 40 + Math.floor(rnd() * (WL_CELL - 80));
      const gy = heightAt(cx, cz);
      const ops = [], put = (x, y, z, t, m) => ops.push({ x, y, z, t, m }), carve = (x, y, z) => ops.push({ x, y, z, t: 0 });
      if (gy > CFG.SEA + 2 && gy < SURF_OFF + 44 && !structNear(cx, cz, 'well')) {
        for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
          const edge = Math.abs(dx) === 1 || Math.abs(dz) === 1;
          put(cx + dx, gy, cz + dz, edge ? 9 : 5);
          carve(cx + dx, gy + 1, cz + dz);
        }
        for (const p of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) for (let y = 1; y <= 3; y++) put(cx + p[0], gy + y, cz + p[1], 28);
        for (let dx = -2; dx <= 2; dx++) for (let dz = -2; dz <= 2; dz++) put(cx + dx, gy + 4, cz + dz, 34);
        supportBase(ops, gy, 9);
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
    if (roll > 0.72) {                      // 石阵：45% → 28%
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
      if (ok && gy > CFG.SEA + 2 && gy < SURF_OFF + 44 && !structNear(cx, cz, 'circle')) {
        const rr = 6 + Math.floor(rnd() * 3), n = 8 + Math.floor(rnd() * 4);
        for (let i = 0; i < n; i++) {
          const a = (i / n) * Math.PI * 2;
          const sx = Math.round(Math.cos(a) * rr), sz = Math.round(Math.sin(a) * rr);
          const hh = 2 + ((i * 7) % 3);
          const tile = i % 3 === 0 ? 30 : 26;                        // 花岗岩 / 立石
          for (let y = 1; y <= hh; y++) put(cx + sx, gy + y, cz + sz, tile);
        }
        put(cx, gy + 1, cz, 33);                                     // 中央祭台（石砖楼梯）
        supportBase(ops, gy, 9, gy + 2);                      // 石阵的石块立在地面上
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
    if (roll > 0.7) {                       // 营地：45% → 30%
      const rnd = mulberry32((Math.floor(roll * 1e9) ^ Math.imul(cellX, 971) ^ Math.imul(cellZ, 78233)) | 0);
      const cx = cellX * CP_CELL + 50 + Math.floor(rnd() * (CP_CELL - 100));
      const cz = cellZ * CP_CELL + 50 + Math.floor(rnd() * (CP_CELL - 100));
      const gy = heightAt(cx, cz);
      const ops = [], put = (x, y, z, t, m) => ops.push({ x, y, z, t, m }), carve = (x, y, z) => ops.push({ x, y, z, t: 0 });
      if (gy > CFG.SEA + 2 && gy < SURF_OFF + 44 && !structNear(cx, cz, 'camp')) {
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
        supportBase(ops, gy, 9);                              // 营地：外墙/篝石也要落地
        out = { name: 'camp', cx, cz, gy, byChunk: packOps(ops), ops: ops.length, label: '废墟营地' };
      }
    }
    campCache.set(key, out);
    return out;
  });
}

/* ── 传送门：高科技方块砌的拱门，无法破坏。中间的核心格插入「传送块」即可点亮，
   点亮的传送门再点一次 / 走进去 = 换维度。
   ⚠ 主世界生成的是「空门」（要插传送块）；冥界自然生成的是「已激活」的门，
   从冥界任何一座门走进去都会回到「你过来的那座主世界门」（player.fromPortal）。 */
const PT_CELL = 320, portalCache = new Map();
const NETHER_LAVA_Y = 32;                     // 岩浆海平面
function netherCeilAt(wx, wz) {               // 顶部岩壳的底面高度（60~64 起伏）
  return 60 + Math.round(h2(Math.floor(wx / 40), Math.floor(wz / 40)) * 4);
}
// 冥界「这一格是不是岩体」——地形生成和探针共用同一套公式，两边必须一致
function netherSolid(wx, y, wz) {
  if (y < NETHER_LAVA_Y) return false;                       // 下面全是岩浆海
  if (y >= netherCeilAt(wx, wz)) return true;                 // 顶部岩壳
  const d = y - NETHER_LAVA_Y;
  return n3(wx * 0.055, y * 0.085, wz * 0.055) + (d < 5 ? 0.16 : 0) > 0.5;
}
function netherRockTop(wx, wz) {              // 这一列最高的岩体（没有岩就是岩浆面）
  for (let y = 58; y > NETHER_LAVA_Y; y--) if (netherSolid(wx, y, wz)) return y;
  return NETHER_LAVA_Y;
}
function portalFor(cellX, cellZ) {
  const key = DIM + ':' + cellX + ',' + cellZ;          // ⚠ 必须带维度：同一格子两个维度各有一座
  if (portalCache.has(key)) return portalCache.get(key);
  return guarded('portal-' + DIM, key, () => {
    let out = null;
    const roll = h2(cellX * 61.7 + 3.3, cellZ * 44.1 - 9.1);
    if (roll > 0.5) {
      const rnd = mulberry32((Math.floor(roll * 1e9) ^ Math.imul(cellX, 1274126177) ^ Math.imul(cellZ, 2246822519)) | 0);
      const cx = cellX * PT_CELL + 70 + Math.floor(rnd() * (PT_CELL - 140));
      const cz = cellZ * PT_CELL + 70 + Math.floor(rnd() * (PT_CELL - 140));
      const ops = [], put = (x, y, z, t, m) => ops.push(m ? { x, y, z, t, m } : { x, y, z, t }), carve = (x, y, z) => ops.push({ x, y, z, t: 0 });
      const nether = DIM === 'nether';
      let mn = 999, mx = -999;
      if (nether) {
        for (let dx = -4; dx <= 4; dx += 2) for (let dz = -3; dz <= 3; dz += 3) {
          const hh = netherRockTop(cx + dx, cz + dz);
          if (hh < mn) mn = hh;
          if (hh > mx) mx = hh;
        }
      } else {
        for (let dx = -4; dx <= 4; dx++) for (let dz = -3; dz <= 3; dz++) {
          const hh = heightAt(cx + dx, cz + dz);
          if (hh < mn) mn = hh;
          if (hh > mx) mx = hh;
        }
      }
      // 冥界：地面必须是岩地（不是岩浆湖）、上方 8 格要有空间；冥界没有别的结构，跳过 structNear
      let netherOpen = true;
      if (nether) for (let dy = 1; dy <= 8; dy++) if (netherSolid(cx, mx + dy, cz)) { netherOpen = false; break; }
      const okHere = nether
        ? (mx - mn <= 3 && mn > NETHER_LAVA_Y + 2 && netherOpen)
        : (mx - mn <= 4 && mn > CFG.SEA + 2 && mx < SURF_OFF + 46 && !structNear(cx, cz, 'portal'));
      if (okHere) {
        const gy = mx;
        for (let dx = -3; dx <= 3; dx++) for (let dz = -2; dz <= 2; dz++) put(cx + dx, gy, cz + dz, 21);   // 高科技底座
        for (let dx = -2; dx <= 2; dx++) for (let dy = 1; dy <= 6; dy++) {                                  // 5×6 门框
          const edge = Math.abs(dx) === 2 || dy === 1 || dy === 6;
          if (edge) put(cx + dx, gy + dy, cz, 41);
          else carve(cx + dx, gy + dy, cz);
        }
        put(cx, gy + 2, cz, 45);                                                                            // 核心
        for (let dy = 7; dy <= 9; dy++) for (let dx = -3; dx <= 3; dx++) carve(cx + dx, gy + dy, cz);        // 门前清空
        if (nether) {                                                                                       // 冥界的门是「已激活」的
          for (let dx = -1; dx <= 1; dx++) for (let dy = 3; dy <= 5; dy++) put(cx + dx, gy + dy, cz, 42);
        }
        supportBase(ops, gy, nether ? 43 : 21, gy);
        out = { name: 'portal', cx, cz, gy, byChunk: packOps(ops), ops: ops.length, label: '传送门', active: nether };
      }
    }
    portalCache.set(key, out);
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
    if (roll > 0.65) {                      // 白桦木屋：55% → 35%
      const rnd = mulberry32((Math.floor(roll * 1e9) ^ Math.imul(cellX, 374761393) ^ Math.imul(cellZ, 668265263)) | 0);
      const cx = cellX * CB_CELL + 50 + Math.floor(rnd() * (CB_CELL - 100));
      const cz = cellZ * CB_CELL + 50 + Math.floor(rnd() * (CB_CELL - 100));
      const ops = [], put = (x, y, z, t, m) => ops.push({ x, y, z, t, m }), carve = (x, y, z) => ops.push({ x, y, z, t: 0 });
      const w = 3, d = 2, h = 3;
      let gy = 0;
      for (let dx = -w; dx <= w; dx++) for (let dz = -d; dz <= d; dz++) gy = Math.max(gy, heightAt(cx + dx, cz + dz));
      if (gy > CFG.SEA + 2 && gy < SURF_OFF + 42 && !structNear(cx, cz, 'cabin')) {
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
        supportBase(ops, gy, 9, gy);                          // 白桦木屋地板就在 gy 这一层
        out = { name: 'cabin', cx, cz, gy, byChunk: packOps(ops), ops: ops.length, label: '白桦木屋' };
      }
    }
    cabinCache.set(key, out);
    return out;
  });
}


/* ============================================================ 平原 + 玩家小屋（survivalbase1） */
function inPlain(wx, wz) {                       // 平原：大块低频噪声区域 → 草地为主、树很少
  const n = h2(Math.floor(wx / 88) * 3.71 + 11.3, Math.floor(wz / 88) * 5.37 - 7.9);
  return n > 0.34;
}
const CABIN_BLOCKS = "0,0,0,33,4;1,0,0,33,4;2,0,0,33,4;3,0,0,33,4;4,0,0,33,4;5,0,0,33,4;6,0,0,33,4;7,0,0,33,4;8,0,0,33,4;9,0,0,33,4;0,0,1,33,2;1,0,1,21,0;2,0,1,21,0;3,0,1,21,0;4,0,1,21,0;5,0,1,21,0;6,0,1,21,0;7,0,1,21,0;8,0,1,21,0;9,0,1,33,1;0,0,2,33,2;1,0,2,21,0;2,0,2,8,0;3,0,2,8,0;4,0,2,8,0;5,0,2,8,0;6,0,2,8,0;7,0,2,8,0;8,0,2,21,0;9,0,2,33,1;0,0,3,33,2;1,0,3,21,0;2,0,3,8,0;3,0,3,8,0;4,0,3,8,0;5,0,3,8,0;6,0,3,8,0;7,0,3,8,0;8,0,3,21,0;9,0,3,33,1;0,0,4,33,2;1,0,4,21,0;2,0,4,8,0;3,0,4,8,0;4,0,4,8,0;5,0,4,8,0;6,0,4,8,0;7,0,4,8,0;8,0,4,21,0;9,0,4,33,1;0,0,5,33,2;1,0,5,21,0;2,0,5,8,0;3,0,5,8,0;4,0,5,8,0;5,0,5,8,0;6,0,5,8,0;7,0,5,8,0;8,0,5,21,0;9,0,5,33,1;0,0,6,33,2;1,0,6,21,0;2,0,6,8,0;3,0,6,8,0;4,0,6,8,0;5,0,6,8,0;6,0,6,8,0;7,0,6,8,0;8,0,6,21,0;9,0,6,33,1;0,0,7,33,2;1,0,7,21,0;2,0,7,8,0;3,0,7,8,0;4,0,7,8,0;5,0,7,8,0;6,0,7,8,0;7,0,7,8,0;8,0,7,21,0;9,0,7,33,1;0,0,8,33,2;1,0,8,21,0;2,0,8,21,0;3,0,8,21,0;4,0,8,21,0;5,0,8,21,0;6,0,8,21,0;7,0,8,21,0;8,0,8,6,0;9,0,8,33,1;0,0,9,33,3;1,0,9,33,3;2,0,9,33,3;3,0,9,33,3;4,0,9,33,3;5,0,9,33,3;6,0,9,33,3;7,0,9,33,3;8,0,9,33,3;9,0,9,33,3;1,1,1,6,0;2,1,1,8,0;3,1,1,8,0;4,1,1,8,0;5,1,1,8,0;6,1,1,8,0;7,1,1,8,0;8,1,1,6,0;1,1,2,8,0;6,1,2,14,3;8,1,2,8,0;1,1,3,8,0;6,1,3,14,7;8,1,3,8,0;1,1,6,8,0;7,1,6,19,0;8,1,6,8,0;1,1,7,8,0;7,1,7,18,0;8,1,7,8,0;1,1,8,6,0;2,1,8,8,0;3,1,8,8,0;4,1,8,8,0;5,1,8,8,0;6,1,8,8,0;7,1,8,8,0;8,1,8,6,0;1,2,0,38,0;8,2,0,38,0;0,2,1,38,0;1,2,1,6,0;2,2,1,8,0;3,2,1,8,0;4,2,1,22,0;5,2,1,22,0;6,2,1,8,0;7,2,1,8,0;8,2,1,6,0;9,2,1,38,0;1,2,2,8,0;2,2,2,38,0;6,2,2,38,0;8,2,2,8,0;1,2,3,8,0;8,2,3,8,0;1,2,6,8,0;8,2,6,8,0;1,2,7,8,0;2,2,7,38,0;7,2,7,38,0;8,2,7,8,0;0,2,8,38,0;1,2,8,6,0;2,2,8,8,0;3,2,8,8,0;4,2,8,22,0;5,2,8,22,0;6,2,8,8,0;7,2,8,8,0;8,2,8,6,0;9,2,8,38,0;1,2,9,38,0;8,2,9,38,0;1,3,1,6,0;2,3,1,8,0;3,3,1,8,0;4,3,1,8,0;5,3,1,8,0;6,3,1,8,0;7,3,1,8,0;8,3,1,6,0;1,3,2,8,0;8,3,2,8,0;1,3,3,8,0;8,3,3,8,0;1,3,4,8,0;8,3,4,8,0;1,3,5,8,0;8,3,5,8,0;1,3,6,8,0;8,3,6,8,0;1,3,7,8,0;8,3,7,8,0;1,3,8,6,0;2,3,8,8,0;3,3,8,8,0;4,3,8,8,0;5,3,8,8,0;6,3,8,8,0;7,3,8,8,0;8,3,8,6,0;0,4,0,21,0;1,4,0,21,0;2,4,0,21,0;3,4,0,21,0;4,4,0,21,0;5,4,0,21,0;6,4,0,21,0;7,4,0,21,0;8,4,0,21,0;9,4,0,21,0;1,4,1,6,0;2,4,1,8,0;3,4,1,8,0;4,4,1,8,0;5,4,1,8,0;6,4,1,8,0;7,4,1,8,0;8,4,1,6,0;1,4,2,21,0;8,4,2,21,0;1,4,3,21,0;8,4,3,21,0;1,4,4,21,0;8,4,4,21,0;1,4,5,21,0;8,4,5,21,0;1,4,6,21,0;8,4,6,21,0;1,4,7,21,0;8,4,7,21,0;1,4,8,6,0;2,4,8,8,0;3,4,8,8,0;4,4,8,8,0;5,4,8,8,0;6,4,8,8,0;7,4,8,8,0;8,4,8,6,0;0,4,9,21,0;1,4,9,21,0;2,4,9,21,0;3,4,9,21,0;4,4,9,21,0;5,4,9,21,0;6,4,9,21,0;7,4,9,21,0;8,4,9,21,0;9,4,9,21,0;0,5,1,21,0;1,5,1,21,0;2,5,1,21,0;3,5,1,21,0;4,5,1,21,0;5,5,1,21,0;6,5,1,21,0;7,5,1,21,0;8,5,1,21,0;9,5,1,21,0;1,5,2,8,0;8,5,2,8,0;1,5,3,8,0;8,5,3,8,0;1,5,4,8,0;8,5,4,8,0;1,5,5,8,0;8,5,5,8,0;1,5,6,8,0;8,5,6,8,0;1,5,7,8,0;8,5,7,8,0;0,5,8,21,0;1,5,8,21,0;2,5,8,21,0;3,5,8,21,0;4,5,8,21,0;5,5,8,21,0;6,5,8,21,0;7,5,8,21,0;8,5,8,21,0;9,5,8,21,0;0,6,2,21,0;1,6,2,21,0;2,6,2,21,0;3,6,2,21,0;4,6,2,21,0;5,6,2,21,0;6,6,2,21,0;7,6,2,21,0;8,6,2,21,0;9,6,2,21,0;1,6,3,8,0;8,6,3,8,0;1,6,4,8,0;8,6,4,8,0;1,6,5,8,0;8,6,5,8,0;1,6,6,8,0;8,6,6,8,0;0,6,7,21,0;1,6,7,21,0;2,6,7,21,0;3,6,7,21,0;4,6,7,21,0;5,6,7,21,0;6,6,7,21,0;7,6,7,21,0;8,6,7,21,0;9,6,7,21,0;0,7,3,21,0;1,7,3,21,0;2,7,3,21,0;3,7,3,21,0;4,7,3,21,0;5,7,3,21,0;6,7,3,21,0;7,7,3,21,0;8,7,3,21,0;9,7,3,21,0;1,7,4,8,0;8,7,4,8,0;1,7,5,8,0;8,7,5,8,0;0,7,6,21,0;1,7,6,21,0;2,7,6,21,0;3,7,6,21,0;4,7,6,21,0;5,7,6,21,0;6,7,6,21,0;7,7,6,21,0;8,7,6,21,0;9,7,6,21,0;0,8,4,21,0;1,8,4,21,0;2,8,4,21,0;3,8,4,21,0;4,8,4,21,0;5,8,4,21,0;6,8,4,21,0;7,8,4,21,0;8,8,4,21,0;9,8,4,21,0;0,8,5,21,0;1,8,5,21,0;2,8,5,21,0;3,8,5,21,0;4,8,5,21,0;5,8,5,21,0;6,8,5,21,0;7,8,5,21,0;8,8,5,21,0;9,8,5,21,0;1,1,4,35,2;1,2,4,35,10;1,1,5,35,2;1,2,5,35,10;8,1,4,35,3;8,2,4,35,11;8,1,5,35,3;8,2,5,35,11";
let CABIN_DATA = null;
function cabinData() {
  if (!CABIN_DATA) CABIN_DATA = CABIN_BLOCKS.split(';').map(t => t.split(',').map(Number));
  return CABIN_DATA;
}
const CABIN_CELL = 240, myCabinCache = new Map(), myCabinBusy = new Set();
const CABIN_STATS = { cells: 0, roll: 0, plain: 0, flat: 0, cave: 0, ok: 0, okPlain: 0, okCave: 0 };
function myCabinFor(cellX, cellZ) {
  const key = cellX + ',' + cellZ;
  if (myCabinCache.has(key)) return myCabinCache.get(key);
  if (myCabinBusy.has(key)) return null;                 // 防递归（内部触发区块生成时直接放弃）
  myCabinBusy.add(key);
  CABIN_STATS.cells++;
  let out = null;
  const roll = h2(cellX * 63.7 + 7.1, cellZ * 41.3 - 3.3);
  if (roll > 0.6) {                             // 玩家小屋：66% → 40%
    CABIN_STATS.roll++;
    const rnd = mulberry32((Math.floor(roll * 1e9) ^ Math.imul(cellX, 2654435761) ^ Math.imul(cellZ, 40503)) | 0);
    const cx = cellX * CABIN_CELL + 40 + Math.floor(rnd() * (CABIN_CELL - 80));
    const cz = cellZ * CABIN_CELL + 40 + Math.floor(rnd() * (CABIN_CELL - 80));
    const plain = inPlain(cx, cz);
    if (plain) CABIN_STATS.plain++;
    const ops = [];
    const put = (x, y, z, t, m) => ops.push(m ? { x, y, z, t, m } : { x, y, z, t });
    const carve = (x, y, z) => ops.push({ x, y, z, t: 0 });
    const data = cabinData();
    const W = 10, H = 9, D = 10;
    // ⚠ 这里原来有个从未被调用的 fixMeta()：它会把每张床的 meta 一律写成 1（= 六亲不认的脚格），
    // 反而把 CABIN_BLOCKS 里正确的「脚格 3 / 头格 7」抹掉。床的两格 meta 由数据自带，别再二次修正。
    if (plain) {                                              // 平原：贴地盖
      let mn = 999, mx = -999;
      for (let dx = -1; dx <= W; dx += 3) for (let dz = -1; dz <= D; dz += 3) {
        const hh = heightAt(cx + dx, cz + dz);
        if (hh < mn) mn = hh;
        if (hh > mx) mx = hh;
      }
      if (mx - mn <= 6 && mn > CFG.SEA + 2 && mn < SURF_OFF + 46) CABIN_STATS.flat++;
      if (mx - mn <= 8 && mn > CFG.SEA + 1 && mn < SURF_OFF + 58) {
        const gy = mx;
        for (const [x, y, z, id, mt] of data) put(cx + x, gy + y, cz + z, id, mt || 0);
        supportBase(ops, gy, 9, gy);                          // 玩家小屋（平原）：地板在 gy，下面补实
        out = { cx, cz, gy, where: 'plain', byChunk: packOps(ops), ops: ops.length };
        CABIN_STATS.ok++; CABIN_STATS.okPlain++;
      }
    } else if (roll > 0.55) {
      CABIN_STATS.cave++;                                 // 地下：嵌在岩层里的矿洞小屋
      const gy = 14 + Math.floor(rnd() * 12);            // 14~25 层：埋得够深，屋顶上方仍有岩层
      const surf = heightAt(cx, cz);
      if (gy + H + 2 < surf - 4) {                           // 屋顶上方还有岩层 → 完全埋在地下

        for (let dx = -2; dx <= W + 1; dx++) for (let dz = -2; dz <= D + 1; dz++) for (let dy = 0; dy <= H + 1; dy++) carve(cx + dx, gy + dy, cz + dz);
        for (const [x, y, z, id, mt] of data) put(cx + x, gy + y, cz + z, id, mt || 0);
        out = { cx, cz, gy, where: 'cave', byChunk: packOps(ops), ops: ops.length };
        CABIN_STATS.ok++; CABIN_STATS.okCave++;
      }
    }
  }
  myCabinBusy.delete(key);
  myCabinCache.set(key, out);
  return out;
}
function applyMyCabin(b, ox, oz, selfKey) {
  const C = CABIN_CELL;
  const sx = Math.floor(ox / C), sz = Math.floor(oz / C);
  for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
    const st = myCabinFor(sx + dx, sz + dz);
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
function inMyCabin(wx, wz) {
  const C = CABIN_CELL;
  const cx = Math.floor(wx / C), cz = Math.floor(wz / C);
  for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
    const o = myCabinFor(cx + dx, cz + dz);
    if (o && Math.abs(wx - o.cx) <= 8 && Math.abs(wz - o.cz) <= 8) return true;
  }
  return false;
}

function applyExtraStructs(b, ox, oz, selfKey) {
  applyMyCabin(b, ox, oz, selfKey);                                  // 玩家上传的小屋（平原 / 矿洞）
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
function hsTorches(put, hx, gy, hz, w, d) {     // 鬼屋每层四角点火把，看得出是「有人待过的废墟」
  for (const [dx, dz] of [[-w + 1, -d + 1], [w - 1, -d + 1], [-w + 1, d - 1], [w - 1, d - 1]]) {
    put(hx + dx, gy + 2, hz + dz, 38);
  }
}
const hsCache = new Map();
const bossSpawned = new Set();
function hauntedFor(cellX, cellZ) {
  const key = cellX + ',' + cellZ;
  if (hsCache.has(key)) return hsCache.get(key);
  let out = null;
  const roll = h2(cellX * 71.3 + 3.1, cellZ * 47.7 - 8.9);
  if (roll > 0.6) {                             // 鬼屋：55% → 40%
    const rnd = mulberry32((Math.floor(roll * 1e9) ^ Math.imul(cellX, 2654435761) ^ Math.imul(cellZ, 40503)) | 0);
    const cx = cellX * HS_CELL + 80 + Math.floor(rnd() * (HS_CELL - 160));
    const cz = cellZ * HS_CELL + 80 + Math.floor(rnd() * (HS_CELL - 160));
    const W = 8, D = 6;                       // 半宽 / 半深（17×13 的外墙）
    let gy = 0;
    for (let dx = -W - 1; dx <= W + 1; dx++) for (let dz = -D - 1; dz <= D + 1; dz++) gy = Math.max(gy, heightAt(cx + dx, cz + dz));
    if (gy > CFG.SEA + 4 && gy < SURF_OFF + 38) {
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
        // 每层四角挂火把（鬼屋里也有照明，进去看得见）
        for (const [sx, sz] of [[-W + 1, -D + 1], [W - 1, -D + 1], [-W + 1, D - 1], [W - 1, D - 1]]) {
          put(cx + sx, fy + 2, cz + sz, 38);
        }
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
        // 一层南墙：中间装一扇木门，两侧各留一格门洞
        if (f === 0) { put(cx - D + 1, fy + 2, cz - D + 1, 38); put(cx + D - 1, fy + 2, cz + D - 1, 38); }
      if (f === 0) for (let h = 1; h <= 2; h++) {
          carve(cx - 1, fy + h, cz + D); carve(cx + 1, fy + h, cz + D);
          put(cx, fy + h, cz + D, 35, 1 | (h === 2 ? 8 : 0));   // dir2：门板贴 +Z 外墙
        }
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
  // 门：朝向村中心那一面装一扇木门（门板贴外墙，拆/开门两格一起）
  if (Math.abs(cx - hx) > Math.abs(cz - hz)) {
    const sx = cx > hx ? 1 : -1;
    const db = (sx > 0 ? 4 : 3) - 1;                       // dir 3 = 贴 -X，4 = 贴 +X
    for (let y = gy + 1; y <= gy + 2; y++) put(hx + sx * w, y, hz, 35, db | (y === gy + 2 ? 8 : 0));
  } else {
    const sz = cz > hz ? 1 : -1;
    const db = (sz > 0 ? 2 : 1) - 1;
    for (let y = gy + 1; y <= gy + 2; y++) put(hx, y, hz + sz * d, 35, db | (y === gy + 2 ? 8 : 0));
  }
  if (rnd() < 0.8) { carve(hx - w, gy + 2, hz + d - 1); carve(hx + w, gy + 2, hz - d + 1); }   // 窗
  buildGableRoof(put, hx, hz, gy + h + 1, w + 1, d + 1, woodP, 34);   // 两坡屋顶（原来是一块平顶）
  put(hx, gy + h + 2 + d, hz, log);
  const bx = hx + (rnd() < 0.5 ? -w + 1 : w - 1), bz = hz + (rnd() < 0.5 ? -d + 1 : d - 1);
  put(bx, gy + 1, bz, 18);                                                                    // 屋内箱子
  if (rnd() < 0.5) {                                       // 有时放张床：脚 + 头【两格必须成对】
    // ⚠ 以前只 put 一个 meta=7 的头格 ⇒ 床只有半个（没有脚格，躺不下/看着像断的）。
    // 床轴沿 Z：脚格在头格 -Z 侧（dir 3 = 脚→头朝 +Z），两格都留在室内。
    const mbx = bx > hx ? bx - 1 : bx + 1;
    const hbz = Math.max(hz - d + 2, Math.min(hz + d - 1, bz));
    put(mbx, gy + 1, hbz - 1, 14, 3);                      // 脚格（无枕头）
    put(mbx, gy + 1, hbz, 14, 7);                          // 头格（枕头）
  }
  put(hx + w - 1, gy + 2, hz + d - 1, 38);                                                    // 屋内角落火把
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
  if (roll > 0.5) {                                        // 村庄：70% → 50% 的格子
    const rnd = mulberry32((Math.floor(roll * 1e9) ^ Math.imul(cellX, 83492791) ^ Math.imul(cellZ, 427131)) | 0);
    const cx = cellX * VS_CELL + 44 + Math.floor(rnd() * (VS_CELL - 88));
    const cz = cellZ * VS_CELL + 44 + Math.floor(rnd() * (VS_CELL - 88));
    const gy = heightAt(cx, cz);
    if (gy > CFG.SEA + 3 && gy < SURF_OFF + 42) {          // 不在水下、不在山顶
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
  if (furnaceOpen) closeFurnace();
  if (chargerOpen) closeCharger();
  openChestPos = { x, y, z };
  chestSlots(x, y, z);
  if (NET && NET.active) NET.pullChest(x, y, z);      // 联机：箱子里存的是服务端那一份（两人共用）
  $('chestPanel').classList.remove('hide');
  renderChest();
  syncPointerLock();                         // 放开光标：箱子里搬运物品要能随便移鼠标
  sfx('craft');
  return true;
}
function closeChest() {
  if (cursor) {                                    // 关界面时手上的东西塞回背包/箱子
    if (!addItem(cursor.id, cursor.n)) { toast('背包满了，物品掉在脚下', 1.6); spawnDrop(cursor.id, cursor.n, player.p.x, player.p.y + 1, player.p.z, { c: cursor.c }); }
    cursor = null;
  }
  openChestPos = null;
  $('chestPanel').classList.add('hide');
  renderHotbar(); refreshHeld(); saveSoon();
  if (NET && NET.active) NET.pushInv();          // 关箱子顺手把背包存一次
  syncPointerLock();                         // 箱子关掉 → 重新锁定回第一人称
}
function afterSlotChange() {
  renderHotbar(); refreshHeld();
  if (openChestPos) renderChest();
  if (panelOpen) renderInventoryPanel();
  if (NET && NET.active && openChestPos) NET.pushChest();   // 箱子一改就写回服务端（两人共用同一份）
  saveSoon();
}
// 点一下拿起，再点一下放下 / 合并 / 交换 —— 背包和箱子共用这套逻辑
function slotClick(arr, i, ev) {
  const cur = arr[i];
  // 创造模式：Shift + 点格子 = 直接删掉这一格（不用先拿到手上再丢）
  if (isCreative() && ev && ev.shiftKey && cur) {
    arr[i] = null;
    toast(`已删除 ${nameOf(cur.id)} ×${cur.n}`, 1.2);
    afterSlotChange();
    return;
  }
  if (!cursor) {
    if (cur) { cursor = cur; arr[i] = null; }
    else return;
  } else if (!cur) {
    arr[i] = cursor; cursor = null;
  } else if (cur.id === cursor.id && !(ITEMS[cur.id] && (ITEMS[cur.id].dur || ITEMS[cur.id].kind === 'gun'))) {
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
      d.innerHTML = `<img src="${iconURL(s.id)}" alt=""><span class="n">${s.n > 1 ? s.n : ''}</span>` + slotBarHTML(s);
      d.title = nameOf(s.id) + (ITEMS[s.id] && ITEMS[s.id].kind === 'gun'
        ? `（电量 ${s.c === undefined ? (ITEMS[s.id].cap || 8) : s.c}/${ITEMS[s.id].cap || 8}）` : '');
    }
    d.onclick = (ev) => handler(i, ev);
    el.appendChild(d);
  }
}
let cursorEl = null;
function updateCursorEl(e) {                    // 手上拿的东西跟着鼠标走，看得清在和哪一格交换
  if (!cursor) { if (cursorEl) cursorEl.style.display = 'none'; return; }
  if (!cursorEl) {
    cursorEl = document.createElement('img');
    cursorEl.style.cssText = 'position:fixed;z-index:99;pointer-events:none;width:40px;height:40px;'
      + 'image-rendering:pixelated;transform:translate(-50%,-50%);filter:drop-shadow(0 2px 3px rgba(0,0,0,.6))';
    document.body.appendChild(cursorEl);
  }
  cursorEl.src = iconURL(cursor.id);
  cursorEl.style.display = 'block';
  if (e && e.clientX !== undefined) { cursorEl.style.left = e.clientX + 'px'; cursorEl.style.top = e.clientY + 'px'; }
  else if (!cursorEl.style.left) { cursorEl.style.left = (innerWidth / 2) + 'px'; cursorEl.style.top = (innerHeight / 2) + 'px'; }
}
addEventListener('mousemove', (e) => { if (cursorEl && cursor) updateCursorEl(e); });
function cursorText() {
  if (!cursor) return '手上：空（点物品拿起，再点另一格放下/交换）';
  return `手上：${nameOf(cursor.id)} ×${cursor.n}（点面板外 = 丢到地上${isCreative() ? '，Shift+点格子 = 直接删除' : ''}）`;
}
function dropCursorToWorld() {                     // 鼠标上的东西 → 变成掉落物，朝面向方向扔出去
  if (!cursor) return false;
  const id = cursor.id, n = cursor.n;
  cursor = null;
  const d = cameraDir();
  const len = Math.hypot(d.x, d.z) || 1;
  const ux = d.x / len, uz = d.z / len;
  // 扔到 3 格外，免得被自己的吸附范围（2 格）立刻捡回来
  spawnDrop(id, n, player.p.x + ux * 1.2, player.p.y + 1.25, player.p.z + uz * 1.2,
    { pop: 2.0, vx: ux * 3.4, vz: uz * 3.4 });
  toast(`已丢出 ${nameOf(id)} ×${n}`, 1.4);
  renderInventoryPanel(); renderHotbar(); refreshHeld(); saveSoon();
  return true;
}
// 点「卡片」以外的地方（遮罩、空白）→ 手上的东西直接丢出去
document.addEventListener('pointerdown', (e) => {
  if (!cursor) return;
  const t = e.target;
  if (!t || t === cursorEl || (t.closest && t.closest('.card'))) return;   // 卡片内的格子/按钮照常交互
  dropCursorToWorld();
}, true);
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
  grunt:    { name: '夜行怪', hp: 20, chase: 2.9, wander: 1.2, hostile: true,  barY: 1.44, drop: null, dmg: 3, atkCd: 1.6, sunBurn: true, armPose: -1.35 },
  pig:      { name: '猪',     hp: 10, chase: 2.4, wander: 1.0, hostile: false, barY: 1.0,  drop: 108 },
  villager: { name: '村民',   hp: 20, chase: 1.9, wander: 0.9, hostile: false, barY: 1.85, drop: null },
  cow:      { name: '牛',     hp: 24, chase: 2.3, wander: 0.85, hostile: false, barY: 1.45, drop: 140, dropN: [1, 2] },
  sheep:    { name: '羊',     hp: 18, chase: 2.5, wander: 0.95, hostile: false, barY: 1.15, drop: 145, dropN: [1, 2], extra: [{ id: 142, n: [1, 2] }] },
  chicken:  { name: '鸡',     hp: 8,  chase: 2.8, wander: 0.8,  hostile: false, barY: 0.75, drop: 143, dropN: [1, 1] },
  spider:   { name: '蜘蛛',   hp: 22, chase: 4.0, wander: 1.4,  hostile: true,  barY: 0.9,  drop: null, dmg: 2.5, atkCd: 1.25 },
  skeleton: { name: '骷髅射手', hp: 20, chase: 2.4, wander: 1.0, hostile: true,  barY: 1.6,  drop: 148, dropN: [1, 2], dmg: 3, atkCd: 1.5, ranged: true, sunBurn: true },
  ghost:    { name: '幽灵',   hp: 18, chase: 2.2, wander: 0.9, hostile: true,  barY: 1.7,  drop: 155, dropN: [1, 1], dmg: 2.5, atkCd: 1.4, float: true, ghostly: true },
  ghostBoss:{ name: '幽灵王', hp: 140, chase: 2.9, wander: 1.2, hostile: true, barY: 3.1,  drop: 155, dropN: [3, 5], dmg: 6, atkCd: 1.15, float: true, ghostly: true, boss: true },
  // ── 冥界专属 ──
  blaze:      { name: '火焰魔', hp: 16, chase: 3.2, wander: 1.1, hostile: true, barY: 1.62, drop: 176, dropN: [1, 3], dmg: 3, atkCd: 1.4, ranged: true, float: true, dim: 'nether' },
  netherBeast:{ name: '冥骨兽', hp: 30, chase: 3.6, wander: 1.2, hostile: true, barY: 1.35, drop: 176, dropN: [1, 2], extra: [{ id: 148, n: [1, 2] }], dmg: 5, atkCd: 1.2, dim: 'nether' },
  croc:       { name: '噩梦鳄鱼', hp: 48, chase: 3.5, wander: 1.0, hostile: true, barY: 1.15, drop: 192, dropN: [1, 3], dmg: 6, atkCd: 1.1, dim: 'nether' },
  crocKing:   { name: '鳄鱼王', hp: 320, chase: 3.1, wander: 0.8, hostile: true, barY: 2.15, drop: 193, dropN: [1, 2], extra: [{ id: 177, n: [8, 14] }, { id: 125, n: [2, 5] }], dmg: 15, atkCd: 1.5, boss: true, dim: 'nether' },
};
const aliveMobs = () => mobs.filter(m => !m.dying).length;
const countKind = k => mobs.filter(m => !m.dying && m.kind === k).length;

/* ── 像素生物 ────────────────────────────────────────────────────────────────
   整只怪由 1/16 方块大小的「像素」小立方体拼成：每格一个颜色、内部面剔除，
   表面因此是硬边像素块（和世界方块同一网格感），而不是平滑的塑料盒子。
   几何按种类缓存后所有个体共用，出生/死亡不重新拼装。 */
// MC 模型网格是「16 像素 = 1 方块」，但玩家模型整体再缩 0.9375 才等于 1.8 格身高。
// 这里直接按我们的玩家身高归一化：32 像素高的人形 = CFG.PH ⇒ 头身比/腿长/肩宽与玩家一致。
const MOB_PX = (1 / 16) * (CFG.PH / 2);
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

/* ── 像素生物（MC 比例 + 像素皮肤）────────────────────────────────────────
   所有模型都按 MC 的像素网格建模：16 像素 = 1 方块（MOB_PX 再按玩家身高归一化）。
   人形 = 头 8³ + 躯干 8×12×4 + 手臂 4×12×4 + 腿 4×12×4 = 32px 高 ⇒ 1.78 格，
   和玩家一样高、头占 1/4、腿占 3/8、肩宽 16px；动物按 MC 的真实尺寸比例。
   表面是 1/16 方块的实心像素立方（内部面剔除），眼睛/嘴/衣褶/斑纹都直接画在
   表面像素上 —— 材质本身就是硬边像素块，放大看是一个个 6cm 的小方块。 */
function mobGeos(kind) {
  if (mobGeoCache.has(kind)) return mobGeoCache.get(kind);
  const body = new Map(), head = new Map();
  const K = (x, y, z) => x + ',' + y + ',' + z;
  const box = (map, x0, y0, z0, w, h, d, hex, jitter = 0.12) => {
    for (let x = x0; x < x0 + w; x++) for (let y = y0; y < y0 + h; y++) for (let z = z0; z < z0 + d; z++)
      map.set(K(x, y, z), tintHex(hex, 1 + (pixHash(x, y, z, map === head ? 7 : 3) - 0.5) * jitter));
  };
  const px = (map, x, y, z, hex) => map.set(K(x, y, z), hex);
  const dk = (hex, f = 0.8) => tintHex(hex, f);
  let coreY = 1.0, barY = 2.0, limbSpecs = [], headPiv = 24;   // headPiv：脖子像素高度（头绕它转）
  // 肢体：支点在 y=0（上端），向下垂 h 像素 —— 和 MC 的手臂/腿一样绕肩/胯旋转
  const limbGeo = (w, h, d, hex, jit, paint) => {
    const m = new Map();
    const x0 = -Math.ceil(w / 2);
    box(m, x0, -h, -Math.ceil(d / 2), w, h, d, hex, jit);
    if (paint) paint(m, (x, y, z, c) => m.set(K(x, y, z), c), x0);
    return voxGeometry(m);
  };
  // 人形骨架（像素坐标，脚 y=0）：头 24..31、躯干 12..23、腿 0..11
  const humanoid = (pal, facePaint, armPaint, legPaint, bodyPaint) => {
    box(body, -4, 12, -2, 8, 12, 4, pal.body, 0.14);
    box(body, -4, 12, -2, 8, 2, 4, pal.dark, 0.09);          // 下摆
    box(body, -4, 21, -2, 8, 1, 4, pal.dark, 0.09);          // 肩线
    if (bodyPaint) bodyPaint();
    box(head, -4, 24, -4, 8, 8, 8, pal.skin, 0.10);
    if (facePaint) facePaint();
    limbSpecs = [
      { geo: limbGeo(4, 12, 4, pal.body, 0.14, armPaint), x: -6, y: 24, z: 0, arm: true },
      { geo: limbGeo(4, 12, 4, pal.body, 0.14, armPaint), x: 6, y: 24, z: 0, arm: true },
      { geo: limbGeo(4, 12, 4, pal.leg, 0.12, legPaint), x: -2, y: 12, z: 0, arm: false },
      { geo: limbGeo(4, 12, 4, pal.leg, 0.12, legPaint), x: 2, y: 12, z: 0, arm: false },
    ];
    coreY = 18 * MOB_PX; barY = 34.5 * MOB_PX;
  };
  // 眼睛：MC 式硬边像素（2×2 眼窝 + 1px 亮瞳孔），z 为脸面那一层
  const eyes2 = (map, z, yTop, xs, outer, pupil) => {
    for (const x of xs) {
      for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) px(map, x + dx, yTop - dy, z, outer);
      px(map, x + 1, yTop - 1, z, pupil);
    }
  };

  if (kind === 'croc' || kind === 'crocKing') {
    // 噩梦鳄鱼：低矮长身 + 长吻 + 粗尾 + 四条短腿（鳄鱼王整体 ×1.75）
    const K = kind === 'crocKing' ? 1.75 : 1;
    const GREEN = 0x2f4226, DARK = 0x1a2617, BELLY = 0x8d8a5c, CLAW = 0xd9d2ae, EYE = 0xffd23a;
    const B = (par, x, y, z, w, h, d, c, n) => box(par, x * K, y * K, z * K, w * K, h * K, d * K, c, n);
    B(body, -6, 4, -13, 12, 7, 26, GREEN, 0.1);              // 躯干
    B(body, -6, 4, -13, 12, 2, 26, BELLY, 0.07);             // 肚皮
    for (let z = -11; z <= 11; z += 3) B(body, -1, 11, z, 2, 2, 2, DARK, 0.05);   // 背甲棘
    B(body, -5, 5, -22, 10, 5, 9, GREEN, 0.08);              // 尾根
    B(body, -3, 5, -28, 6, 4, 7, GREEN, 0.08);               // 尾梢
    for (let z = -20; z >= -28; z -= 3) B(body, -1, 9, z, 2, 2, 2, DARK, 0.05);
    B(head, -5, 4, 12, 10, 6, 8, GREEN, 0.09);               // 头
    B(head, -4, 3, 19, 8, 3, 7, GREEN, 0.07);                // 长吻
    B(head, -4, 2, 19, 8, 1, 7, BELLY, 0.03);               // 下颚
    for (let x = -3; x <= 3; x += 2) B(head, x, 3, 25, 1, 1, 1, CLAW, 0);          // 牙
    for (const ex of [-4, 2]) { B(head, ex, 9, 14, 2, 1, 2, EYE, 0.02); }          // 黄眼
    const leg = limbGeo(4 * K, 4 * K, 4 * K, dk(GREEN, 0.8), 0.1, (m, set, x0) => set(x0, -4 * K, 2 * K, CLAW));
    limbSpecs = [
      { geo: leg, x: -4 * K, y: 4 * K, z: 7 * K, arm: true }, { geo: leg, x: 4 * K, y: 4 * K, z: 7 * K, arm: true },
      { geo: leg, x: -4 * K, y: 4 * K, z: -8 * K, arm: false }, { geo: leg, x: 4 * K, y: 4 * K, z: -8 * K, arm: false },
    ];
    coreY = 8 * MOB_PX * K; barY = 15.5 * MOB_PX * K; headPiv = 4 * K;
  } else if (kind === 'pig') {
    // MC 猪：腿 6 高 + 躯干 8 高 = 16px（1.78×16/32 = 0.89 格，和 MC 的 0.9 命中率一致）
    const PINK = 0xefa0a0, SNOUT = 0xd98c8c, HOOF = 0x6b4a4a;
    box(body, -5, 6, -8, 10, 8, 16, PINK, 0.14);                 // 躯干
    box(body, -5, 6, -8, 10, 2, 16, dk(PINK, 0.9), 0.09);        // 肚皮
    for (let z = -7; z < 7; z += 4) px(body, -5, 13, z, dk(PINK, 1.08));   // 背脊亮条
    box(body, -1, 13, -9, 2, 2, 1, SNOUT, 0.06);                 // 尾巴
    box(head, -4, 6, 8, 8, 8, 8, PINK, 0.12);                    // 头
    box(head, -2, 8, 15, 4, 3, 1, SNOUT, 0.06);                  // 猪鼻
    px(head, -1, 9, 15, 0xb87373); px(head, 0, 9, 15, 0xb87373); // 鼻孔
    eyes2(head, 15, 12, [-3, 2], 0x1d1010, 0x4a2c2c);
    box(head, -4, 13, 9, 2, 1, 2, dk(PINK, 0.88), 0.05);         // 耳朵
    box(head, 2, 13, 9, 2, 1, 2, dk(PINK, 0.88), 0.05);
    const leg = limbGeo(3, 6, 3, dk(PINK, 0.85), 0.12,
      (m, set, x0) => set(x0, -6, 1, HOOF));
    limbSpecs = [
      { geo: leg, x: -3, y: 6, z: 6, arm: true }, { geo: leg, x: 3, y: 6, z: 6, arm: true },
      { geo: leg, x: -3, y: 6, z: -6, arm: false }, { geo: leg, x: 3, y: 6, z: -6, arm: false },
    ];
    coreY = 9 * MOB_PX; barY = 17.5 * MOB_PX; headPiv = 6;
  } else if (kind === 'villager') {
    // 村民：和人形同一套 32px 骨架（身高 = 玩家）
    const ROBE = 0x7d6440, ROBE2 = 0x5c4630, SKIN = 0xd8b58c, HAIR = 0x2e2116;
    humanoid({ body: ROBE, skin: SKIN, dark: ROBE2, leg: 0x3d2f1d }, () => {
      // 头发 + 帽檐（顶部 2 层 + 后脑 + 两侧，留出正面 8×6 的脸）
      box(head, -4, 30, -4, 8, 2, 8, HAIR, 0.08);
      box(head, -4, 24, -4, 8, 8, 2, HAIR, 0.08);
      box(head, -4, 24, -4, 1, 8, 8, HAIR, 0.08);
      box(head, 3, 24, -4, 1, 8, 8, HAIR, 0.08);
      // 连心眉 + 眼睛（1×2 竖眼）+ 大鼻子 + 一字嘴
      for (let x = -3; x <= 2; x++) px(head, x, 29, 3, 0x2a1d12);
      for (const ex of [-3, 1]) {                                // 2×2 眼白 + 1px 瞳孔
        px(head, ex, 28, 3, 0xf4f4ee); px(head, ex + 1, 28, 3, 0xf4f4ee);
        px(head, ex, 27, 3, 0xf4f4ee); px(head, ex + 1, 27, 3, 0x24180f);
      }
      box(head, -1, 26, 3, 2, 2, 1, 0xb98f68, 0.03);             // 高鼻子（突出在脸上）
      for (let x = -2; x <= 1; x++) px(head, x, 24, 3, 0x7a5a40); // 嘴
      // 长袍：交叉领口 + 腰带 + 衣褶
      for (let y = 20; y <= 23; y++) { px(body, -4 + (23 - y), y, 1, ROBE2); px(body, 3 - (23 - y), y, 1, ROBE2); }
      box(body, -4, 14, 1, 8, 1, 1, 0x2f2417, 0.04);             // 腰带
      for (let y = 15; y <= 20; y += 3) { px(body, -2, y, 1, dk(ROBE, 0.86)); px(body, 1, y, 1, dk(ROBE, 0.86)); }
    }, (m, set, x0) => {
      for (let y = -3; y <= -1; y++) for (let x = x0; x < x0 + 4; x++) set(x, y, 1, SKIN);   // 袖口露手
    }, (m, set, x0) => {
      for (let x = x0; x < x0 + 4; x++) { set(x, -12, 1, 0x241a10); set(x, -12, -2, 0x241a10); }  // 鞋
    });
  } else if (kind === 'cow') {
    // MC 牛：腿 12 + 躯干 10 = 22px ≈ 1.22 格（MC 牛 1.4，这里按玩家比例收一点）
    const HIDE = 0x3a2b24, PATCH = 0xe8e2d6, HORN = 0xd8cbb0, SNOUT = 0xc9a29a;
    box(body, -6, 12, -10, 12, 10, 20, HIDE, 0.12);
    box(body, -6, 15, -6, 12, 5, 7, PATCH, 0.08);                // 白花斑（硬边块，不是渐变）
    box(body, -6, 13, 3, 5, 4, 5, PATCH, 0.08);
    box(body, 1, 18, -9, 5, 3, 5, PATCH, 0.08);
    for (let z = -9; z < 10; z += 3) px(body, 6, 19, z, dk(HIDE, 0.86));
    box(head, -4, 13, 10, 8, 8, 8, HIDE, 0.10);                  // 头
    box(head, -3, 11, 17, 6, 4, 2, SNOUT, 0.06);                 // 口鼻
    px(head, -1, 12, 18, 0x8a6a63); px(head, 1, 12, 18, 0x8a6a63);
    eyes2(head, 17, 18, [-4, 3], 0x120c0a, 0x3a2a24);
    box(head, -5, 20, 11, 2, 2, 2, HORN, 0.04);                  // 角
    box(head, 3, 20, 11, 2, 2, 2, HORN, 0.04);
    box(head, -6, 16, 12, 1, 3, 2, dk(HIDE, 0.9), 0.05);         // 耳朵
    box(head, 5, 16, 12, 1, 3, 2, dk(HIDE, 0.9), 0.05);
    const leg = limbGeo(4, 12, 4, dk(HIDE, 0.9), 0.10,
      (m, set, x0) => { for (let x = x0; x < x0 + 4; x++) { set(x, -12, 1, 0x1f1714); set(x, -12, -2, 0x1f1714); } });
    limbSpecs = [
      { geo: leg, x: -3, y: 12, z: 6, arm: true }, { geo: leg, x: 3, y: 12, z: 6, arm: true },
      { geo: leg, x: -3, y: 12, z: -6, arm: false }, { geo: leg, x: 3, y: 12, z: -6, arm: false },
    ];
    coreY = 17 * MOB_PX; barY = 24 * MOB_PX; headPiv = 13;
  } else if (kind === 'sheep') {
    const WOOL = 0xf2efe6, FACE = 0xd6c6b0, HOOF = 0x2b2622;
    box(body, -6, 12, -8, 12, 9, 16, WOOL, 0.24);                // 蓬松羊毛（强抖动 = 毛粒感）
    box(body, -6, 20, -8, 12, 2, 16, WOOL, 0.24);                // 背毛
    box(head, -3, 13, 8, 6, 7, 6, FACE, 0.09);
    box(head, -4, 18, 7, 8, 3, 6, WOOL, 0.22);                   // 头顶羊毛
    eyes2(head, 13, 17, [-3, 1], 0x1a1512, 0x4a3a34);
    px(head, -1, 15, 13, 0xc9a89a); px(head, 0, 15, 13, 0xc9a89a);
    const leg = limbGeo(3, 12, 3, dk(WOOL, 0.72), 0.14,
      (m, set, x0) => { for (let x = x0; x < x0 + 3; x++) { set(x, -12, 1, HOOF); set(x, -12, -2, HOOF); } });
    limbSpecs = [
      { geo: leg, x: -3, y: 12, z: 5, arm: true }, { geo: leg, x: 3, y: 12, z: 5, arm: true },
      { geo: leg, x: -3, y: 12, z: -5, arm: false }, { geo: leg, x: 3, y: 12, z: -5, arm: false },
    ];
    coreY = 16 * MOB_PX; barY = 23 * MOB_PX; headPiv = 13;
  } else if (kind === 'chicken') {
    const FEATHER = 0xf4f2ea, BEAK = 0xe0a33c, COMB = 0xd8402f;
    box(body, -3, 4, -4, 6, 6, 8, FEATHER, 0.14);
    box(body, -4, 6, -2, 1, 3, 6, dk(FEATHER, 0.88), 0.12);      // 翅膀
    box(body, 3, 6, -2, 1, 3, 6, dk(FEATHER, 0.88), 0.12);
    box(head, -2, 10, 3, 5, 5, 5, FEATHER, 0.10);
    box(head, -1, 10, 8, 3, 1, 1, BEAK, 0.04);                   // 喙
    box(head, -1, 15, 4, 3, 1, 2, COMB, 0.05);                   // 鸡冠
    eyes2(head, 7, 13, [-2, 1], 0x241a12, 0x6a3a1a);
    px(head, 0, 9, 7, COMB);                                     // 肉垂
    const leg = limbGeo(1, 4, 1, BEAK, 0.05,
      (m, set, x0) => { set(x0, -4, 0, 0xd08a2c); });
    limbSpecs = [
      { geo: leg, x: -1, y: 4, z: 0, arm: true }, { geo: leg, x: 2, y: 4, z: 0, arm: false },
    ];
    coreY = 7 * MOB_PX; barY = 16 * MOB_PX; headPiv = 10;
  } else if (kind === 'spider') {
    const CH = 0x2a2430, CH2 = 0x1c1822, EYE = 0xd23c3c;
    box(body, -4, 6, -7, 8, 7, 14, CH, 0.14);                    // 头胸（y 6..12）
    box(body, -6, 7, -9, 12, 5, 6, CH2, 0.12);                   // 后腹
    for (let z = -8; z < -3; z += 2) px(body, -6, 11, z, 0x3a3040);   // 腹部条纹
    box(head, -3, 6, 7, 6, 5, 5, CH, 0.10);                      // y 6..10
    // 四只眼（两对）：2×1 红眼 + 1px 亮芯
    for (const x of [-3, -1, 1, 2]) { px(head, x, 9, 11, EYE); px(head, x, 8, 11, 0x7a1d1d); }
    px(head, -2, 9, 11, 0xffb0b0); px(head, 2, 9, 11, 0xffb0b0);
    // 八条腿从身体下沿垂直落到地面（长 12px，落地不会悬空）
    const leg = limbGeo(1, 12, 1, CH2, 0.08);
    limbSpecs = [
      { geo: leg, x: -4, y: 12, z: 5, arm: true }, { geo: leg, x: 4, y: 12, z: 5, arm: true },
      { geo: leg, x: -4, y: 12, z: 2, arm: false }, { geo: leg, x: 4, y: 12, z: 2, arm: false },
      { geo: leg, x: -4, y: 12, z: -1, arm: false }, { geo: leg, x: 4, y: 12, z: -1, arm: false },
      { geo: leg, x: -4, y: 12, z: -4, arm: false }, { geo: leg, x: 4, y: 12, z: -4, arm: false },
    ];
    coreY = 9 * MOB_PX; barY = 13.5 * MOB_PX; headPiv = 6;
  } else if (kind === 'blaze') {
    const FIRE = 0xffb43c, FIRE2 = 0xff7a18, DARK = 0x8a3a10;
    box(body, -3, 8, -3, 6, 10, 6, DARK, 0.14);                  // 燃烧的核心
    for (let y = 9; y < 17; y += 2) for (let x = -3; x < 3; x += 2) px(body, x, y, 2, FIRE2);
    box(body, -4, 11, -2, 8, 2, 4, FIRE2, 0.12);                 // 肩部火焰
    box(head, -3, 18, -3, 7, 7, 7, FIRE, 0.14);                  // 头
    eyes2(head, 3, 23, [-2, 2], 0x241608, 0xfff2b0);
    box(head, -1, 20, 3, 3, 1, 1, DARK, 0.05);                   // 口
    const limb = limbGeo(2, 7, 2, FIRE2, 0.16,
      (m, set, x0) => { set(x0, -7, 1, 0xfff2b0); });
    limbSpecs = [
      { geo: limb, x: -5, y: 17, z: 0, arm: true }, { geo: limb, x: 5, y: 17, z: 0, arm: true },
      { geo: limb, x: -2, y: 8, z: 0, arm: false }, { geo: limb, x: 2, y: 8, z: 0, arm: false },
    ];
    coreY = 15 * MOB_PX; barY = 27 * MOB_PX; headPiv = 18;
  } else if (kind === 'netherBeast') {
    const HIDE = 0x5d2222, HIDE2 = 0x3d1515, HORN = 0xd9cdb5, EYE = 0xff5a2b;
    box(body, -4, 8, -8, 8, 9, 16, HIDE, 0.12);
    box(body, -3, 15, -7, 6, 2, 12, HIDE2, 0.09);                // 背脊
    for (let z = -7; z < 7; z += 3) px(body, -3, 17, z, HORN);    // 背刺
    box(head, -3, 10, 9, 7, 7, 8, HIDE2, 0.11);
    eyes2(head, 16, 15, [-2, 2], EYE, 0xffe0b0);
    box(head, -4, 16, 10, 2, 4, 2, HORN, 0.06);                  // 角
    box(head, 3, 16, 10, 2, 4, 2, HORN, 0.06);
    const leg = limbGeo(2, 8, 2, HIDE2, 0.10,
      (m, set, x0) => { set(x0, -8, 1, 0x140b0b); });
    limbSpecs = [
      { geo: leg, x: -2, y: 8, z: 6, arm: true }, { geo: leg, x: 2, y: 8, z: 6, arm: true },
      { geo: leg, x: -2, y: 8, z: -6, arm: false }, { geo: leg, x: 2, y: 8, z: -6, arm: false },
    ];
    coreY = 12 * MOB_PX; barY = 24 * MOB_PX; headPiv = 10;
  } else if (kind === 'skeleton') {
    // 骷髅：与人形同骨架，但肢体只有 2px 宽（MC 骷髅的细骨头）
    const BONE = 0xe8e4d6, BONE2 = 0xc9c4b2, SOCK = 0x14100d;
    humanoid({ body: BONE, skin: BONE, dark: BONE2, leg: BONE2 }, () => {
      box(head, -4, 24, -4, 8, 8, 8, BONE, 0.08);
      eyes2(head, 3, 28, [-3, 2], SOCK, SOCK);
      px(head, -1, 26, 3, SOCK); px(head, 0, 26, 3, SOCK);        // 鼻孔
      for (let x = -3; x <= 2; x++) px(head, x, 25, 3, x % 2 ? BONE2 : 0x2b2620);   // 牙缝
      box(head, -4, 24, -4, 8, 1, 8, BONE2, 0.06);                // 下颌阴影
    }, (m, set, x0) => {}, (m, set, x0) => {});
    // 肋骨：正面横向暗缝（每 2px 一条）+ 脊柱
    for (let y = 13; y <= 21; y += 2) for (let x = -4; x < 4; x++) px(body, x, y, 1, 0x241f1a);
    for (let y = 13; y <= 21; y++) { px(body, -1, y, 1, BONE2); px(body, 0, y, 1, BONE2); }
    // 覆写四肢：细骨头（2×12×2）
    const armGeo = limbGeo(2, 12, 2, BONE, 0.08,
      (m, set, x0) => { for (let x = x0; x < x0 + 2; x++) set(x, -6, 1, BONE2); });
    const legGeo = limbGeo(2, 12, 2, BONE2, 0.08,
      (m, set, x0) => { for (let x = x0; x < x0 + 2; x++) set(x, -12, 1, BONE); });
    limbSpecs = [
      { geo: armGeo, x: -6, y: 24, z: 0, arm: true }, { geo: armGeo, x: 6, y: 24, z: 0, arm: true },
      { geo: legGeo, x: -2, y: 12, z: 0, arm: false }, { geo: legGeo, x: 2, y: 12, z: 0, arm: false },
    ];
  } else if (kind === 'ghost' || kind === 'ghostBoss') {
    const boss = kind === 'ghostBoss';
    const S2 = boss ? 2 : 1;                                     // Boss 整体 2 倍（人形的 2 倍高）
    const SHEET = boss ? 0xd8c8f0 : 0xe6eef7, DARK = boss ? 0x8f6fc0 : 0xa8bccc, EYE = boss ? 0xff5a8a : 0x2a2b3a;
    box(body, -4 * S2, 8 * S2, -2 * S2, 8 * S2, 10 * S2, 4 * S2, SHEET, 0.16);
    box(body, -5 * S2, 10 * S2, -1 * S2, 10 * S2, 3 * S2, 2 * S2, SHEET, 0.14);   // 伸出的手臂
    for (let i = -3; i <= 3; i += 2) {                            // 下摆一缕一缕
      const len = 2 + ((i * 7 + 5) % 3);
      box(body, i * S2, (8 - len) * S2, -2 * S2, 1 * S2, len * S2, 4 * S2, DARK, 0.14);
    }
    for (let y = 9 * S2; y < 17 * S2; y += 3 * S2) px(body, -4 * S2, y, 2 * S2 - 1, DARK);
    box(head, -4 * S2, 18 * S2, -3 * S2, 8 * S2, 7 * S2, 5 * S2, SHEET, 0.12);
    for (const x of [-2 * S2, 2 * S2]) {                          // 空洞的眼窝
      for (let dy = 0; dy < 2 * S2; dy++) for (let dx = 0; dx < 2 * S2; dx++) px(head, x + dx, 22 * S2 - dy, 2 * S2 - 1, EYE);
    }
    for (let x = -1 * S2; x < 2 * S2; x++) px(head, x, 20 * S2, 2 * S2 - 1, 0x3a3550);
    coreY = 13 * S2 * MOB_PX; barY = 26 * S2 * MOB_PX; headPiv = 18 * S2;
  } else {
    // 夜行怪 grunt：人形骨架 + 破布兜帽 + 红眼尖牙
    const SKIN = 0x9fd8c8, CLOTH = 0x2f5d5a, CLOTH2 = 0x26494a;
    humanoid({ body: CLOTH, skin: SKIN, dark: CLOTH2, leg: 0x223f3e }, () => {
      // 兜帽：顶 2 层 + 后脑 + 左右鬓角
      box(head, -4, 30, -4, 8, 2, 8, CLOTH, 0.08);
      box(head, -4, 24, -4, 8, 8, 2, CLOTH, 0.08);
      box(head, -4, 24, -4, 1, 8, 8, CLOTH, 0.08);
      box(head, 3, 24, -4, 1, 8, 8, CLOTH, 0.08);
      for (let x = -4; x < 4; x++) px(head, x, 29, 3, CLOTH2);    // 帽檐阴影
      eyes2(head, 3, 28, [-3, 2], 0x3a0d0d, 0xff4d4d);            // 红眼（z=3 = 脸面那一层）
      for (let x = -2; x <= 1; x++) px(head, x, 25, 3, 0x201414); // 嘴
      px(head, -1, 25, 3, 0xe8f4ef); px(head, 1, 25, 3, 0xe8f4ef);
      for (let y = 26; y <= 28; y++) { px(head, 0, y, 3, dk(SKIN, 0.88)); px(head, -1, y, 3, dk(SKIN, 0.88)); }  // 鼻梁阴影
    }, (m, set, x0) => {
      for (let y = -2; y <= -1; y++) for (let x = x0; x < x0 + 4; x++) set(x, y, 1, dk(CLOTH, 1.25));            // 袖口
    }, (m, set, x0) => {
      for (let x = x0; x < x0 + 4; x++) { set(x, -12, 1, 0x1a2e2e); set(x, -12, -2, 0x1a2e2e); }               // 靴子
    }, () => {
      box(body, -3, 15, 1, 6, 4, 1, CLOTH2, 0.06);                // 胸甲
      for (let y = 15; y <= 18; y++) { px(body, -3, y, 1, 0x1f3d3c); px(body, 2, y, 1, 0x1f3d3c); }
      px(body, -2, 17, 1, 0xdfe9e4); px(body, 1, 17, 1, 0xdfe9e4); // 铆钉
    });
  }

  const topPx = kind === 'ghost' || kind === 'ghostBoss' ? (kind === 'ghostBoss' ? 50 : 25) : 0;
  if (MOB_DEFS[kind]) MOB_DEFS[kind].barY = barY;      // 头顶血条 / 村民标记跟着新体型走
  const geo = { body: voxGeometry(body), head: voxGeometry(head), coreY, barY, limbs: limbSpecs, topPx, headPiv };
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
  // 头挂在一个「脖子支点」上（Action & Stuff / MC 那样，头会自己转过来盯着你）
  const headPivot = new THREE.Group();
  headPivot.position.y = G.headPiv * MOB_PX - G.coreY;
  const headMesh = new THREE.Mesh(G.head, headMat);
  headMesh.position.y = -G.headPiv * MOB_PX;
  headPivot.add(headMesh);
  core.add(bodyMesh, headPivot);
  const limbs = [];
  for (const L of G.limbs) {
    const mesh = new THREE.Mesh(L.geo, bodyMat);
    mesh.position.set(L.x * MOB_PX, L.y * MOB_PX - G.coreY, L.z * MOB_PX);
    if (L.rz) mesh.rotation.z = L.rz;          // 蜘蛛腿外撇等静态姿态
    if (L.rx) mesh.rotation.x = L.rx;
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
  const legs = limbs.filter((m, i) => !G.limbs[i].arm);      // 人形=两条腿，四条腿的动物=后腿
  return { g, core, coreY: G.coreY, bodyMat, headMat, arm1: arms[0] || null, arm2: arms[1] || null,
           bar, barFg, limbs, legs, headPivot, topPx: G.topPx };
}


/* ── 走动动画（参考 Action & Stuff）───────────────────────────────────────
   ① 步频跟「实际速度」而不是帧率：站着 2.2 rad/s，全速 9.6 rad/s
   ② 交叉步：左臂配右腿（四条腿的动物走对角步：前左 + 后右）
   ③ 躯干随步子上下起伏、顺步侧倾、起步前倾；停住时有极轻的呼吸
   ④ 落地 squash（压扁再弹回）；受击后仰；攻击向前一扑（lunge）
   ⑤ 头绕脖子支点盯玩家（水平 ±49°、俯仰 ±24°）——僵尸手常抬（armPose）
   死亡动画不走这里（dying 分支在调用前就 continue 了）。 */
function animateMob(m, dt, dx, dz, dist) {
  const P = m.parts, def = MOB_DEFS[m.kind] || {};
  const a = m.anim || (m.anim = { walk: Math.random() * 6, k: 0, idle: 0, land: 0 });
  const spd = Math.hypot(m.v.x, m.v.z);
  const want = Math.min(1, spd / Math.max(0.8, (def.chase || 2) * 0.62));
  a.k += (want - a.k) * Math.min(1, dt * 9);
  a.idle += dt;
  a.walk += dt * (2.2 + 7.4 * a.k);
  const s = Math.sin(a.walk), amp = 0.9 * a.k;
  const armBase = def.armPose || 0;
  // ① 交叉摆动
  if (P.arm1) P.arm1.rotation.x = armBase + s * amp * 0.55;
  if (P.arm2) P.arm2.rotation.x = armBase - s * amp * 0.55;
  const legs = P.legs || [];
  for (let i = 0; i < legs.length; i++) legs[i].rotation.x = (i % 2 ? 1 : -1) * s * amp;
  // ② 落地 squash
  if (m.onGround) { if ((m.airT || 0) > 0.14) a.land = 1; m.airT = 0; }
  else m.airT = (m.airT || 0) + dt;
  a.land = Math.max(0, a.land - dt * 5.0);
  const sq = def.float ? 0 : a.land * a.land;
  // ③ 躯干：起伏 / 侧倾 / 前倾 / 受击后仰 / 出击前扑
  m.lunge = Math.max(0, (m.lunge || 0) - dt * 4.2);
  const lu = Math.min(1, m.lunge / 0.3);
  const flinch = Math.min(1, (m.flash || 0) / 0.24);
  const bob = Math.abs(s) * 0.04 * a.k + Math.sin(a.idle * 1.6) * 0.008 * (1 - a.k);
  P.core.position.y = P.coreY + bob - 0.10 * sq;
  P.core.position.z = 0.16 * lu;
  P.core.rotation.z = s * 0.03 * a.k;
  P.core.rotation.x = 0.10 * a.k - 0.26 * flinch;
  P.core.scale.set(1 + 0.10 * sq, 1 - 0.16 * sq, 1 + 0.10 * sq);
  // ④ 头盯人（绕脖子转，身体不动）
  if (P.headPivot) {
    let dy = Math.atan2(dx, dz) - m.obj.rotation.y;
    while (dy > Math.PI) dy -= Math.PI * 2;
    while (dy < -Math.PI) dy += Math.PI * 2;
    const hy = clamp(dy, -0.85, 0.85) * (1 - a.k * 0.45);
    const py = clamp(-Math.atan2((player.p.y + 1.0) - (m.p.y + 1.15), Math.max(0.7, dist)), -0.42, 0.42);
    m.headYaw = (m.headYaw || 0) + (hy - (m.headYaw || 0)) * Math.min(1, dt * 9);
    m.headPitch = (m.headPitch || 0) + (py - (m.headPitch || 0)) * Math.min(1, dt * 7);
    P.headPivot.rotation.y = m.headYaw;
    P.headPivot.rotation.x = m.headPitch;
  }
}

/* ── 村民招募：不能交易，只能「满足需求 → 招入队」；招募后可指挥跟随、可给道具 ── */
const RECRUIT_WANTS = [
  { id: 107, n: 3 },   // 小麦
  { id: 8, n: 6 },     // 木板
  { id: 9, n: 8 },     // 圆石
  { id: 105, n: 2 },   // 苹果
  { id: 124, n: 2 },   // 面包
  { id: 13, n: 4 },    // 煤矿石
  { id: 106, n: 2 },   // 铁锭
  { id: 142, n: 2 },   // 羊毛
  { id: 145, n: 2 },   // 生羊肉
  { id: 21, n: 6 },    // 石砖
];
function rollDemand() {
  const w = RECRUIT_WANTS[Math.floor(Math.random() * RECRUIT_WANTS.length)];
  return { id: w.id, need: w.n + Math.floor(Math.random() * 2), got: 0 };
}
function markTex(kind) {                        // 头顶标记：! = 待招募，★ = 已招募
  const cv = document.createElement('canvas');
  cv.width = cv.height = 32;
  const g = cv.getContext('2d');
  g.font = 'bold 26px sans-serif';
  g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillStyle = kind === 'hired' ? '#8ef06a' : '#ffd84a';
  g.strokeStyle = 'rgba(0,0,0,.65)'; g.lineWidth = 4;
  const ch = kind === 'hired' ? '★' : '!';
  g.strokeText(ch, 16, 17); g.fillText(ch, 16, 17);
  const t = new THREE.CanvasTexture(cv);
  t.magFilter = THREE.NearestFilter;
  return t;
}
const MARK_TEX = {};
function refreshVillagerMark(m) {
  if (m.mark) { m.obj.remove(m.mark); m.mark.material.map.dispose(); m.mark.material.dispose(); m.mark.geometry.dispose(); m.mark = null; }
  const key = m.recruit.hired ? 'hired' : 'ask';
  if (!MARK_TEX[key]) MARK_TEX[key] = markTex(key);
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: MARK_TEX[key], transparent: true, depthTest: false }));
  sp.scale.set(0.34, 0.34, 1);
  sp.position.set(0, MOB_DEFS[m.kind].barY + 0.62, 0);
  sp.renderOrder = 6;
  m.obj.add(sp);
  m.mark = sp;
}
function makeHandCross(tile, size) {
  const u0 = (tile % ATLAS_COLS) / ATLAS_COLS, v0 = 1 - (((tile / ATLAS_COLS) | 0) + 1) / ATLAS_ROWS;
  const iu = 1 / ATLAS_COLS, iv = 1 / ATLAS_ROWS;
  const g = new THREE.Group();
  const half = size / 2;
  for (const ry of [0, Math.PI / 2]) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute([-half, -half, 0, half, -half, 0, half, half, 0, -half, half, 0], 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute([u0, v0, u0 + iu, v0, u0 + iu, v0 + iv, u0, v0 + iv], 2));
    geo.setAttribute('color', new THREE.Float32BufferAttribute([1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1], 3));
    geo.setIndex([0, 1, 2, 0, 2, 3]);
    geo.computeVertexNormals();
    const q = new THREE.Mesh(geo, plantMat);
    q.rotation.y = ry;
    g.add(q);
  }
  return g;
}
function showVillagerGift(m) {                  // 手里的道具：和玩家手持用同一套模型、同样大小
  if (m.gift) {
    if (m.gift.parent) m.gift.parent.remove(m.gift);
    m.gift.traverse(o => { if (o.geometry) o.geometry.dispose(); });
    m.gift = null;
  }
  if (!m.give) return;
  const hand = m.parts.arm1 || m.parts.core;
  const b = BLOCKS[m.give.id], it = ITEMS[m.give.id];
  let mesh = null;
  // 手臂从肩膀垂到 y=-12px（≈-0.67），所以「手」在 y≈-0.60；以前挂在 -0.26（肘部）显得道具浮在半空
  const HAND_Y = -12 * MOB_PX * 0.92;
  if (b && b.cross) {                           // 火把/花草：和玩家手里一样用十字面片（不是六面糊图案的立方体）
    mesh = makeHandCross(b.top, 0.44);
    mesh.rotation.set(0, 0.35, 0);
  } else if (b) {                               // 方块：0.2 立方体缩到 0.55（村民手比玩家手小）
    const mats = [b.side, b.side, b.top, b.bottom ?? b.top, b.side, b.side].map(blockFaceMat);
    mesh = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.2, 0.2), mats);
    mesh.scale.setScalar(0.55);
    mesh.rotation.set(0.2, 0.6, 0.1);
  } else if (it && (it.kind === 'pick' || it.kind === 'sword' || it.kind === 'mat' || it.kind === 'food' || it.kind === 'hoe' || it.kind === 'gun')) {
    mesh = makeToolModel(m.give.id);            // 剑/镐/材料：玩家手里那个 3D 模型，缩到 0.62
    mesh.scale.setScalar(0.62);
    mesh.rotation.set(-0.28, 0.42, -0.06);      // 贴着掌心、刀尖朝前下（原来 -0.5/0.45/-0.15 像横着插在肘上）
  } else {
    const mat = new THREE.MeshBasicMaterial({ transparent: true, alphaTest: 0.1, side: THREE.DoubleSide });
    const tex = new THREE.TextureLoader().load(iconURL(m.give.id));
    tex.magFilter = THREE.NearestFilter;
    mat.map = tex;
    mesh = new THREE.Mesh(new THREE.PlaneGeometry(0.26, 0.26), mat);
  }
  mesh.position.set(0.015, HAND_Y, 0.02);
  mesh.renderOrder = 5;
  hand.add(mesh);
  m.gift = mesh;
}
function nearestHostileFrom(v, range, nearPlayer) {   // 找玩家周围、村民附近的敌对怪
  let best = null, bd = range;
  for (const t of mobs) {
    if (t === v || t.dying || t.hp <= 0) continue;
    const d = MOB_DEFS[t.kind];
    if (!d || !d.hostile) continue;
    const dd = Math.hypot(t.p.x - v.p.x, t.p.z - v.p.z);
    if (dd >= bd) continue;
    if (nearPlayer && Math.hypot(t.p.x - player.p.x, t.p.z - player.p.z) > nearPlayer) continue;
    bd = dd; best = t;
  }
  return best;
}
function villagerAttack(v, t) {                   // 村民用剑砍怪：怪会改目标来打他
  const sw = ITEMS[v.give.id] || {};
  const dmg = Math.max(2, Math.round((sw.dmg || 4) * 0.55));
  t.hp -= dmg;
  t.flash = 0.24;
  t.aggro = 22;
  t.target = v;                                   // ★ 被村民打 → 怪物换成打村民
  const kx = t.p.x - v.p.x, kz = t.p.z - v.p.z, kd = Math.hypot(kx, kz) || 1;
  t.v.x = (kx / kd) * 6.0; t.v.z = (kz / kd) * 6.0; t.v.y = 3.0; t.knockT = 0.3;
  if (v.parts.arm1) v.parts.arm1.rotation.x = -1.15;               // 挥砍动作
  sfx('hit');
  if (t.hp <= 0) startMobDeath(t);
}
/* ── 小队：最多 3 人；村民可穿盔甲（可见）、位置与装备写进存档 ── */
const MAX_SQUAD = 3;
const ARMOR_COLOR = { 110: 0xcfd6de, 111: 0xcfd6de, 112: 0xcfd6de, 113: 0xcfd6de,
  132: 0x5fe0dc, 133: 0x5fe0dc, 134: 0x5fe0dc, 135: 0x5fe0dc };
function squadList() { return mobs.filter(m => m.recruit && m.recruit.hired); }
function newEquip() { return { head: null, chest: null, legs: null, feet: null }; }
function armorTierColor(id) { return ARMOR_COLOR[id] || (id >= 132 ? 0x5fe0dc : 0xcfd6de); }

function refreshVillagerArmor(m) {               // 给村民模型套 4 件盔甲（头/胸/腿/靴）
  if (!m.parts) return;
  const core = m.parts.core;
  if (m.armorMeshes) { for (const a of m.armorMeshes) core.remove(a); m.armorMeshes = null; }
  if (!m.equip) return;
  const bodyMesh = core.children[0], headMesh = core.children[1];
  if (!bodyMesh || !headMesh) return;
  const boxOf = (mesh) => { mesh.geometry.computeBoundingBox(); return mesh.geometry.boundingBox.clone().translate(mesh.position); };
  const hb = boxOf(headMesh), bb2 = boxOf(bodyMesh);
  const meshes = [];
  const add = (slot, y0, y1, grow = 0.022, src = bb2) => {
    const id = m.equip[slot];
    if (!id) return;
    const w = (src.max.x - src.min.x) + grow * 2, d = (src.max.z - src.min.z) + grow * 2;
    const yTop = src.min.y + (src.max.y - src.min.y) * y1, yBot = src.min.y + (src.max.y - src.min.y) * y0;
    const mat = new THREE.MeshLambertMaterial({ color: armorTierColor(id) });
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, Math.max(0.03, yTop - yBot), d), mat);
    mesh.position.set((src.min.x + src.max.x) / 2, (yTop + yBot) / 2, (src.min.z + src.max.z) / 2);
    core.add(mesh); meshes.push(mesh);
  };
  add('head', 0.42, 0.99, 0.028, hb);            // 头盔：罩住上半个头，露出脸
  add('chest', 0.46, 0.99);                      // 胸甲：躯干外壳
  // 护腿 / 靴子要穿在「腿」上（村民的腿是独立部件，不是躯干盒子的一部分）
  const armSet = new Set([m.parts.arm1, m.parts.arm2].filter(Boolean));
  const legs = (m.parts.limbs || []).filter(o => !armSet.has(o));
  for (const L of legs) {
    L.geometry.computeBoundingBox();
    const lb = L.geometry.boundingBox.clone().translate(L.position);
    const h = lb.max.y - lb.min.y;
    if (m.equip.legs) {
      const w = (lb.max.x - lb.min.x) + 0.04, d = (lb.max.z - lb.min.z) + 0.04;
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h * 0.55, d), new THREE.MeshLambertMaterial({ color: armorTierColor(m.equip.legs) }));
      mesh.position.set((lb.min.x + lb.max.x) / 2, lb.max.y - h * 0.275, (lb.min.z + lb.max.z) / 2);
      core.add(mesh); meshes.push(mesh);
    }
    if (m.equip.feet) {
      const w = (lb.max.x - lb.min.x) + 0.05, d = (lb.max.z - lb.min.z) + 0.05;
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h * 0.34, d), new THREE.MeshLambertMaterial({ color: armorTierColor(m.equip.feet) }));
      mesh.position.set((lb.min.x + lb.max.x) / 2, lb.min.y + h * 0.17, (lb.min.z + lb.max.z) / 2);
      core.add(mesh); meshes.push(mesh);
    }
  }
  m.armorMeshes = meshes.length ? meshes : null;
}

let vPanelEl = null, vPanelMob = null;
function ensureVillagerPanel() {
  if (vPanelEl) return vPanelEl;
  vPanelEl = document.createElement('div');
  vPanelEl.id = 'vpanel';
  vPanelEl.style.cssText = 'position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);width:min(330px,92vw);'
    + 'background:rgba(16,20,28,.97);border:2px solid #43546b;border-radius:12px;padding:14px 14px 10px;'
    + 'z-index:70;color:#e8eef5;font-size:13px;display:none;box-shadow:0 14px 44px rgba(0,0,0,.6);font-family:inherit';
  vPanelEl.addEventListener('click', (e) => {
    const t = e.target.closest('[data-act]');
    if (!t) return;
    const act = t.dataset.act;
    if (act === 'close') closeVillagerPanel();
    else if (act === 'follow' && vPanelMob) {
      vPanelMob.recruit.follow = !vPanelMob.recruit.follow;
      toast(vPanelMob.recruit.follow ? '村民：跟着你' : '村民：原地待命', 1.4);
      renderVillagerPanel(vPanelMob); saveSoon();
    } else if (act.startsWith('gear') && vPanelMob) equipVillager(vPanelMob, act.slice(4));
  });
  document.body.appendChild(vPanelEl);
  return vPanelEl;
}
function closeVillagerPanel() { if (vPanelEl) vPanelEl.style.display = 'none'; vPanelMob = null; }
function openVillagerPanel(m) { ensureVillagerPanel(); vPanelMob = m; renderVillagerPanel(m); vPanelEl.style.display = 'block'; }
function renderVillagerPanel(m) {
  const el = ensureVillagerPanel();
  const r = m.recruit, nm = MOB_DEFS[m.kind].name;
  const gearRow = ARMOR_SLOTS.map(sl => {
    const id = m.equip && m.equip[sl];
    return `<button data-act="gear${sl}" style="flex:1;min-width:0;margin:2px;padding:7px 3px;border-radius:7px;border:1px solid #43546b;`
      + `background:${id ? '#213a3a' : '#1a212b'};color:${id ? '#5fe0dc' : '#8b97a6'};font-size:11px;cursor:pointer;line-height:1.25">`
      + `<div style="color:#9fb0c2;font-size:10px">${ARMOR_SLOT_NAME[sl]}</div>${id ? ITEMS[id].name : '空'}</button>`;
  }).join('');
  const duty = m.give ? (ITEMS[m.give.id] && ITEMS[m.give.id].kind === 'sword' ? `⚔ 战斗中（拿着 ${ITEMS[m.give.id].name}）`
    : `手持 ${ITEMS[m.give.id].name}`) : '空手';
  el.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">
      <b style="font-size:15px">${nm}${r.hired ? ' · 小队成员' : ''}</b>
      <button data-act="close" style="background:#2a3441;border:1px solid #43546b;color:#cfdae6;border-radius:6px;padding:3px 9px;cursor:pointer">✕</button>
    </div>
    ${r.hired ? `
      <div style="color:#9fb0c2;margin-bottom:6px">装备（点一下穿上 / 再点脱下，穿在身上看得见）</div>
      <div style="display:flex;margin-bottom:8px">${gearRow}</div>
      <div style="color:#9fb0c2;margin-bottom:8px">${duty}</div>
      <button data-act="follow" style="width:100%;padding:9px;border-radius:8px;border:1px solid ${r.follow ? '#3f7a4a' : '#43546b'};`
        + `background:${r.follow ? '#1e3a26' : '#1a212b'};color:${r.follow ? '#9ff0a8' : '#cfdae6'};cursor:pointer;font-size:13px">`
        + `${r.follow ? '正在跟随（点一下让他待命）' : '原地待命（点一下让他跟随）'}</button>
      <div style="color:#7f8c9b;font-size:11px;margin-top:8px">护甲 ${ARMOR_SLOTS.reduce((a, sl) => a + ((m.equip && m.equip[sl] && ITEMS[m.equip[sl]].ap) || 0), 0)} · 生命 ${Math.round(m.hp)}/${m.maxHp}</div>
    ` : `
      <div style="color:#ffd84a;margin-bottom:8px">想要：${nameOf(r.want.id)} ×${r.want.need}</div>
      <div style="height:9px;border-radius:5px;background:#1a212b;overflow:hidden;margin-bottom:8px">
        <div style="height:100%;width:${Math.round(r.want.got / r.want.need * 100)}%;background:linear-gradient(90deg,#ffd84a,#e0a020)"></div>
      </div>
      <div style="color:#9fb0c2">进度 ${r.want.got}/${r.want.need} —— 拿着他想要的东西右键他就能交付</div>
    `}`;
}
function equipVillager(m, slot) {
  if (!m.equip) m.equip = newEquip();
  if (!ARMOR_SLOTS.includes(slot)) return false;
  const cur = m.equip[slot];
  if (cur) { m.equip[slot] = null; addItem(cur, 1); toast(`脱下 ${ITEMS[cur].name}`, 1.2); }
  else {
    const idx = inv.findIndex(s => s && ITEMS[s.id] && ITEMS[s.id].kind === 'armor' && ITEMS[s.id].slot === slot);
    if (idx < 0) { toast(`背包里没有${ARMOR_SLOT_NAME[slot]}`, 1.4); return false; }
    const id = inv[idx].id;
    takeItem(id, 1);
    m.equip[slot] = id;
    toast(`给村民穿上 ${ITEMS[id].name}（护甲 +${ITEMS[id].ap}）`, 1.6);
  }
  refreshVillagerArmor(m);
  renderVillagerPanel(m); renderHotbar(); refreshHeld(); saveSoon();
  return true;
}
function squadData() {
  return squadList().map(m => ({
    x: +m.p.x.toFixed(2), y: +m.p.y.toFixed(2), z: +m.p.z.toFixed(2),
    want: m.recruit.want, follow: !!m.recruit.follow, equip: m.equip || newEquip(),
    give: m.give || null, hp: m.hp,
  }));
}
function restoreSquad(list) {
  if (!Array.isArray(list) || !list.length) return 0;
  let n = 0;
  for (const sd of list) {
    if (!sd) continue;
    const m = spawnMobAt('villager', Math.round(sd.x), Math.round(sd.y), Math.round(sd.z), { force: true });
    if (!m) continue;
    m.p.set(sd.x, sd.y, sd.z);
    m.recruit.want = sd.want || m.recruit.want;
    m.recruit.hired = true;
    m.recruit.follow = !!sd.follow;
    m.equip = Object.assign(newEquip(), sd.equip || {});
    if (sd.give) { m.give = sd.give; showVillagerGift(m); }
    if (sd.hp) m.hp = Math.min(m.maxHp, sd.hp);
    refreshVillagerMark(m);
    refreshVillagerArmor(m);
    n++;
  }
  return n;
}

function mobAtCrosshair(range = 4.2) {          // 准星指向的怪/村民
  const eye = eyePos(), dir = cameraDir();
  let best = null, bestT = 1e9;
  for (const m of mobs) {
    if (m.dying) continue;
    const c = m.p.clone(); c.y += 0.8;
    const d = c.sub(eye);
    const t = d.dot(dir);
    if (t < 0.4 || t > range) continue;
    const perp = d.clone().sub(dir.clone().multiplyScalar(t)).length();
    if (perp < 1.05 && t < bestT) { best = m; bestT = t; }
  }
  return best;
}
function recruitInteract(m) {                    // 右键村民：交物资 / 招募 / 给道具 / 指挥
  const r = m.recruit;
  const h = held();
  if (!r.hired) {
    if (!h) { toast(`他想要 ${nameOf(r.want.id)} ×${r.want.need}（还差 ${r.want.need - r.want.got}）`, 2.0); return true; }
    if (h.id !== r.want.id) { toast(`他不收 ${nameOf(h.id)}，想要 ${nameOf(r.want.id)} ×${r.want.need}`, 2.0); return true; }
    const give = Math.min(h.n, r.want.need - r.want.got);
    takeItem(h.id, give);
    r.want.got += give;
    if (r.want.got >= r.want.need) {
      if (squadList().length >= MAX_SQUAD) {
        toast(`小队已满（最多 ${MAX_SQUAD} 人），先从背包里解散一个`, 2.4);
        return true;
      }
      r.hired = true; r.follow = true;
      if (!m.equip) m.equip = newEquip();
      refreshVillagerMark(m);
      toast(`${MOB_DEFS[m.kind].name}入队了！空手右键可以让他跟随 / 待命`, 3.0);
      sfx('craft');
    } else {
      toast(`交给他 ${nameOf(h.id)} ×${give}（${r.want.got}/${r.want.need}）`, 1.6);
      sfx('place');
    }
    renderHotbar(); refreshHeld(); saveSoon();
    return true;
  }
  if (h) {                                       // 已入队：给道具
    takeItem(h.id, 1);
    m.give = { id: h.id, n: 1 };
    showVillagerGift(m);
    const bonus = ITEMS[h.id] && ITEMS[h.id].kind === 'food' ? '（他会自己吃掉补血）' : '（拿在手里跟着你）';
    toast(`给了 ${MOB_DEFS[m.kind].name} ${nameOf(h.id)} ${bonus}`, 2.2);
    if (ITEMS[h.id] && ITEMS[h.id].kind === 'food') { m.hp = Math.min(m.maxHp, m.hp + 8); m.give = null; showVillagerGift(m); }
    renderHotbar(); refreshHeld(); saveSoon();
    return true;
  }
  openVillagerPanel(m);                          // 空手右键：打开村民面板（装备 / 跟随）
  return true;
}

// 冥界找落脚点：在玩家附近 ±14 格内，从玩家头顶往下扫一层能站的地面
/* ── 缠魂藤：玩家身边 1 格内有 58 号方块就被缠住（移速 32%），并且召来鳄鱼王 ── */
let crocBossCd = 0;
function vineNearPlayer() {
  const px = Math.floor(player.p.x), py = Math.floor(player.p.y), pz = Math.floor(player.p.z);
  for (let dy = 0; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
    if (getBlock(px + dx, py + dy, pz + dz) === 58) return true;
  }
  return false;
}
function updateVines(dt) {
  crocBossCd = Math.max(0, crocBossCd - dt);
  if (DIM !== 'nether' || !player.alive) { player.tangle = 0; return; }
  const hit = vineNearPlayer();
  if (hit) {
    if (!(player.tangle > 0)) { toast('缠魂藤缠住了你！移速下降', 1.6); sfx('hit'); }
    player.tangle = 1.0;
    if (crocBossCd <= 0 && !mobs.some(m => m.kind === 'crocKing' && !m.dying)) {
      const spot = findNetherSpot();
      if (spot) {
        const k = spawnMobAt('crocKing', spot.x, spot.y, spot.z);
        if (k) { crocBossCd = 90; toast('沼泽深处传来低吼……鳄鱼王出现了', 3.2); sfx('hurt'); }
      }
    }
  }
  player.tangle = Math.max(0, (player.tangle || 0) - dt);
}
function findNetherSpot() {
  for (let i = 0; i < 24; i++) {
    const x = Math.floor(player.p.x + (Math.random() * 2 - 1) * 14);
    const z = Math.floor(player.p.z + (Math.random() * 2 - 1) * 14);
    for (let y = Math.floor(player.p.y) + 6; y > 10; y--) {
      const id = getBlock(x, y, z);
      if (id !== 0 && id !== 44 && getBlock(x, y + 1, z) === 0 && getBlock(x, y + 2, z) === 0) return { x, y: y + 1, z };
    }
  }
  return null;
}
function spawnMobAt(kind, x, y, z, opts = {}) {
  const def = MOB_DEFS[kind];
  if (!def) return null;
  if (!opts.force && (getBlock(x, y, z) !== 0 || getBlock(x, y + 1, z) !== 0)) return null;
  const parts = makeMobModel(kind);
  const m = {
    kind, p: new THREE.Vector3(x + 0.5, y + 0.02, z + 0.5), v: new THREE.Vector3(),
    hp: def.hp, maxHp: def.hp, onGround: false, atkCd: 0, phase: Math.random() * 9,
    wander: 0, dir: new THREE.Vector2(), flash: 0, aggro: 0,
    dying: false, dieT: 0, stepUp: true, flee: 0,
    home: opts.home || null,
    obj: parts.g, parts,
  };
  if (kind === 'villager') { m.recruit = { want: rollDemand(), hired: false, follow: false }; }
  if (kind === 'skeleton' && parts.arm1) {          // 骷髅右手拿一把弓
    const bow = new THREE.Group();
    const wood = new THREE.MeshLambertMaterial({ color: 0x8a6134 });
    const str = new THREE.MeshLambertMaterial({ color: 0xe8e4d6 });
    const grip = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.22, 0.05), wood);
    const upper = new THREE.Mesh(new THREE.BoxGeometry(0.045, 0.26, 0.045), wood);
    upper.position.set(0, 0.2, 0.06); upper.rotation.x = -0.5;
    const lower = new THREE.Mesh(new THREE.BoxGeometry(0.045, 0.26, 0.045), wood);
    lower.position.set(0, -0.2, 0.06); lower.rotation.x = 0.5;
    const string = new THREE.Mesh(new THREE.BoxGeometry(0.012, 0.62, 0.012), str);
    string.position.set(0, 0, -0.045);
    bow.add(grip, upper, lower, string);
    bow.position.set(0, -0.28, -0.02);
    bow.rotation.z = 0.15;
    parts.arm1.add(bow);
    m.bow = bow;
  }
  m.obj.position.copy(m.p);
  scene.add(m.obj);
  mobs.push(m);
  if (m.recruit) refreshVillagerMark(m);
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
// 能量弹：发光球 + 光环，几乎不下坠（炮比弓贵在「要充能」）
const boltMatCache = new Map();
let boltGeoCache = null;
function makeBoltModel(color) {
  if (!boltGeoCache) {
    boltGeoCache = { core: new THREE.SphereGeometry(0.12, 10, 8), ring: new THREE.TorusGeometry(0.19, 0.016, 6, 14) };
  }
  let m = boltMatCache.get(color);
  if (!m) {
    m = {
      core: new THREE.MeshBasicMaterial({ color }),
      ring: new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.75 }),
    };
    boltMatCache.set(color, m);
  }
  const g = new THREE.Group();
  g.add(new THREE.Mesh(boltGeoCache.core, m.core), new THREE.Mesh(boltGeoCache.ring, m.ring));
  g.userData.shared = true;
  return g;
}
function spawnBolt(from, to, opts = {}) {
  const dir = to.clone().sub(from).normalize();
  const obj = makeBoltModel(opts.color || 0xffb066);
  obj.position.copy(from);
  obj.lookAt(to);
  scene.add(obj);
  arrows.push({
    p: from.clone(), v: dir.multiplyScalar(opts.speed || 52), t: 0, obj,
    dmg: opts.dmg || 8, fromPlayer: true, bolt: true, grav: 0.35, maxT: 2.6,
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
    a.v.y -= (a.grav === undefined ? 6.5 : a.grav) * dt;   // 能量弹几乎不下坠（grav 0.35）
    let gone = a.t > (a.maxT || 5);
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
    if (o.material) {
      const arr = Array.isArray(o.material) ? o.material : [o.material];
      for (const mt of arr) if (!mt.userData || !mt.userData.shared) mt.dispose();   // 火焰贴片的材质是共享的
    }
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
    for (const ex of def.extra || []) {             // 附加掉落（羊：羊毛 + 羊肉）
      const [l2, h2] = ex.n || [1, 1];
      const n2 = l2 + Math.floor(Math.random() * (h2 - l2 + 1));
      spawnDrop(ex.id, n2, m.p.x, m.p.y + 0.35, m.p.z);
      toast(`还有 ${nameOf(ex.id)} ×${n2}`, 1.8);
    }
  }
  sfx('hurt');
}

/* ── 创作者结构建造：选区 → 导出 → 上传服务器 → 再放回世界 ── */
const STRUCT_API = '/blockwild/api/structure.php';
const STRUCT_TOKEN = 'bw-creator-2026-v1';
const structSel = { a: null, b: null };
let structPanel = null, structMsg = '';

function ensureStructPanel() {
  if (structPanel) return structPanel;
  structPanel = document.createElement('div');
  structPanel.id = 'structPanel';
  structPanel.style.cssText = 'position:fixed;left:12px;top:150px;z-index:34;max-width:300px;padding:9px 11px;'
    + 'border:1px solid #3a4a5e;border-radius:9px;background:rgba(14,18,26,.86);color:#cfe0f0;'
    + 'font-size:12px;line-height:1.55;display:none;pointer-events:none;font-family:inherit';
  document.body.appendChild(structPanel);
  return structPanel;
}
function structHud() {
  const el = ensureStructPanel();
  const a = structSel.a, b = structSel.b;
  let sel = '未选区（对着方块按 V 选角点1，再按 B 选角点2）';
  if (a && b) {
    const w = Math.abs(b.x - a.x) + 1, h = Math.abs(b.y - a.y) + 1, d = Math.abs(b.z - a.z) + 1;
    sel = `选区 ${w}×${h}×${d} = ${w * h * d} 格`;
  } else if (a) sel = `角点1 (${a.x},${a.y},${a.z})，再按 B 选对角`;
  el.innerHTML = `<b style="color:#8fe3ff">创作者结构</b><br>${sel}<br>`
    + `<span style="color:#8b97a6">V 角点1 · B 角点2 · P 导出并上传 · L 服务器结构列表</span>`
    + (structMsg ? `<br><span style="color:#9be36a">${structMsg}</span>` : '');
  el.style.display = 'block';
}
function setStructCorner(which) {
  if (!started) return;
  const t = raycastVoxel(eyePos(), cameraDir(), 48);
  const p = t ? { x: t.x, y: t.y, z: t.z } : { x: Math.floor(player.p.x), y: Math.floor(player.p.y), z: Math.floor(player.p.z) };
  structSel[which] = p;
  structMsg = `${which === 'a' ? '角点1' : '角点2'} (${p.x},${p.y},${p.z})`;
  sfx('place'); structHud(); saveSoon();
}
function exportStructure() {
  const a = structSel.a, b = structSel.b;
  if (!a || !b) return null;
  const x0 = Math.min(a.x, b.x), x1 = Math.max(a.x, b.x);
  const y0 = Math.min(a.y, b.y), y1 = Math.max(a.y, b.y);
  const z0 = Math.min(a.z, b.z), z1 = Math.max(a.z, b.z);
  const blocks = [];
  let capped = false;
  for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) {
    const id = getBlock(x, y, z);
    if (!id) continue;
    if (blocks.length >= 60000) { capped = true; break; }
    const m = getMeta(x, y, z);
    blocks.push(m ? [x - x0, y - y0, z - z0, id, m] : [x - x0, y - y0, z - z0, id]);
    if (capped) break;
  }
  return { size: [x1 - x0 + 1, y1 - y0 + 1, z1 - z0 + 1], blocks, capped };
}
async function uploadStructure(name) {
  const data = exportStructure();
  if (!data) { toast('先按 V / B 选两个角点', 1.8); return false; }
  structMsg = `上传中… ${data.blocks.length} 方块`;
  structHud();
  try {
    const r = await fetch(STRUCT_API, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: STRUCT_TOKEN, name: name || ('struct_' + Date.now().toString(36)), data }),
    });
    const j = await r.json();
    if (!j.ok) throw new Error(j.err || ('http ' + r.status));
    structMsg = `上传成功：${j.file}（${j.blocks} 方块 / ${j.bytes} 字节）`;
    toast(`结构已上传：${j.file}`, 3);
    sfx('craft');
    return j;
  } catch (err) {
    structMsg = `上传失败：${err.message || err}`;
    toast('上传失败：' + (err.message || err), 3);
    return false;
  } finally { structHud(); }
}
async function listStructures() {
  structMsg = '读取服务器结构列表…'; structHud();
  try {
    const r = await fetch(STRUCT_API, { cache: 'no-store' });
    const j = await r.json();
    if (!j.ok) throw new Error(j.err || ('http ' + r.status));
    window.__structList = j.files || [];
    structMsg = `服务器上 ${j.count} 个结构：` + (j.files || []).slice(0, 3).map(f => f.file).join('、');
    toast(`服务器上有 ${j.count} 个结构（控制台看 window.__structList）`, 3);
    console.log('[structures]', j.files);
    return window.__structList;
  } catch (err) {
    structMsg = '列表读取失败：' + (err.message || err); toast(structMsg, 3);
    return [];
  } finally { structHud(); }
}
async function placeStructureAt(file, ox, oy, oz) {     // 从服务器拉一个结构直接放到世界里
  try {
    const r = await fetch(STRUCT_API + '?get=' + encodeURIComponent(file), { cache: 'no-store' });
    const j = await r.json();
    const blocks = (j && j.blocks) || [];
    let n = 0;
    for (const b of blocks) {
      const [x, y, z, id, m] = b;
      setBlock(ox + x, oy + y, oz + z, id);
      if (m) setMeta(ox + x, oy + y, oz + z, m);
      n++;
    }
    toast(`已放置结构 ${file}（${n} 方块）`, 2.4);
    structMsg = `已放置 ${file}：${n} 方块`;
    structHud(); saveSoon();
    return n;
  } catch (err) { toast('放置结构失败：' + (err.message || err), 3); return 0; }
}

/* ── 村民导航小工具 ────────────────────────────────────────────────
   ① steerTo：直线被挡就 ±30°/±60°/±90° 扇扫，找一个能走的方向（贴墙绕行，不再一头撞墙）
   ② findDoorNear：在床周围找「下半格的门」（村民要开门才能进屋） */
function steerTo(ent, tx, tz) {
  const dx = tx - ent.p.x, dz = tz - ent.p.z;
  const d = Math.hypot(dx, dz) || 1;
  let ax = dx / d, az = dz / d;
  const probe = (x, z) => sightClear({ x: ent.p.x, y: ent.p.y, z: ent.p.z }, { x: ent.p.x + x * 1.7, y: ent.p.y, z: ent.p.z + z * 1.7 });
  if (!probe(ax, az)) {
    for (const a of [0.55, -0.55, 1.05, -1.05, 1.55, -1.55]) {
      const ca = Math.cos(a), sa = Math.sin(a);
      const nx = ax * ca - az * sa, nz = ax * sa + az * ca;
      if (probe(nx, nz)) { ax = nx; az = nz; break; }
    }
  }
  return { x: ax, z: az };
}
function findDoorNear(pos, r) {
  const cx = Math.floor(pos.x), cy = Math.floor(pos.y), cz = Math.floor(pos.z);
  let best = null, bd = 1e9;
  for (let dy = -3; dy <= 3; dy++) for (let dx = -r; dx <= r; dx++) for (let dz = -r; dz <= r; dz++) {
    const x = cx + dx, y = cy + dy, z = cz + dz;
    if (getBlock(x, y, z) !== 35) continue;
    if (getMeta(x, y, z) & 8) continue;                    // 只认门的下半格
    if (getBlock(x, y - 1, z) === 35) continue;            // 上面那半格也不认（toggleDoor 只从下半格开始翻）
    const d2 = dx * dx + dy * dy * 4 + dz * dz;            // 高度差加权（宁可走平路）
    if (d2 < bd) { bd = d2; best = { x, y, z }; }
  }
  return best;
}

/* ── 村民睡觉：天黑了找个床躺下 ── */
function findBedNear(pos, r) {
  const cx = Math.floor(pos.x), cy = Math.floor(pos.y), cz = Math.floor(pos.z);
  for (let dy = -4; dy <= 2; dy++) for (let dx = -r; dx <= r; dx++) for (let dz = -r; dz <= r; dz++) {
    const bx = cx + dx, by = cy + dy, bz = cz + dz;
    if (getBlock(bx, by, bz) !== 14) continue;
    if (getMeta(bx, by, bz) >= 5) continue;                 // 只认脚格
    return { x: bx, y: by, z: bz };
  }
  return null;
}
function startSleep(m) {
  if (!m.bed) return;
  m.sleeping = true;
  m.v.set(0, 0, 0);
  m.p.set(m.bed.x + 0.5, m.bed.y + 0.55, m.bed.z + 0.5);
  if (m.parts.core) {                                       // 躺下
    m.parts.core.rotation.x = -1.45;
    m.parts.core.position.y = m.parts.coreY - 0.12;
  }
  if (m.parts.arm1) m.parts.arm1.rotation.x = -0.4;
  if (m.parts.arm2) m.parts.arm2.rotation.x = -0.4;
  if (m.mark) m.mark.visible = false;
}
function wakeUp(m) {
  m.sleeping = false;
  if (m.parts.core) { m.parts.core.rotation.x = 0; m.parts.core.position.y = m.parts.coreY; }
  if (m.parts.arm1) m.parts.arm1.rotation.x = 0;
  if (m.parts.arm2) m.parts.arm2.rotation.x = 0;
  if (m.mark) m.mark.visible = true;
}

/* ── 火焰特效贴片：会冒火的怪（日光灼烧 / 泡岩浆）身上挂 3 片 billboard 火焰，
   玩家自己身上着火时在画面下缘也糊几片。纹理只做一次，材质共享（别在 killMob 里被 dispose）。 */
let FLAME_TEX = null, FLAME_MAT = null;
function flameTexture() {
  if (FLAME_TEX) return FLAME_TEX;
  const S = 32, cv = document.createElement('canvas');
  cv.width = cv.height = S;
  const g = cv.getContext('2d');
  const grad = g.createRadialGradient(S / 2, S * 0.66, 1, S / 2, S * 0.66, S * 0.5);
  grad.addColorStop(0, 'rgba(255,255,225,0.95)');
  grad.addColorStop(0.26, 'rgba(255,216,90,0.88)');
  grad.addColorStop(0.58, 'rgba(255,124,24,0.55)');
  grad.addColorStop(1, 'rgba(190,36,0,0)');
  g.fillStyle = grad;
  g.beginPath();                                       // 上尖下圆的火苗
  g.moveTo(S / 2, 2);
  g.bezierCurveTo(S * 0.94, S * 0.44, S * 0.86, S * 0.96, S / 2, S - 1);
  g.bezierCurveTo(S * 0.14, S * 0.96, S * 0.06, S * 0.44, S / 2, 2);
  g.closePath(); g.fill();
  g.globalCompositeOperation = 'lighter';               // 中间再来一道亮芯
  const core = g.createRadialGradient(S / 2, S * 0.72, 0.5, S / 2, S * 0.72, S * 0.22);
  core.addColorStop(0, 'rgba(255,255,255,0.9)');
  core.addColorStop(1, 'rgba(255,220,120,0)');
  g.fillStyle = core;
  g.fillRect(0, 0, S, S);
  FLAME_TEX = new THREE.CanvasTexture(cv);
  return FLAME_TEX;
}
function flameMaterial(ownOpacity) {
  if (!FLAME_MAT) {
    FLAME_MAT = new THREE.SpriteMaterial({
      map: flameTexture(), transparent: true, depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    FLAME_MAT.userData.shared = true;                   // killMob 不许 dispose 它
    FLAME_MAT.userData.flame = true;
  }
  return ownOpacity ? FLAME_MAT.clone() : FLAME_MAT;
}
function ensureMobFlames(m) {
  if (m.fx) return m.fx;
  const list = [];
  for (let i = 0; i < 3; i++) {                         // 脚 / 腰 / 头
    const sp = new THREE.Sprite(flameMaterial(false));
    sp.position.set((Math.random() - 0.5) * 0.55, 0.4 + i * 0.42, (Math.random() - 0.5) * 0.45);
    sp.userData.base = 0.42 + Math.random() * 0.22;
    sp.userData.phase = Math.random() * 6.283;
    sp.userData.y0 = sp.position.y;
    sp.scale.setScalar(sp.userData.base);
    m.obj.add(sp);
    list.push(sp);
  }
  m.fx = list;
  return list;
}
// 玩家自己身上的火：贴在画面下缘（handScene 是单独一个场景，用 handCam 渲染）
const playerFlames = [];
function ensurePlayerFlames() {
  if (playerFlames.length) return playerFlames;
  for (const [x, y, z, s] of [[-0.62, -0.52, -1.0, 0.55], [0.62, -0.5, -1.0, 0.5],
                              [-0.28, -0.66, -1.15, 0.42], [0.3, -0.68, -1.12, 0.4]]) {
    const sp = new THREE.Sprite(flameMaterial(true));
    sp.position.set(x, y, z);
    sp.userData.base = s;
    sp.userData.phase = Math.random() * 6.283;
    sp.scale.setScalar(s);
    sp.visible = false;
    handScene.add(sp);
    playerFlames.push(sp);
  }
  return playerFlames;
}
function updateFlames(dt) {
  const t = worldTime * 3 + performance.now() * 0.001;
  for (const m of mobs) {
    const list = m.fx;
    if (!(m.burn > 0)) { if (list) for (const sp of list) sp.visible = false; continue; }
    const l = list || ensureMobFlames(m);
    for (const sp of l) {
      sp.visible = true;
      sp.scale.setScalar(sp.userData.base * (0.72 + 0.3 * Math.abs(Math.sin(t * 9 + sp.userData.phase))));
      sp.position.y = sp.userData.y0 + 0.07 * Math.sin(t * 6 + sp.userData.phase);
    }
  }
  if (player.burn > 0) {
    const l = ensurePlayerFlames();
    for (let i = 0; i < l.length; i++) {
      const sp = l[i];
      sp.visible = true;
      const f = 0.7 + 0.42 * Math.abs(Math.sin(t * 8 + sp.userData.phase));
      sp.scale.setScalar(sp.userData.base * f);
      sp.position.y += Math.sin(t * 5 + i) * 0.0008;
    }
  } else if (playerFlames.length) {
    for (const sp of playerFlames) sp.visible = false;
  }
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
    const hostileNow = def.hostile && !isCreative() && (night || m.aggro > 0);   // 创造模式：怪物不敌对
    animateMob(m, dt, dx, dz, dist);                                            // 摆臂/迈腿/呼吸/盯人
    // 骷髅：举弓瞄准 → 射完收弓（拉弓动画）
    if (m.kind === 'skeleton' && m.parts.arm1) {
      const aiming = def.ranged && hostileNow && dist < 20;
      const want = aiming ? (m.shootCd > 1.15 ? -1.45 : -1.15) : -0.2;
      m.parts.arm1.rotation.x += (want - m.parts.arm1.rotation.x) * Math.min(1, dt * 9);
      if (m.bow) m.bow.rotation.x = aiming ? -0.25 : 0;
    }
    m.flash = Math.max(0, m.flash - dt);
    m.aggro = Math.max(0, m.aggro - dt);
    m.flee = Math.max(0, m.flee - dt);
    if (m.hp <= 0) { startMobDeath(m); continue; }
    if (dist > 72) { killMob(m); mobs.splice(i, 1); continue; }
    if (!def.hostile && !night && dist > 44) { killMob(m); mobs.splice(i, 1); continue; }

    let mx = 0, mz = 0, speed = def.wander;
    // ── 村民：状态机（idle / to-bed / to-door / sleep / follow）+ 绕障 + 开门进屋 ──
    if (m.kind === 'villager') {
      const ai = m.ai || (m.ai = { state: 'idle', door: null, doorT: 0, stuckT: 0, lx: m.p.x, lz: m.p.z });
      if (night && !m.sleeping) {
        if (m.bedScan === undefined) m.bedScan = Math.random() * 3;      // 错开扫描，别所有村民同一帧扫全场
        m.bedScan -= dt;
        if (m.bedScan <= 0) {
          m.bedScan = 6;
          if (!m.bed) m.bed = findBedNear(m.p, 12);
          if (m.bed) ai.door = findDoorNear(m.bed, 6);                   // 床在屋里 → 记下最近的门
        }
        if (m.bed) {
          const bdx = m.bed.x + 0.5 - m.p.x, bdz = m.bed.z + 0.5 - m.p.z;
          const bd = Math.hypot(bdx, bdz);
          const seeBed = sightClear({ x: m.p.x, y: m.p.y, z: m.p.z }, { x: m.bed.x + 0.5, y: m.bed.y, z: m.bed.z + 0.5 });
          ai.state = (ai.door && !seeBed) ? 'to-door' : 'to-bed';
          if (bd < 2.3 && Math.abs(m.bed.y - m.p.y) < 2.6 && (seeBed || !ai.door)) {
            startSleep(m); ai.state = 'sleep';
          } else {
            let tx2 = m.bed.x + 0.5, tz2 = m.bed.z + 0.5;
            if (ai.state === 'to-door') { tx2 = ai.door.x + 0.5; tz2 = ai.door.z + 0.5; }
            const st = steerTo(m, tx2, tz2);
            mx = st.x; mz = st.z; speed = Math.max(def.wander, 2.4); m.bedTgt = true;
            if (ai.state === 'to-door' && ai.door) {
              // 1 格宽的门 + 0.6 宽的身体：先横向对准门洞中线，再直着穿过去（否则永远卡在门框边）
              const dcx = ai.door.x + 0.5, dcz = ai.door.z + 0.5;
              if (Math.abs(m.p.x - dcx) > 0.12) { mx = Math.sign(dcx - m.p.x); mz = 0; }
              else { mx = 0; mz = Math.sign(dcz - m.p.z) || -1; }
            }
            // 走到门口就把门推开（门开着才能穿过去；collides 会跳过 meta&4 的门）
            if (ai.door) {
              const dd = Math.hypot(ai.door.x + 0.5 - m.p.x, ai.door.z + 0.5 - m.p.z);
              ai.doorT = (ai.doorT || 0) - dt;
              if (dd < 2.4 && ai.doorT <= 0 && !(getMeta(ai.door.x, ai.door.y, ai.door.z) & 4)) {
                ai.doorT = 1.8;
                toggleDoor(ai.door.x, ai.door.y, ai.door.z);
              }
            }
          }
        } else {
          ai.state = 'idle';
        }
      } else if (!night && m.sleeping) { wakeUp(m); ai.state = 'idle'; }
      if (!m.bed && !m.sleeping) { m.bedTgt = false; if (ai.state !== 'idle') ai.state = 'idle'; }
      if (m.sleeping) { mx = 0; mz = 0; speed = 0; m.v.x = 0; m.v.z = 0; ai.state = 'sleep'; }
      // 卡住检测：每 1 秒看一次位移（每帧位移只有 0.04 格，用帧位移判断会一直误判「卡住」）
      if (m.bedTgt && !m.sleeping) {
        ai.watchT = (ai.watchT || 0) + dt;
        if (ai.watchT >= 1.0) {
          const moved = Math.hypot(m.p.x - ai.lx, m.p.z - ai.lz);
          ai.stuckT = moved < 0.25 ? (ai.stuckT || 0) + ai.watchT : 0;
          ai.watchT = 0; ai.lx = m.p.x; ai.lz = m.p.z;
        }
        if (ai.stuckT > 8) { m.bed = null; ai.door = null; m.bedTgt = false; ai.stuckT = 0; m.bedScan = 4; ai.state = 'idle'; }
      } else { ai.stuckT = 0; ai.watchT = 0; ai.lx = m.p.x; ai.lz = m.p.z; }
    }
    if (def.ranged && hostileNow && player.alive) {      // 骷髅：保持距离并射箭
      if (dist > 15) { mx = dx / (dist || 1); mz = dz / (dist || 1); speed = def.chase; }
      else if (dist < 6) { mx = -dx / (dist || 1); mz = -dz / (dist || 1); speed = def.chase * 0.85; }
      m.shootCd = (m.shootCd || 0) - dt;
      if (m.shootCd <= 0 && dist < 20 && sightClear(m.p, player.p)) { m.shootCd = 1.7; shootArrow(m); }
    } else if (def.hostile && hostileNow) {
      const tgm = (m.target && m.target.hp > 0 && !m.target.dying && !m.target.recruit?.dying) ? m.target : null;
      const tx = tgm ? tgm.p.x : player.p.x, tz = tgm ? tgm.p.z : player.p.z;
      const tdx = tx - m.p.x, tdz = tz - m.p.z, td2 = Math.hypot(tdx, tdz);
      if (td2 < 26 && (tgm || player.alive)) { mx = tdx / (td2 || 1); mz = tdz / (td2 || 1); speed = def.chase; }
    } else if (m.flee > 0) {                         // 被打之后逃跑
      mx = -dx / (dist || 1); mz = -dz / (dist || 1); speed = def.chase;
    } else if (m.kind === 'villager' && m.bedTgt) {
      // 村民正在「去门口 / 去床边」：方向已由上面的状态机算好，**绝不能**被闲逛分支覆盖
      //（旧代码就是在这里被覆盖成随机闲逛，所以村民从来走不到床前）
    } else {
      m.wander -= dt;
      if (m.wander <= 0) {
        m.wander = 1.5 + Math.random() * 2.5;
        const a = Math.random() * Math.PI * 2;
        m.dir.set(Math.cos(a), Math.sin(a));
      }
      let wx = m.dir.x, wz = m.dir.y;
      const fbx = Math.floor(m.p.x + wx * 1.5), fbz = Math.floor(m.p.z + wz * 1.5), fby = Math.floor(m.p.y);
      const fb = getBlock(fbx, fby, fbz);
      if (fb === 5 || fb === 44 || (fb === 0 && getBlock(fbx, fby - 1, fbz) === 5)) { m.wander = 0; wx = -wx; wz = -wz; }
      mx = wx * 0.45; mz = wz * 0.45;
      if (m.home) {                                  // 村民别走太远
        const hx = m.home.x - m.p.x, hz = m.home.z - m.p.z;
        const hd = Math.hypot(hx, hz);
        if (hd > 14) { mx = hx / hd; mz = hz / hd; speed = def.wander; }
      }
    }
    if (!m.sleeping && !m.bedTgt && m.recruit && m.recruit.hired && m.recruit.follow && player.alive) {
      if (dist > 2.9) { mx = dx / (dist || 1); mz = dz / (dist || 1); speed = def.chase + 0.7; }
      else { mx = 0; mz = 0; speed = 0; }
    }
    // 村民任务：拿剑 → 自动打玩家周围的怪
    if (!m.sleeping && !m.bedTgt && m.recruit && m.recruit.hired && m.give && ITEMS[m.give.id] && ITEMS[m.give.id].kind === 'sword' && player.alive) {
      m.scanCd = (m.scanCd || 0) - dt;
      if (m.scanCd <= 0) { m.scanCd = 0.4; m.tgt = nearestHostileFrom(m, 16, 18); }
      const tg = (m.tgt && !m.tgt.dying && m.tgt.hp > 0) ? m.tgt : null;
      if (tg) {
        const td = Math.hypot(tg.p.x - m.p.x, tg.p.z - m.p.z);
        if (td > 1.7) { mx = (tg.p.x - m.p.x) / td; mz = (tg.p.z - m.p.z) / td; speed = 3.6; }
        else if (sightClear(m.p, tg.p)) {                 // 隔墙不挥空
          mx = 0; mz = 0; speed = 0;
          m.vAtk = (m.vAtk || 0) - dt;
          if (m.vAtk <= 0) { m.vAtk = 1.1; villagerAttack(m, tg); }
        }
      }
    }
    // 离玩家太远：直接传送到身边（跟随 12 格、待命 40 格）
    if (m.recruit && m.recruit.hired && player.alive && !m.sleeping) {
      const far = m.recruit.follow ? 12 : 40;
      if (dist > far) {
        m.p.set(player.p.x + (Math.random() - 0.5) * 1.2, player.p.y + 0.35, player.p.z + 1.6);
        m.v.set(0, 0, 0);
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
    // 只在「想走却两轴都没走动」且连续卡住 0.3 秒时才跳一下。
    // 旧写法是「任一轴没变化就跳」→ 站着不动（mx=mz=0）和沿正南正北直线走（x 不变）都会每帧起跳，
    // 玩家看到的就是「生物有时候莫名其妙地跳」。
    const wantMove = Math.hypot(mx, mz) > 0.05;
    const stalled = Math.abs(m.p.x - before) < 0.001 && Math.abs(m.p.z - beforeZ) < 0.001;
    if (!def.float && m.onGround && wantMove && stalled) {
      m.stuckT = (m.stuckT || 0) + dt;
      if (m.stuckT > 0.3) { m.v.y = CFG.JUMP * 0.85; m.stuckT = 0; m.jumps = (m.jumps || 0) + 1; }
    } else m.stuckT = 0;
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
    // 摆臂 / 迈腿 / 身体起伏统一交给 animateMob（在 AI 之前调用，骷髅瞄准可以再覆盖手臂）
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
        m.burn = Math.max(m.burn || 0, 0.9);            // 冒火（贴片由 updateFlames 画）
        if (m.hp <= 0) { startMobDeath(m); continue; }
      } else if (m.parts.bodyMat.emissive.getHex() === 0x552211) {
        m.parts.bodyMat.emissive.setHex(0x000000);      // 进阴影里就灭火（原来这里忘了收）
      }
    }
    // 泡在岩浆里的怪：持续燃烧 + 掉血
    if (getBlock(Math.floor(m.p.x), Math.floor(m.p.y + 0.3), Math.floor(m.p.z)) === 44) {
      m.burn = Math.max(m.burn || 0, 2.0);
      m.hp -= dt * 4;
      if (m.hp <= 0) { startMobDeath(m); continue; }
    }
    if (m.burn > 0) {
      m.burn -= dt;
      m.parts.bodyMat.emissive.setHex(0x7a2200);        // 着火时身上带橙光
    }
    // 贴身攻击（所有敌对生物；骷髅是远程，只有贴脸才用近战）
    if (isCreative() && m.target === player) m.target = null;
    m.atkCd -= dt;
    const tgtMob = (m.target && m.target.hp > 0 && !m.target.dying) ? m.target : null;
    const reach = def.boss ? 2.4 : 1.5;
    if (tgtMob) {                                                   // 目标已改成村民：打村民
      const dv = Math.hypot(tgtMob.p.x - m.p.x, tgtMob.p.z - m.p.z);
      if (def.hostile && hostileNow && dv < reach && m.atkCd <= 0 && sightClear(m.p, tgtMob.p)) {
        m.atkCd = def.atkCd || 1.6; m.lunge = 0.3;
        tgtMob.hp -= (def.dmg || 3) * 0.8;
        tgtMob.flash = 0.24;
        if (tgtMob.hp <= 0) startMobDeath(tgtMob);
        sfx('hurt');
      }
    } else if (def.hostile && hostileNow && dist < reach && m.atkCd <= 0 && player.alive && Math.abs(m.p.y - player.p.y) < (def.boss ? 3.2 : 2.0) && sightClear(m.p, player.p)) {
      m.atkCd = def.atkCd || 1.6; m.lunge = 0.3;
      hurtPlayerFrom(m.p.x, m.p.z, def.dmg || 3);
      sfx('hurt');
    }
  }
  updateArrows(dt);
  // 刷怪：敌对生物只在黑暗处，和平生物在草地，村民在村庄
  if (DIM === 'nether') {
    // 冥界：只刷冥界生物（findNetherSpot 在玩家附近找落脚点，别用主世界的 surfaceY）
    if (countKind('blaze') < 3 && Math.random() < dt * 0.30) { const s2 = findNetherSpot(); if (s2) spawnMobAt('blaze', s2.x, s2.y, s2.z); }
    if (countKind('netherBeast') < 2 && Math.random() < dt * 0.22) { const s3 = findNetherSpot(); if (s3) spawnMobAt('netherBeast', s3.x, s3.y, s3.z); }
    if (countKind('croc') < 3 && Math.random() < dt * 0.22) { const s4 = findNetherSpot(); if (s4) spawnMobAt('croc', s4.x, s4.y, s4.z); }
  }
  const capGrunt = night ? CFG.MAX_MOBS + 2 : CFG.MAX_MOBS;
  if (DIM !== 'nether') {
    if (countKind('grunt') < capGrunt && Math.random() < dt * 0.28) spawnMob('grunt');   // 0.85 → 0.28（约 1/3）
    if (countKind('pig') < 4 && Math.random() < dt * 0.12) spawnMob('pig');
    if (countKind('cow') < 3 && Math.random() < dt * 0.10) spawnMob('cow');
    if (countKind('sheep') < 3 && Math.random() < dt * 0.10) spawnMob('sheep');
    if (countKind('chicken') < 4 && Math.random() < dt * 0.13) spawnMob('chicken');
    if (countKind('spider') < 3 && Math.random() < dt * 0.18) spawnMob('spider');   // 0.55 → 0.18，上限 4 → 3
    if (countKind('skeleton') < 3 && Math.random() < dt * 0.30) spawnMob('skeleton');
  }
  if (DIM === 'nether') return;                     // 冥界不刷鬼屋幽灵
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
let dropSeq = 0;                     // 掉落物编号：联机里主机广播它，客人靠它认「同一个掉落物」
const dropTexCache = new Map();
function dropTexture(id) {
  if (dropTexCache.has(id)) return dropTexCache.get(id);
  const tex = new THREE.TextureLoader().load(iconURL(id));
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.NearestFilter;
  dropTexCache.set(id, tex);
  return tex;
}
/* ── 掉落物模型 ──────────────────────────────────────────────────────────
   方块 → 0.38 立方体（六面都是方块贴图，正确）；
   物品（工具/食物/材料/炮）→ 0.36×0.36×0.055 的**薄板**：图标只在正反两面，
   四个窄边是全透明材质 ⇒ 看起来就是「一张有厚度的 2D」，转过侧面能看到薄薄一条，
   而不是原来那样把 2D 图标糊在立方体的 6 个面上。几何/材质按 id 缓存共享。 */
const DROP_EDGE_MAT = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false });
const dropFaceMatCache = new Map();
let ITEM_DROP_GEO = null;
function dropFaceMat(id) {
  let m = dropFaceMatCache.get(id);
  if (!m) { m = new THREE.MeshBasicMaterial({ map: dropTexture(id), alphaTest: 0.5 }); dropFaceMatCache.set(id, m); }
  return m;
}
function itemDropMesh(id) {
  if (!ITEM_DROP_GEO) ITEM_DROP_GEO = new THREE.BoxGeometry(0.36, 0.36, 0.055);
  const e = DROP_EDGE_MAT, f = dropFaceMat(id);
  const mesh = new THREE.Mesh(ITEM_DROP_GEO, [e, e, e, e, f, f]);   // +z / -z 才是图标
  mesh.userData.sharedGeo = true;                                   // 共享资源：捡起时不要 dispose
  return mesh;
}
// 薄板类掉落物：只绕 Y 面向相机（±18° 轻摆 + 微倾），保证任何时刻都看得到图标；
// 方块掉落物仍然照常自旋。
function orientDropCard(obj, x, z, t) {
  obj.rotation.y = Math.atan2(camera.position.x - x, camera.position.z - z) + Math.sin(t * 1.6) * 0.32;
  obj.rotation.x = -0.18;
}
function spawnDrop(id, n, x, y, z, opts = {}) {
  if (!isItem(id) || n <= 0) return null;
  // ★ 联机客人：掉落物的物理模拟归主机。以前客人也在本地 spawn 一份，但 updateDrops 被禁了，
  //   于是那份掉落物**悬空不动、也永远捡不起来**。现在改成只上报，由主机 spawn 真掉落物再广播回来。
  if (NET && NET.active && !NET.isHost && !opts.fromHost) return NET.remoteDrop(id, n, x, y, z);
  if (drops.length >= DROP_MAX) { addItem(id, n); return null; }   // 太挤就直接进包
  const mesh = BLOCKS[id]
    ? new THREE.Mesh(new THREE.BoxGeometry(0.38, 0.38, 0.38), new THREE.MeshBasicMaterial({ map: dropTexture(id) }))
    : itemDropMesh(id);
  const d = {
    id, n, t: 0, c: opts.c, spin: Math.random() * 6, nid: opts.nid || (++dropSeq),
    p: new THREE.Vector3(x, y, z),
    v: new THREE.Vector3(opts.vx !== undefined ? opts.vx : (Math.random() - 0.5) * 1.4, opts.pop || 2.4,
                        opts.vz !== undefined ? opts.vz : (Math.random() - 0.5) * 1.4),
    obj: mesh, thin: !BLOCKS[id],
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
    if (d.thin) orientDropCard(d.obj, d.p.x, d.p.z, d.t);
    else {
      d.obj.rotation.y = d.spin;
      d.obj.rotation.x = Math.sin(d.spin * 0.7) * 0.15;
    }
    if (d.t > 0.3 && dist < 0.95) {                       // 拾取
      if (ITEMS[d.id] && ITEMS[d.id].kind === 'gun' && d.c !== undefined) {
        // 能量炮：捡回来要保留电量（不然丢一次就是免费充满）
        const gslot = inv.findIndex(s => !s);
        if (gslot >= 0) inv[gslot] = { id: d.id, n: 1, c: Math.max(0, Math.min(gunCap(d.id), d.c | 0)) };
        else addItem(d.id, d.n);
      } else addItem(d.id, d.n);
      if (d.n > 1) toast(`拾取 ${nameOf(d.id)} ×${d.n}`, 1.1);
      sfx('dig');
      renderHotbar();
      scene.remove(d.obj);
      if (!d.obj.userData.sharedGeo) {
        d.obj.geometry.dispose();
        if (Array.isArray(d.obj.material)) d.obj.material.forEach(mm => mm && mm.dispose && mm.dispose());
        else if (d.obj.material && d.obj.material.dispose) d.obj.material.dispose();
      }
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
// 格子里的状态条：工具/剑=耐久（绿→黄→红），能量炮=电量（青蓝→黄→红）
function slotBarHTML(s) {
  const idef = s && ITEMS[s.id];
  if (!idef) return '';
  if (idef.kind === 'gun') {
    const cap = idef.cap || 8, c = s.c === undefined ? cap : Math.max(0, Math.min(cap, s.c));
    const f = c / cap;
    const col = f > 0.5 ? '#4de0d0' : f > 0.2 ? '#f0c04a' : '#e0524b';
    return `<i class="dur"><b style="width:${(f * 100).toFixed(0)}%;background:${col}"></b></i>`;
  }
  if (!idef.dur) return '';
  const left = s.d === undefined ? idef.dur : s.d;
  const f = Math.max(0, Math.min(1, left / idef.dur));
  const col = f > 0.5 ? '#7fe06b' : f > 0.25 ? '#f0c04a' : '#e0524b';
  return `<i class="dur"><b style="width:${(f * 100).toFixed(0)}%;background:${col}"></b></i>`;
}
function renderHotbar() {
  const row = hud.hotbar;
  row.innerHTML = '';
  for (let i = 0; i < 9; i++) {
    const s = inv[i];
    const d = document.createElement('div');
    d.className = 'slot' + (i === player.sel ? ' sel' : '');
    const durBar = slotBarHTML(s);
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
    d.title = nameOf(id) + '（点一下拿在手上）';
    d.onclick = () => {
      const it2 = ITEMS[id];
      const stack = (it2 && (it2.dur || it2.kind === 'gun' || it2.kind === 'armor')) ? 1 : 64;   // 武器/工具/护甲只拿 1 件
      if (cursor) {                                   // 手上已有东西 → 直接丢弃，不塞进背包
        toast(`已丢弃 ${nameOf(cursor.id)} ×${cursor.n}`, 1.2);
        cursor = null;
      }
      cursor = { id, n: stack };
      renderInventoryPanel();
      renderHotbar();
    };
    box.appendChild(d);
  }
}
function renderSquadStrip() {                    // 背包里的「小队」区域（最多 3 人）
  if (!hud.invGrid) return;
  let el = document.getElementById('invSquad');
  if (!el) {
    el = document.createElement('div');
    el.id = 'invSquad';
    el.style.cssText = 'margin:8px 0 4px;padding:8px;border:1px solid #3a4757;border-radius:8px;background:rgba(255,255,255,.03)';
    hud.invGrid.parentNode.insertBefore(el, hud.invGrid);
  }
  const list = squadList();
  const cell = (m, i) => {
    if (!m) return `<div style="flex:1;margin:0 3px;padding:8px 4px;border:1px dashed #39465a;border-radius:7px;color:#66748a;text-align:center;font-size:11px">空位</div>`;
    const gearN = m.equip ? ARMOR_SLOTS.filter(k => m.equip[k]).length : 0;
    return `<div data-sq="${i}" style="flex:1;margin:0 3px;padding:7px 4px;border:1px solid ${m.recruit.follow ? '#3f7a4a' : '#43546b'};`
      + `border-radius:7px;background:${m.recruit.follow ? '#16281c' : '#1a212b'};text-align:center;font-size:11px;cursor:pointer">`
      + `<div style="font-size:15px">🧑‍🌾</div>${m.recruit.follow ? '跟随中' : '待命'}<br>`
      + `<span style="color:#9fb0c2">护甲 ${gearN}/4</span></div>`;
  };
  el.innerHTML = `<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px">`
    + `<b style="font-size:12px;color:#cfdae6">小队 ${list.length}/${MAX_SQUAD}</b>`
    + `<span style="font-size:10px;color:#7f8c9b">点一下查看 / 换装</span></div>`
    + `<div style="display:flex">${[0, 1, 2].map(i => cell(list[i], i)).join('')}</div>`;
  el.onclick = (e) => {
    const t = e.target.closest('[data-sq]');
    if (!t) return;
    const m = squadList()[+t.dataset.sq];
    if (m) openVillagerPanel(m);
  };
}
function renderInventoryPanel() {
  renderSquadStrip();
  renderArmorRow();
  renderCreativeGrid();
  renderGrid(hud.invGrid, inv, i => slotClick(inv, i));
  if ($('cursorInfo')) $('cursorInfo').textContent = cursorText();
  updateCursorEl();
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
  // ── 铜器：石 → 铜 → 铁的中间档（铜镐够格挖铁矿，钻石矿仍要铁镐）──
  { out: 163, n: 1, need: { 162: 3, 104: 2 }, tier: 1 },
  { out: 164, n: 1, need: { 162: 2, 104: 1 }, tier: 1 },
  { out: 165, n: 1, need: { 162: 2, 104: 2 }, tier: 1 },
  { out: 166, n: 1, need: { 162: 4 }, tier: 1 },
  { out: 167, n: 1, need: { 162: 6 }, tier: 1 },
  { out: 168, n: 1, need: { 162: 5 }, tier: 1 },
  { out: 169, n: 1, need: { 162: 3 }, tier: 1 },
  { out: 194, n: 1, need: { 193: 1, 179: 1 }, tier: 3 },   // 噩梦之心 + 冥界钢剑 → 噩梦之刃
  // ── 电路系统：铜 → 电线 / 电路板 → 充电器 + 四档能量炮 ──
  { out: 186, n: 4, need: { 162: 1 } },                        // 电线 ×4 ← 铜锭 1（不用工作台，开局就能绕线）
  { out: 185, n: 1, need: { 162: 3, 8: 1 }, tier: 1 },         // 电路板 ← 铜锭 3 + 木板 1
  { out: 53,  n: 1, need: { 9: 6, 162: 4, 186: 2 }, tier: 1 }, // 充电器 ← 圆石 6 + 铜锭 4 + 电线 2
  { out: 188, n: 1, need: { 185: 1, 186: 3, 162: 4 }, tier: 1 },   // 铜能量炮   dmg 8  电量 8
  { out: 189, n: 1, need: { 185: 1, 186: 3, 106: 4 }, tier: 1 },   // 铁能量炮   dmg 12 电量 10
  { out: 190, n: 1, need: { 185: 1, 186: 4, 125: 3 }, tier: 1 },   // 钻石能量炮 dmg 17 电量 12
  { out: 191, n: 1, need: { 185: 1, 186: 4, 178: 2 }, tier: 1 },   // 冥界钢能量炮 dmg 22 电量 14
  // ── 木器：原木 →（木头加工器）→ 木片 → 木盔甲。最弱的一套护甲，开局就能凑齐（合计 7 点 vs 铜 12 / 铁 15）
  { out: 40, n: 1, need: { 6: 2, 8: 4, 9: 4 }, tier: 1 },     // 木头加工器：原木 2 + 木板 4 + 圆石 4
  { out: 171, n: 1, need: { 170: 6 }, tier: 1 },              // 木头盔
  { out: 172, n: 1, need: { 170: 10 }, tier: 1 },             // 木胸甲
  { out: 173, n: 1, need: { 170: 8 }, tier: 1 },              // 木护腿
  { out: 174, n: 1, need: { 170: 4 }, tier: 1 },              // 木靴
  // ── 传送块：幽灵王掉的幽灵精华 → 开启传送门（再进冥界）
  { out: 175, n: 1, need: { 155: 4, 106: 2, 22: 1 }, tier: 1 },
  // 液压机：钻石 + 铁（把 冥界碳 + 铁 压成 钢）
  { out: 47, n: 1, need: { 125: 3, 106: 6 }, tier: 1 },
  // 冥界钢装备（材料来自液压机：冥界碳 + 铁 → 冥界钢）
  { out: 179, n: 1, need: { 178: 2, 104: 1 }, tier: 1 },      // 冥界钢剑：16 伤害（钻石 13）
  { out: 184, n: 1, need: { 178: 3, 104: 2 }, tier: 1 },      // 冥界钢镐：速度 4.2（钻石 3.4）
  { out: 180, n: 1, need: { 178: 5 }, tier: 1 },              // 冥界钢头盔
  { out: 181, n: 1, need: { 178: 8 }, tier: 1 },              // 冥界钢胸甲
  { out: 182, n: 1, need: { 178: 7 }, tier: 1 },              // 冥界钢护腿
  { out: 183, n: 1, need: { 178: 4 }, tier: 1 },              // 冥界钢靴
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
  { out: 35, n: 3, need: { 8: 6 }, tier: 1 },
  { out: 130, n: 1, need: { 125: 3, 104: 2 }, tier: 1 },
  { out: 131, n: 1, need: { 125: 2, 104: 1 }, tier: 1 },
  { out: 132, n: 1, need: { 125: 5 }, tier: 1 },
  { out: 133, n: 1, need: { 125: 8 }, tier: 1 },
  { out: 134, n: 1, need: { 125: 7 }, tier: 1 },
  { out: 135, n: 1, need: { 125: 4 }, tier: 1 },
];
// 熔炉：1 份燃料 + 1 份原料 → 1 份产物（燃料：木板 or 炼好的煤块）
const SMELT = [
  { in: 39, out: 162, n: 1, name: '铜矿石 → 铜锭' },
  { in: 15, out: 106, n: 1, name: '铁矿石 → 铁锭' },
  { in: 108, out: 109, n: 1, name: '生猪排 → 熟猪排' },
  { in: 140, out: 141, n: 1, name: '生牛肉 → 熟牛肉' },
  { in: 143, out: 144, n: 1, name: '鸡肉 → 熟鸡肉' },
  { in: 145, out: 146, n: 1, name: '生羊肉 → 熟羊肉' },
  { in: 4, out: 124, n: 0, name: '' },              // 占位（沙子暂无用途）
];
// 燃料：units = 一块能烧几个物品，time = 每个物品要烧多少秒（燃料越好 → 越快 + 越多）
const FUEL_DEFS = [
  { id: 8,  name: '木板', units: 1, time: 4.0 },   // 弱燃料：烧得最慢
  { id: 6,  name: '原木', units: 2, time: 3.0 },   // 中等
  { id: 13, name: '煤炭', units: 4, time: 2.0 },   // 好燃料：又快又能多烧几个
];
let furnaceFuel = 13, furnaceJob = null;           // 选中的燃料 / 当前烧制作业
const SMELT_DUR = 3.0;                             // 兜底：燃料没写 time 时才用这个
const jobDur = j => (j && Number.isFinite(j.dur) ? j.dur : SMELT_DUR);
function fuelCount(id) { return countOf(id); }
function fuelReady() { return FUEL_DEFS.find(f => f.id === furnaceFuel && countOf(f.id) > 0) || null; }
function smelt(r) {
  if (!r || !r.n) return false;
  if (furnaceJob) { toast('熔炉正在烧，等它烧完', 1.4); return false; }
  if (countOf(r.in) < 1) { toast(`没有 ${nameOf(r.in)}`, 1.4); return false; }
  const f = fuelReady();
  if (!f) {
    const any = FUEL_DEFS.find(x => countOf(x.id) > 0);
    if (any) { furnaceFuel = any.id; renderFurnace(); toast(`已自动选择燃料：${any.name}`, 1.4); return false; }
    toast('没有燃料（木板 / 原木 / 煤炭）', 1.6); return false;
  }
  takeItem(f.id, 1);
  takeItem(r.in, 1);
  furnaceJob = { r, t: 0, left: f.units, fuel: f.id, fuelName: f.name, dur: f.time };
  toast(`点火：${f.name} → 每个 ${f.time.toFixed(1)} 秒，可烧 ${f.units} 个`, 2.2);
  sfx('place');
  renderHotbar(); renderFurnace(); saveSoon();
  return true;
}
function updateFurnaceJob(dt) {
  const j = furnaceJob;
  if (!j) return;
  j.t += dt;
  if (j.t < jobDur(j)) { if ($('furnace') && !$('furnace').classList.contains('hide')) renderFurnace(); return; }
  j.t = 0;
  addItem(j.r.out, j.r.n);
  toast(`熔炼出 ${nameOf(j.r.out)}（剩 ${j.left - 1} 次）`, 1.3);
  sfx('craft');
  j.left--;
  if (j.left > 0 && countOf(j.r.in) > 0) takeItem(j.r.in, 1);
  else furnaceJob = null;
  renderHotbar(); if ($('furnace') && !$('furnace').classList.contains('hide')) renderFurnace();
  refreshHeld(); saveSoon();
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
  const cur = FUEL_DEFS.find(f => f.id === furnaceFuel) || FUEL_DEFS[0];
  const fi = $('fuelInfo');
  if (fi) {
    fi.innerHTML = '';                    // ⚠ 外层 <p> 已经有「燃料：」字样，这里别再写一遍（会变成「燃料：燃料：」）
    for (const f of FUEL_DEFS) {
      const b = document.createElement('button');
      const have = countOf(f.id);
      b.textContent = `${f.name}(${have}) ${f.time.toFixed(1)}s`;
      b.title = `一块可烧 ${f.units} 个 · 每个 ${f.time.toFixed(1)} 秒`;
      b.style.cssText = `margin:0 4px;padding:3px 7px;border-radius:6px;cursor:pointer;font-size:11px;font-family:inherit;`
        + `border:1px solid ${f.id === cur.id ? '#5a8fd8' : '#33415a'};`
        + `background:${f.id === cur.id ? '#1b2a3d' : '#161d27'};color:${have ? '#cfe0f0' : '#6b7889'}`;
      b.onclick = () => { furnaceFuel = f.id; renderFurnace(); };
      fi.appendChild(b);
    }
  }
  const jobEl = $('fuelInfo');
  if (jobEl && furnaceJob) {
    const dur = jobDur(furnaceJob);
    const pct = Math.round(Math.min(1, furnaceJob.t / dur) * 100);
    const p = document.createElement('div');
    p.style.cssText = 'margin-top:6px;font-size:11px;color:#ffd84a';
    p.textContent = `正在烧制 ${nameOf(furnaceJob.r.out)} … ${pct}%`
      + `（${Math.max(0, dur - furnaceJob.t).toFixed(1)}s · 燃料 ${furnaceJob.fuelName} ${dur.toFixed(1)}s/个 · 剩 ${furnaceJob.left} 次）`;
    jobEl.appendChild(p);
  }
  list.innerHTML = '';
  for (const r of SMELT) {
    if (!r.n) continue;
    const have = countOf(r.in);
    const can = have > 0 && !!fuelReady();
    const d = document.createElement('div');
    d.className = 'rec' + (can ? '' : ' no');
    d.innerHTML = `<img src="${iconURL(r.out)}" alt=""><div class="t">${nameOf(r.out)} ×${r.n}`
      + `<i>${nameOf(r.in)} ×1 + ${cur.name} ×1（${cur.time.toFixed(1)}s/个 · 已有原料 ${have}）</i></div>`
      + `<div class="go">${can ? '熔炼 →' : have ? '缺燃料' : '缺原料'}</div>`;
    d.onclick = () => { if (can && !furnaceJob) smelt(r); };
    list.appendChild(d);
  }
}
function openFurnace() {
  if (panelOpen) openPanel(false);
  if (openChestPos) closeChest();
  if (chargerOpen) closeCharger();
  furnaceOpen = true;
  renderFurnace(); $('furnace').classList.remove('hide');
  syncPointerLock();                                                // 放开光标，熔炉列表才点得动
}
function closeFurnace() {
  furnaceOpen = false;
  $('furnace').classList.add('hide');
  syncPointerLock();
}
/* ── 充电器：放进一把能量炮 + 1 个铀 → 5 秒充满。
   电量存在背包格子上的 c（和工具耐久 d 同族），所以每把炮的电量独立。
   作业挂全局（和熔炉一样），面板关掉也继续充；炮被挪走就中断并退回铀。 */
let chargerOpen = false, chargerJob = null;
const GUN_IDS = [188, 189, 190, 191];
const CHARGE_DUR = 5.0;
const gunCap = id => (ITEMS[id] && ITEMS[id].cap) || 8;
const gunCharge = s => (s && s.c === undefined ? gunCap(s.id) : Math.max(0, s.c | 0));
function chargerTargets() {
  const out = [];
  for (let i = 0; i < SLOTS; i++) { const s = inv[i]; if (s && GUN_IDS.includes(s.id)) out.push({ i, s }); }
  return out;
}
function startCharge(slot) {
  if (chargerJob) { toast('充电器正在工作，等它充完', 1.4); return false; }
  const s = inv[slot];
  if (!s || !GUN_IDS.includes(s.id)) { toast('背包里没有这把能量炮了', 1.6); return false; }
  const cap = gunCap(s.id);
  if (gunCharge(s) >= cap) { toast(`${nameOf(s.id)} 已经是满电（${cap}/${cap}）`, 1.6); return false; }
  if (countOf(187) < 1) { toast('没有铀：铀矿只在深板岩层，挖到不用烧，直接当充电燃料', 2.6); return false; }
  takeItem(187, 1);
  chargerJob = { slot, id: s.id, t: 0, dur: CHARGE_DUR };
  toast(`装入 1 个铀：正在给 ${nameOf(s.id)} 充能（${gunCharge(s)}/${cap}）`, 2.0);
  sfx('place');
  renderHotbar(); renderCharger(); saveSoon();
  return true;
}
function updateChargerJob(dt) {
  const j = chargerJob;
  if (!j) return;
  const s = inv[j.slot];
  if (!s || s.id !== j.id) {                       // 炮被挪走/换格：中断并退回铀（不做无声吞料）
    chargerJob = null;
    addItem(187, 1);
    toast('充电中断：能量炮被移走了，铀已退回', 2.4);
    if (chargerOpen) renderCharger();
    renderHotbar(); saveSoon();
    return;
  }
  j.t += dt;
  if (j.t < j.dur) { if (chargerOpen) renderCharger(); return; }
  s.c = gunCap(s.id);
  chargerJob = null;
  toast(`充能完成：${nameOf(s.id)} 电量 ${s.c}/${gunCap(s.id)}`, 2.0);
  sfx('craft');
  renderHotbar(); if (chargerOpen) renderCharger(); refreshGunHud(); saveSoon();
}
function renderCharger() {
  const info = $('chgInfo');
  if (!info) return;
  info.innerHTML = `铀 <b style="color:#8dff5a">${countOf(187)}</b> 个`
    + `<div style="color:#8ea3ba;font-size:11px;margin-top:4px">1 个铀 = ${CHARGE_DUR.toFixed(0)} 秒充满 1 把能量炮（铀直接当燃料，不用烧成锭）</div>`;
  const list = $('chgList');
  if (!list) return;
  list.innerHTML = '';
  const tg = chargerTargets();
  if (!tg.length) {
    const d = document.createElement('div');
    d.className = 'rec no';
    d.innerHTML = '<div class="t">背包里没有能量炮<i>电路板 + 电线 + 一种金属（铜 / 铁 / 钻石 / 冥界钢）→ 工作台做炮</i></div>';
    list.appendChild(d);
    return;
  }
  for (const { i, s } of tg) {
    const cap = gunCap(s.id), c = gunCharge(s);
    const full = c >= cap;
    const busy = !!chargerJob;
    const can = !full && !busy && countOf(187) > 0;
    const d = document.createElement('div');
    d.className = 'rec' + (can ? '' : ' no');
    const busyHere = chargerJob && chargerJob.slot === i;
    const prog = busyHere ? ` · 充能中 ${Math.round(Math.min(1, chargerJob.t / chargerJob.dur) * 100)}%` : '';
    d.innerHTML = `<img src="${iconURL(s.id)}" alt=""><div class="t">${nameOf(s.id)}`
      + `<i>电量 ${c}/${cap}${full ? '（满）' : ''}${prog} · 背包第 ${i + 1} 格</i></div>`
      + `<div class="go">${full ? '已满' : can ? '用铀充电 →' : (!countOf(187) ? '缺铀' : busy ? '等待中' : '充电')}</div>`;
    d.onclick = () => { if (can) startCharge(i); };
    list.appendChild(d);
  }
}
function openCharger() {
  if (panelOpen) openPanel(false);
  if (openChestPos) closeChest();
  if (furnaceOpen) closeFurnace();
  if (processorOpen) closeProcessor();
  if (pressOpen) closePress();
  chargerOpen = true;
  renderCharger();
  $('charger').classList.remove('hide');
  syncPointerLock();
}
function closeCharger() {
  chargerOpen = false;
  $('charger').classList.add('hide');
  syncPointerLock();
}
function openPanel(open) {
  if (!open && cursor) dropCursorToWorld();          // 关背包时手上还有东西 → 丢到地上，别卡在虚空光标里
  if (open && openChestPos) closeChest();
  if (open && furnaceOpen) closeFurnace();
  if (open && chargerOpen) closeCharger();
  if (open && processorOpen) closeProcessor();
  if (open && pressOpen) closePress();
  panelOpen = open;
  hud.panel.classList.toggle('hide', !open);
  if (open) renderInventoryPanel();
  syncPointerLock();
}

/* ── 木头加工器：把原木削成木片（木盔甲的材料）。不吃燃料、无耗时 —— 点一次削一次。
   面板和熔炉/箱子同一套规矩：打开就放开鼠标（syncPointerLock），Esc / 关闭键收回。 */
let processorOpen = false;
const CHIPS_PER_LOG = 4;                            // 1 原木 → 4 木片
function chipBatch(n) {
  const have = countOf(6);                          // 原木
  const want = n === Infinity ? have : Math.max(1, n | 0);
  const k = Math.min(want, have);
  if (!k) { toast('没有原木：先在背包里准备原木', 1.6); renderProcessor(); return 0; }
  takeItem(6, k);
  addItem(170, k * CHIPS_PER_LOG);
  sfx('craft');
  renderHotbar(); refreshHeld(); renderProcessor(); saveSoon();
  toast(`削木片：${k} 原木 → ${k * CHIPS_PER_LOG} 片（现有 ${countOf(170)} 片）`, 1.8);
  return k * CHIPS_PER_LOG;
}
function renderProcessor() {
  const el = $('procInfo');
  if (!el) return;
  el.innerHTML = `原木 <b style="color:#f5c451">${countOf(6)}</b> 个 · 木片 <b style="color:#f5c451">${countOf(170)}</b> 片`
    + `<div style="color:#8ea3ba;font-size:11px;margin-top:4px">木盔甲：头盔 6 / 胸甲 10 / 护腿 8 / 靴 4 片（要在工作台旁边合成）</div>`;
  const one = $('procOne'), all = $('procAll');
  if (one) one.disabled = countOf(6) < 1;
  if (all) all.disabled = countOf(6) < 1;
}
function openProcessor() {
  if (panelOpen) openPanel(false);
  if (openChestPos) closeChest();
  if (furnaceOpen) closeFurnace();
  if (chargerOpen) closeCharger();
  processorOpen = true;
  renderProcessor();
  $('processor').classList.remove('hide');
  syncPointerLock();
}
function closeProcessor() {
  processorOpen = false;
  $('processor').classList.add('hide');
  syncPointerLock();
}

/* ── 液压机：冥界碳 ×1 + 铁锭 ×2 → 钢锭 ×1（活塞压一下就出钢，不吃燃料） ── */
let pressOpen = false;
function pressCan() { return Math.min(countOf(177), Math.floor(countOf(106) / 2)); }
function pressBatch(n) {
  const can = pressCan();
  if (!can) { toast('材料不够：需要 冥界碳 ×1 + 铁锭 ×2', 1.8); renderPress(); return 0; }
  const k = Math.min(n === Infinity ? can : Math.max(1, n | 0), can);
  takeItem(177, k); takeItem(106, k * 2); addItem(178, k);
  sfx('craft');
  renderHotbar(); refreshHeld(); renderPress(); saveSoon();
  toast(`液压机压下：${k} 份 → 冥界钢 ×${k}（现有 ${countOf(178)}）`, 1.8);
  return k;
}
function renderPress() {
  const el = $('pressInfo');
  if (!el) return;
  const can = pressCan();
  el.innerHTML = `冥界碳 <b style="color:#f5c451">${countOf(177)}</b> · 铁锭 <b style="color:#f5c451">${countOf(106)}</b> · 冥界钢 <b style="color:#f5c451">${countOf(178)}</b>`
    + `<div style="color:#8ea3ba;font-size:11px;margin-top:4px">可压制 ${can} 次（每次 冥界碳 1 + 铁锭 2 → 冥界钢 1）</div>`;
  const one = $('pressOne'), all = $('pressAll');
  if (one) one.disabled = can < 1;
  if (all) all.disabled = can < 1;
}
function openPress() {
  if (panelOpen) openPanel(false);
  if (openChestPos) closeChest();
  if (furnaceOpen) closeFurnace();
  if (processorOpen) closeProcessor();
  if (chargerOpen) closeCharger();
  pressOpen = true;
  renderPress();
  $('press').classList.remove('hide');
  syncPointerLock();
}
function closePress() {
  pressOpen = false;
  $('press').classList.add('hide');
  syncPointerLock();
}

/* ── 传送门：核心插「传送块」→ 点亮 → 再点/走进去 = 穿越维度 ───────────────── */
function findPortalCore(x, y, z) {
  for (let dy = 0; dy <= 4; dy++) if (getBlock(x, y + dy, z) === 45) return { x, y: y + dy, z };
  for (let dy = 1; dy <= 4; dy++) if (getBlock(x, y - dy, z) === 45) return { x, y: y - dy, z };
  return null;
}
function portalCells(core) {                       // 核心上方 3×3 = 传送门面
  const out = [];
  for (let dx = -1; dx <= 1; dx++) for (let dy = 1; dy <= 3; dy++) out.push({ x: core.x + dx, y: core.y + dy, z: core.z });
  return out;
}
function isPortalActive(core) {
  return portalCells(core).some(c => getBlock(c.x, c.y, c.z) === 42);
}
function openPortalAt(core) {
  let n = 0;
  for (const c of portalCells(core)) { setBlock(c.x, c.y, c.z, 42); n++; }
  sfx('craft');
  return n;
}
function usePortal(x, y, z) {
  const core = findPortalCore(x, y, z);
  if (!core) { toast('这里不是传送门（只有核心能插传送块）', 1.8); return false; }
  if (!isPortalActive(core)) {
    const h = held();
    if (!h || h.id !== 175) { toast('手里要拿着「传送块」，对着传送门核心右键', 2.4); return false; }
    if (!isCreative()) takeItem(175, 1);
    const n = openPortalAt(core);
    toast(`传送块嵌进核心，${n} 格裂隙亮了起来 —— 再点一次或直接走进去`, 3.0);
    renderHotbar(); refreshHeld(); saveSoon();
    return true;
  }
  return travelDimension(core);
}
function disposeAllChunks() {                      // 换维度：所有区块网格拆掉重来
  for (const c of chunks.values()) {
    if (c.mesh) { scene.remove(c.mesh); c.mesh.geometry.dispose(); }
    if (c.glass) { scene.remove(c.glass); c.glass.geometry.dispose(); }
    if (c.water) { scene.remove(c.water); c.water.geometry.dispose(); }
    if (c.plant) { scene.remove(c.plant); c.plant.geometry.dispose(); }
  }
  chunks.clear(); dirty.clear();
  invalidateChunkCache();                          // 缓存里那个区块对象已经没了
  for (const m of mobs) if (m.obj) scene.remove(m.obj);
  mobs.length = 0;
  // 另一维度的掉落物/箭留在场上没人会捡，但每帧还在跑物理 → 换维度时一起清掉（存档里的不受影响）
  for (const d of drops) if (d.obj) scene.remove(d.obj);
  drops.length = 0;
  for (const a of arrows) if (a.obj) scene.remove(a.obj);
  arrows.length = 0;
}
function buildAround(x, z, r = 2) {
  const cx = Math.floor(x / CFG.CH), cz = Math.floor(z / CFG.CH);
  for (let dx = -r; dx <= r; dx++) for (let dz = -r; dz <= r; dz++) buildChunk(getChunk(cx + dx, cz + dz));
}
function travelDimension(fromCore) {
  if (!started || !player.alive) return false;
  if (DIM === 'nether') {                          // ← 回主世界
    DIM = 'overworld';
    disposeAllChunks();
    const fp = player.fromPortal;
    const o = player.overPos || (fp ? { x: fp.x + 0.5, y: fp.y + 1.2, z: fp.z - 2.5 } : { x: 8.5, y: SURF_OFF + 40, z: 8.5 });
    let px2 = o.x, pz2 = o.z;
    for (let i = 0; i < 5 && getBlock(Math.floor(px2), Math.floor(o.y), Math.floor(pz2)) === 42; i++) pz2 += 1;   // 别站回门里
    player.p.set(px2, o.y + 0.1, pz2);
    player.v.set(0, 0, 0); player.fallFrom = null;
    buildAround(px2, pz2, 1);            // 只同步建 3×3，剩下的交给 streamChunks（否则一次冻 0.5~1 秒）
    updateSky();
    toast('你回到了主世界', 2.2);
  } else {                                         // ← 去冥界
    player.overPos = { x: player.p.x, y: player.p.y, z: player.p.z };
    // 记下出发的那座门：冥界里任何一座门走进去都送回这里（用户要求「带你回到你过来的门」）
    if (fromCore) player.fromPortal = { x: fromCore.x, y: fromCore.y, z: fromCore.z };
    DIM = 'nether';
    disposeAllChunks();
    player.p.set(NETHER_OFF + 8.5, 34.05, NETHER_OFF + 11.5);
    player.v.set(0, 0, 0); player.fallFrom = null;
    buildAround(player.p.x, player.p.z, 1);
    updateSky();
    toast('进入冥界：脚下是岩浆，小心火焰魔', 2.8);
  }
  portalCd = 2.0;
  renderHotbar(); refreshHeld(); saveSoon();
  return true;
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
/* ── 有自己界面的方块（熔炉 / 箱子 / 背包）打开时，鼠标必须像在背包里一样自由 ──
   指针锁会把光标钉住，面板就点不动。所以统一走这里：
   ① 任何界面打开 → exitPointerLock（光标出现，可以随便移）
   ② 界面全部关掉 → 重新锁定回第一人称视角
   判据只放在这一个函数里，新加界面只要调 syncPointerLock() 就自动生效。 */
let furnaceOpen = false;
function uiOpen() {
  return panelOpen || !!openChestPos || furnaceOpen || chargerOpen || processorOpen || pressOpen || MM_BIG.open || !$('furnace').classList.contains('hide');
}
function syncPointerLock() {
  if (!started) return;
  if (uiOpen()) {
    if (document.pointerLockElement) document.exitPointerLock();
    dragLook = false; mineHeld = false; placeHeld = false;
  } else lockPointer();
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
  if (started && !uiOpen() && player.alive) {
    if (k === keymap.mine) { mineHeld = true; attackQueued = true; }
    if (k === keymap.place) placeQueued = true;
    if (k === 'KeyV') setStructCorner('a');                       // 创作者：选角点1
    if (k === 'KeyB') setStructCorner('b');                       // 创作者：选角点2
    if (k === 'KeyP') uploadStructure();                          // 创作者：导出并上传
    if (k === 'KeyL') listStructures();                           // 创作者：服务器结构列表
  }
  if (k === 'Space') {
    jumpQueued = true; e.preventDefault();
    // ⚠ 必须过滤系统按键重复（e.repeat）：按住空格时浏览器每 ~30ms 再发一次 keydown，
    // 这些重复会不断落进「320ms 内按了两次」的窗口 ⇒ 飞行被反复开关（用户看到的就是
    // 「刚起飞就一直被取消」）。只认真正的第二次按下。
    if (!e.repeat && isCreative() && started) {        // 创造模式连按两次空格 = 飞行开关
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
  if (k === 'KeyM' && started) { mmToggleBig(); e.preventDefault(); }    // 全屏地图（小地图缩放走 +/− 按钮）
  if (k.startsWith('Digit')) {
    const n = +k.slice(5);
    if (n >= 1 && n <= 9) { player.sel = n - 1; refreshHeld(); renderHotbar(); }
  }
  if (k === 'Escape') {
    if (MM_BIG.open) { mmCloseBig(); e.preventDefault(); return; }
    if (!$('settings').classList.contains('hide')) { openSettings(false); e.preventDefault(); return; }
    if (openChestPos) { closeChest(); e.preventDefault(); return; }
    if (!$('furnace').classList.contains('hide')) { closeFurnace(); e.preventDefault(); return; }
    if (chargerOpen) { closeCharger(); e.preventDefault(); return; }
    if (processorOpen) { closeProcessor(); e.preventDefault(); return; }
    if (pressOpen) { closePress(); e.preventDefault(); return; }
    if (panelOpen) { openPanel(false); e.preventDefault(); return; }
  }
});
addEventListener('keyup', e => keys.delete(e.code));
addEventListener('wheel', e => {
  if (!started || uiOpen()) return;
  player.sel = (player.sel + (e.deltaY > 0 ? 1 : -1) + 9) % 9;
  refreshHeld(); renderHotbar();
}, { passive: true });

renderer.domElement.addEventListener('mousedown', e => {
  if (!started || uiOpen() || !player.alive) return;
  if (document.pointerLockElement !== renderer.domElement) {
    if (userCfg.touchUI && e.button === 0) { dragLook = true; return; }   // 无指针锁：鼠标拖拽转视角
    lockPointer(); return;
  }
  if (e.button === 0) { mineHeld = true; attackQueued = true; if (heldKind() === 'sword') startSwing('attack', 0.5); }
  if (e.button === 2) { placeQueued = true; placeHeld = true; }
});
addEventListener('keyup', e => { if (e.code === keymap.mine) mineHeld = false; });
addEventListener('mouseup', e => { if (e.button === 0) { mineHeld = false; dragLook = false; } if (e.button === 2) placeHeld = false; });
addEventListener('contextmenu', e => e.preventDefault());
let dragLook = false;
addEventListener('mousemove', e => {
  if (!started || uiOpen()) return;
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
bindHold($('tMine'), () => { if (!uiOpen() && player.alive) { mineHeld = true; attackQueued = true; } }, () => { mineHeld = false; });
bindHold($('tPlace'), () => { if (!uiOpen() && player.alive) placeQueued = true; });
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
  if (def.unbreakable) { player.mining = 0; toast(`${def.name}纹丝不动（无法破坏）`, 1.4); return; }
  if (def.door) {                                      // 门是两格：拆一格带走另一格
    const oy = (getMeta(t.x, t.y, t.z) & 8) ? t.y - 1 : t.y + 1;
    if (getBlock(t.x, oy, t.z) === 35) setBlock(t.x, oy, t.z, 0);
  }
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
    if (slots) for (const s of slots) if (s) spawnDrop(s.id, s.n, t.x + 0.5, t.y + 0.7, t.z + 0.5, { c: s.c });
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
    const ironPick = inv.some(s => s && (s.id === 120 || s.id === 130 || s.id === 184));
    const stonePick = inv.some(s => s && (s.id === 101 || s.id === 120 || s.id === 130 || s.id === 163 || s.id === 184));
    if (def.ironPick && !ironPick) toast(`${def.name}要用铁镐或更好才能挖`, 2.0);
    else if (def.stonePick && !stonePick) toast('铁矿需要石镐或更好才能采集', 1.8);
    else if (def.pick && heldKind() !== 'pick') toast('石头需要镐才能采集', 1.8);
    else dropAt(def.drop, 1);
  }
  renderHotbar(); refreshHeld(); saveSoon();
}
// 开/关门：上下两格一起翻 bit2（open）。返回是否真的操作了一扇门。
function toggleDoor(x, y, z) {
  let by = y;
  if (getMeta(x, y, z) & 8) by = y - 1;                        // 点的是上半格 → 找下格
  const bm = getMeta(x, by, z);
  if (!(getBlock(x, by, z) === 35)) return false;
  const dirBits = bm & 3, openNow = bm & 4;
  const ny = by + 1, hasTop = getBlock(x, ny, z) === 35;
  setBlock(x, by, z, 35); setMeta(x, by, z, dirBits | (openNow ? 0 : 4));
  if (hasTop) { setBlock(x, ny, z, 35); setMeta(x, ny, z, dirBits | (openNow ? 0 : 4) | 8); }
  const o = doorObjs.get(x + ',' + by + ',' + z);            // 立刻开始缓动旋转
  if (o) o.targetP = openNow ? 0 : 1;
  doorSyncT = 0.6;
  sfx(openNow ? 'dig' : 'place');
  toast(openNow ? '门关上了' : '门打开了', 1.0);
  return true;
}
function placeBlock() {
  const vm = mobAtCrosshair();                                   // 对着村民右键 = 招募 / 给道具 / 指挥
  if (vm && vm.recruit) return recruitInteract(vm);
  const h0 = held();
  if (h0 && ITEMS[h0.id] && ITEMS[h0.id].kind === 'food') return false;   // 食物走长按吃，不放置
  const t0 = raycastVoxel(eyePos(), cameraDir(), CFG.REACH);
  if (t0 && BLOCKS[t0.id] && BLOCKS[t0.id].door) return toggleDoor(t0.x, t0.y, t0.z);
  if (t0 && BLOCKS[t0.id] && BLOCKS[t0.id].torch) { unregisterTorch(t0.x, t0.y, t0.z); }   // 对着门按右键 = 开/关
  const h = held();
  if (!h || !BLOCKS[h.id]) { toast('手里没有可放置的方块', 1.4); return false; }
  const t = t0;
  if (!t) return false;
  const x = t.x + t.nx, y = t.y + t.ny, z = t.z + t.nz;
  if (y < 0 || y >= CFG.WH) return false;
  const cur = getBlock(x, y, z);
  if (cur !== 0 && cur !== 5) return false;
  if (blockBoxBlocks(x, y, z)) { toast('这里放不下（会卡住自己）', 1.4); return false; }
  if (h.id === 35) {                                   // 门：上下两格，朝向玩家
    const yy = y + 1;
    if (yy >= CFG.WH) return false;
    const up = getBlock(x, yy, z);
    if (up !== 0 && up !== 5) { toast('门要两格高（上面被挡住了）', 1.9); return false; }
    if (y === 0 || !isSolid(getBlock(x, y - 1, z))) { toast('门下面要有地面', 1.6); return false; }
    if (blockBoxBlocks(x, yy, z)) { toast('这里放不下（会卡住自己）', 1.4); return false; }
    const d = cameraDir();
    const dir = Math.abs(d.x) >= Math.abs(d.z) ? (d.x > 0 ? 4 : 3) : (d.z > 0 ? 2 : 1);
    setBlock(x, y, z, 35); setMeta(x, y, z, dir - 1);                       // 下半（关）
    setBlock(x, yy, z, 35); setMeta(x, yy, z, (dir - 1) | 8);               // 上半
    if (!isCreative()) takeItem(35, 1);
    sfx('place'); startSwing('place', 0.26);
    renderHotbar(); refreshHeld(); saveSoon();
    return true;
  }
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
function useBoneMeal(t) {                      // 骨粉：催熟小麦 / 撒在草地上长出草丛和花
  const h = held();
  if (!h || h.id !== 161) return false;
  if (!t) return false;
  const id = getBlock(t.x, t.y, t.z);
  if (id === 23 || id === 24) {                    // 对着小麦幼苗/苗 → 直接成熟
    setBlock(t.x, t.y, t.z, 17);
    takeItem(161, 1);
    sfx('craft'); toast('骨粉催熟了小麦', 1.3);
    renderHotbar(); refreshHeld(); saveSoon();
    return true;
  }
  if (id === 17) { toast('这株小麦已经熟了', 1.2); return false; }
  const x = t.x + t.nx, y = t.y + t.ny, z = t.z + t.nz;
  if (getBlock(x, y, z) === 0 && getBlock(x, y - 1, z) === 1) {   // 草地上撒粉 → 草丛/花
    let n = 0;
    for (let dx = -2; dx <= 2; dx++) for (let dz = -2; dz <= 2; dz++) {
      const bx = x + dx, bz = z + dz;
      if (getBlock(bx, y, bz) !== 0 || getBlock(bx, y - 1, bz) !== 1) continue;
      if (Math.random() < 0.6) { setBlock(bx, y, bz, Math.random() < 0.22 ? 37 : 36); n++; }
    }
    if (!n) { toast('这里催不出草（要对着草地）', 1.4); return false; }
    takeItem(161, 1);
    sfx('craft'); toast(`骨粉撒出一片草丛（${n} 处）`, 1.6);
    renderHotbar(); refreshHeld(); saveSoon();
    return true;
  }
  toast('骨粉只能催小麦、或撒在草地上', 1.5);
  return false;
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
    addItem(161, 1);                                  // 骨粉只能从堆肥箱出
    toast('堆肥完成 → 肥料 ×1 + 骨粉 ×1', 2.2);
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
/* ── 能量炮：右键发射，每发消耗 1 格电量；打空就必须去充电器用铀充能 ── */
let gunHudEl = null, lastGunHud = '';
function refreshGunHud() {
  if (!gunHudEl) {
    gunHudEl = document.createElement('div');
    gunHudEl.id = 'gunHud';
    gunHudEl.style.cssText = 'position:fixed;left:50%;bottom:calc(66px + env(safe-area-inset-bottom));'
      + 'transform:translateX(-50%);z-index:31;display:none;font-size:11px;color:#dff8ff;'
      + 'background:rgba(6,16,26,.62);border:1px solid #2b4a5c;border-radius:4px;padding:3px 9px;white-space:nowrap';
    document.body.appendChild(gunHudEl);
  }
  const h = held();
  const def = h && ITEMS[h.id];
  if (!def || def.kind !== 'gun') { gunHudEl.style.display = 'none'; lastGunHud = ''; return; }
  const cap = gunCap(h.id), c = gunCharge(h);
  const txt = `${def.name} · 电量 ${c}/${cap}` + (c <= 0 ? ' · 没电了：放进充电器 + 铀' : '');
  if (txt !== lastGunHud) { gunHudEl.textContent = txt; lastGunHud = txt; }
  gunHudEl.style.display = 'block';
  gunHudEl.style.color = c <= 0 ? '#ff9a8a' : c <= cap * 0.25 ? '#ffd84a' : '#dff8ff';
}
function fireEnergyBolt() {
  if (player.gunCd > 0) return false;
  const h = held();
  const def = h && ITEMS[h.id];
  if (!def || def.kind !== 'gun') return false;
  const cap = gunCap(h.id);
  const c = gunCharge(h);
  if (c <= 0) { toast('能量耗尽：把炮放进充电器，加 1 个铀就能充满', 2.4); sfx('hurt'); return false; }
  if (!isCreative()) h.c = c - 1;
  const eye = eyePos(), dir = cameraDir();
  const from = new THREE.Vector3(eye.x + dir.x * 0.55, eye.y - 0.08 + dir.y * 0.55, eye.z + dir.z * 0.55);
  const to = from.clone().addScaledVector(dir, 14);
  spawnBolt(from, to, { dmg: def.dmg || 8, speed: def.speed || 52, color: def.boltColor || 0xffb066 });
  startSwing('attack', 0.24);
  sfx('place');
  player.gunCd = def.cd || 0.45;
  renderHotbar(); refreshGunHud(); saveSoon();
  if (gunCharge(h) === 0) toast('电量耗尽：放进充电器用铀充能', 2.2);
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
/* ── 吃东西：必须长按（右键 / G），三口吃完；每口有咀嚼动画和进度条（Action & Stuff 手感） ── */
const EAT_BITES = [0.45, 0.95, 1.45], EAT_DUR = 1.85;
const eatState = { on: false, t: 0, bites: 0, id: 0 };
let placeHeld = false;
let eatBarEl = null, eatFillEl = null;
function eatHud(show, pct) {
  if (!eatBarEl) {
    eatBarEl = document.createElement('div');
    eatBarEl.id = 'eatBar';
    eatBarEl.style.cssText = 'position:fixed;left:50%;bottom:108px;transform:translateX(-50%);width:190px;height:12px;'
      + 'border-radius:7px;background:rgba(0,0,0,.55);border:1px solid rgba(255,255,255,.25);overflow:hidden;display:none;z-index:32';
    eatFillEl = document.createElement('div');
    eatFillEl.style.cssText = 'height:100%;width:0%;background:linear-gradient(90deg,#9be36a,#4caf50)';
    eatBarEl.appendChild(eatFillEl);
    document.body.appendChild(eatBarEl);
  }
  eatBarEl.style.display = show ? 'block' : 'none';
  if (show) eatFillEl.style.width = Math.round(clamp01(pct) * 100) + '%';
}
function eatStop(commit) {
  if (!eatState.on) { eatHud(false, 0); return; }
  const h = held();
  eatState.on = false;
  eatHud(false, 0);
  if (!commit || !h || !ITEMS[h.id] || ITEMS[h.id].kind !== 'food') return;
  const food = ITEMS[h.id].food || 4;
  player.hunger = Math.min(20, player.hunger + food);
  takeItem(h.id, 1);
  toast(`吃掉 ${nameOf(h.id)}（饱食 +${food}）`, 1.3);
  sfx('eat');
  renderHotbar(); refreshHeld(); saveSoon();
}
function updateEat(dt) {
  const h = held();
  const isFood = !!(h && ITEMS[h.id] && ITEMS[h.id].kind === 'food');
  const canEat = started && player.alive && !uiOpen() && isFood && player.hunger < 20;
  const holding = !!(keys.has(keymap.place) || placeHeld);
  if (canEat && holding) {
    if (!eatState.on || eatState.id !== h.id) { eatState.on = true; eatState.t = 0; eatState.bites = 0; eatState.id = h.id; }
    eatState.t += dt;
    while (eatState.bites < EAT_BITES.length && eatState.t >= EAT_BITES[eatState.bites]) {
      eatState.bites++;
      anim.biteK = 1;                                  // 这一口的咀嚼冲击（updateHandPose 里衰减）
      sfx('dig');
    }
    eatHud(true, eatState.t / EAT_DUR);
    if (eatState.t >= EAT_DUR) eatStop(true);
  } else if (eatState.on) {
    eatStop(false);                                    // 松开 = 取消，不消耗物品
  }
  if (isFood && player.hunger >= 20 && holding && !eatState.on) {
    // 不饿时给个提示（每秒最多一次）
    if (!updateEat._t || performance.now() - updateEat._t > 1200) { updateEat._t = performance.now(); toast('现在不饿', 1.0); }
  }
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
    if (!sightClear(player.p, m.p)) continue;              // 隔着墙打不到
    const score = 1 / (perp + 0.2) - t * 0.05;
    if (score > bestScore) { bestScore = score; best = m; }
  }
  return best;
}
function attack() {
  if (player.atkCd > 0) return false;
  const target = attackTarget();
  if (!target) {
    // 联机非主机：幽灵怪不在 mobs 里，单独判定后上报给主机扣血
    if (NET && NET.active && !NET.isHost && NET.hitGhost) {
      const k0 = heldKind();
      const d0 = k0 === 'sword' ? ((defOf(held().id) || {}).dmg || 5) : k0 === 'pick' ? 3 : 1;
      if (NET.hitGhost(d0)) {
        startSwing('attack', 0.5); useTool(1); player.atkCd = 0.42; sfx('hit');
        player.hits = (player.hits || 0) + 1;
      }
    }
    return false;
  }
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
let camBaseFov = 0, camLastFov = 0, camRoll = 0;
const STEP = 1 / 60;
let saveTimer = 0;

// 玩家被从 (sx,sz) 方向打中：扣血 + 水平击退 + 轻微上抛
function hurtPlayerFrom(sx, sz, dmg, power = 5.4) {
  if (!player.alive) return;
  damagePlayer(dmg);
  anim.hurtK = Math.min(1.4, (anim.hurtK || 0) + 0.9);   // 手抽一下 + 镜头抖一下（Action & Stuff 的受击反馈）
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
  if (player.gunCd > 0) player.gunCd = Math.max(0, player.gunCd - dt);
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
  const speed = (sprint ? CFG.SPRINT : CFG.WALK) * (player.inWater ? 0.62 : player.inLava ? 0.4 : 1) * (player.tangle > 0 ? 0.32 : 1);
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
  player.inLava = feetBlock === 44;                 // 岩浆是液体：会沉下去，要游出来
  if (player.fly) {                              // 创造模式飞行：空格上升、Shift 下降
    const up = (keyDown('jump') || keys.has('KeyZ') || performance.now() - jumpTouchT < 120) ? 1 : 0;
    const down = (keys.has('ShiftLeft') || keys.has('ShiftRight')) ? 1 : 0;
    player.v.y = (up - down) * 7.2;
    jumpQueued = false;
    player.fallFrom = null;
  } else if (player.inWater || player.inLava) {
    const buoy = player.inLava ? 0.12 : 0.28;       // 岩浆更稠：沉得慢，游得动
    player.v.y = Math.max(player.v.y - CFG.GRAV * buoy * dt, player.inLava ? -1.2 : -3.2);
    if (jumpQueued) player.v.y = player.inLava ? 3.0 : 3.4;
  } else {
    player.v.y = Math.max(player.v.y - CFG.GRAV * dt, -56);
    if (jumpQueued && player.onGround) { player.v.y = CFG.JUMP; player.onGround = false; }
  }
  jumpQueued = false;

  // ── 岩浆（液体）：泡在里面持续灼烧，并点燃玩家
  if (player.inLava) {
    lavaT -= dt;
    if (lavaT <= 0) { lavaT = 0.8; damagePlayer(3); toast('岩浆灼烧！快按空格游出来', 1.2); }
    player.burn = Math.max(player.burn || 0, 5);
    setBurnFx(true);
  } else if (lavaT < 0.15) lavaT = 0.15;
  // ── 着火：每秒 1 点，跳进水里立刻熄
  if (player.burn > 0) {
    player.burn -= dt;
    if (player.inWater) {
      player.burn = 0; setBurnFx(false); toast('滋——火灭了', 1.2);
    } else {
      burnT -= dt;
      if (burnT <= 0) { burnT = 1.0; damagePlayer(1); }
      if (player.burn <= 0) setBurnFx(false);
    }
  }
  if (!NET || !NET.active || NET.isHost) updateLava(dt);   // 岩浆同理：只有主机跑
  // 走进点亮的传送门 = 穿越（2 秒冷却，避免来回抖）
  portalCd -= dt;
  if (portalCd <= 0) {
    if (getBlock(Math.floor(player.p.x), Math.floor(player.p.y + 0.8), Math.floor(player.p.z)) === 42) {
      portalCd = 2.0;
      const c2 = findPortalCore(Math.floor(player.p.x), Math.floor(player.p.y), Math.floor(player.p.z));
      travelDimension(c2);
    }
  }

  // 摔落伤害
  if (!player.onGround && !player.inWater && !player.inLava) { if (player.fallFrom === null) player.fallFrom = player.p.y; }
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
  if (player.inWater || player.inLava) player.fallFrom = null;

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
  updateEat(dt);
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
  if (!NET || !NET.active || NET.isHost) updateMobs(dt);   // P0：怪物由主机模拟，暂不广播
  // 掉落物：主机/单机模拟；客人只画幽灵、捡的时候上报给主机删掉
  // （以前两端各跑一份，于是「别人捡走的东西，你这边还躺在地上」，还能再捡一次）
  if (!NET || !NET.active || NET.isHost) updateDrops(dt); else NET.updateDropGhosts(dt);
  // 水：每帧跑一点（限流），并每隔半秒把玩家附近的水"唤醒"一次（让瀑布/积水开始流动）
  if (!NET || !NET.active || NET.isHost) updateWater(48);   // 液体只在主机/单机里模拟
  updateFlames(dt);
  if (NET && NET.active) NET.tick(dt);            // 位置上传 / 远端插值 / HUD
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
    else if (t && t.id === 40) { openProcessor(); startSwing('place', 0.2); }     // 木头加工器
    else if (t && t.id === 47) { openPress(); startSwing('place', 0.2); }          // 液压机
    else if (t && t.id === 53) { openCharger(); startSwing('place', 0.2); }        // 充电器
    else if (t && (t.id === 45 || t.id === 42)) { usePortal(t.x, t.y, t.z); startSwing('place', 0.2); }   // 传送门
    else if (t && t.id === 10) { openPanel(true); startSwing('place', 0.2); }
    else if (t && BLOCKS[t.id] && BLOCKS[t.id].bed) { setSpawnAt(t.x, t.y, t.z); startSwing('place', 0.26); }
    else if (h && h.id === 153) firePlayerArrow();
    else if (h && ITEMS[h.id] && ITEMS[h.id].kind === 'gun') fireEnergyBolt();
    else if (h && ITEMS[h.id] && ITEMS[h.id].kind === 'hoe') useHoe(t);
    else if (h && h.id === 156) plantSeed(t);
    else if (h && h.id === 157) useFertilizer(t);
    else if (h && t && BLOCKS[t.id] && BLOCKS[t.id].compost && ITEMS[h.id] && ITEMS[h.id].kind === 'food') useCompost(t);
    else if (h && h.id === 152) useBucket(true, t);
    else if (h && h.id === 151) useBucket(false, t);
    else placeBlock();                                  // 食物不在这里吃：长按（右键/G）由 updateEat 处理
  }

  // 手部姿势在 frame() 里按真实帧时长算（固定步长里算会让动画在高刷屏上发顿）
  player.swing = 0;

  // 区块流式加载
  streamChunks();

  mmTick(dt);                                     // 小地图：揭开 / 标记 / 重绘（固定步长里跑，探针也可复现）

  updateVines(dt);
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
      if (c.plant) { scene.remove(c.plant); c.plant.geometry.dispose(); }
      dirty.delete(c);
      chunks.delete(k);
    }
  }
  const tStart = performance.now();
  const budgetMs = perfBudget;

  // ② 邻居补齐后重建：只往 dirty 里塞（很便宜），真正的重建排到 ④
  //   ⚠ 必须放在建新区块之前：建新区块一旦超预算就跳出，原来放在后面永远轮不到执行
  let fixed = 0;
  for (let r = 1; r <= CFG.LOAD_R + 1 && fixed < 2; r++) {
    for (let dx = -r; dx <= r && fixed < 2; dx++) for (let dz = -r; dz <= r && fixed < 2; dz++) {
      if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
      const c = chunks.get(ckey(pcx + dx, pcz + dz));
      if (!c || !c.ready || !c.stale) continue;
      let ok = true;
      for (let ax = -1; ax <= 1 && ok; ax++) for (let az = -1; az <= 1; az++) {
        if (!ax && !az) continue;
        if (!chunks.has((c.cx + ax) + ',' + (c.cz + az))) { ok = false; break; }
      }
      if (ok) { c.stale = false; dirty.add(c); fixed++; }
    }
  }

  // ③ 建新区块：分片推进（每帧只吃一部分），预算前置
  let built = 0, over = false;
  for (let r = 0; r <= CFG.LOAD_R && !over; r++) {
    for (let dx = -r; dx <= r && !over; dx++) for (let dz = -r; dz <= r; dz++) {
      if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
      if (performance.now() - tStart > budgetMs * 0.6) { over = true; break; }   // ★ 每格先看预算
      const ck = ckey(pcx + dx, pcz + dz), had = chunks.has(ck);
      const c = had ? chunks.get(ck) : getChunk(pcx + dx, pcz + dz);
      // ⚠ 刚生成的区块要立刻看预算：一个 genChunk 就要 ~7ms，
      //   否则「已 ready 就 continue」会让这一帧连生成十几个区块（实测一帧 97ms）
      if (!had && performance.now() - tStart > budgetMs * 0.7) { over = true; break; }
      if (c.ready) continue;
      if (!c.job) startChunkMesh(c);
      stepChunkMesh(c, c.job.y + 12);                 // 一次推进 12 层（≈0.7ms）
      if (c.job && c.job.y >= CFG.WH) { finishChunkMesh(c); built++; }
      if (performance.now() - tStart > budgetMs * 0.8) { over = true; break; }
    }
  }
  // ③b 地形预生成：把外圈（LOAD_R+1）的地形先算好，别等玩家走到跟前才吃 7ms
  if (!over && performance.now() - tStart < budgetMs * 0.75) {
    const r = CFG.LOAD_R + 1;
    for (let dx = -r; dx <= r; dx++) for (let dz = -r; dz <= r; dz++) {
      if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
      if (!chunks.has(ckey(pcx + dx, pcz + dz))) { getChunk(pcx + dx, pcz + dz); dx = r + 1; break; }
    }
  }

  // ④ 重建脏区块：至少给 1 块的机会，否则一边走一边攒脏块越积越多
  let rebuilt = 0;
  for (const c of dirty) {
    if (rebuilt >= 2) break;
    if (rebuilt > 0 && performance.now() - tStart > budgetMs) break;
    const d = Math.max(Math.abs(c.cx - pcx), Math.abs(c.cz - pcz));
    if (d > CFG.LOAD_R + 1) { dirty.delete(c); continue; }
    if (!c.job) startChunkMesh(c);
    stepChunkMesh(c, c.job.y + (rebuilt === 0 ? CFG.WH : 24));   // 第一块整块做完，其余分片
    if (c.job && c.job.y >= CFG.WH) { finishChunkMesh(c); dirty.delete(c); rebuilt++; }
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
    `世界 <b>${escHtml((worldMeta(currentId) || {}).name || '—')}</b>  模式 <b>${isCreative() ? '创造' : '生存'}</b>${player.fly ? '（飞行）' : ''}${DIM === 'nether' ? ' · <b style="color:#e05a5a">冥界</b>' : ''}  手持 <b>${held() ? nameOf(held().id) : '空手'}</b>${heldKind() === 'pick' ? '（镐）' : heldKind() === 'sword' ? '（剑）' : ''}  护甲 <b>${armorPoints()}</b>  重生点 <b>${player.spawn && player.spawn.bed ? '床' : '出生点'}</b>`;
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


/* ============================================================ 小地图 ────────
   ① 探索式：走到哪揭开哪（1 格 = 4×4 方块），只揭**已加载**的区块，绝不为了画图去生成区块
   ② 缩放：4 级视野（60 / 104 / 168 / 264 格），M 键循环，右上角 +/− 按钮（手机用）
   ③ 结构：走到 40 格内 → 永久记进存档，地图上是彩色菱形 + 名字，下面一行常驻显示最近的结构
   ④ 存档：世界存档里带 map:{c:[[gx,gz,type]…], m:[…]}，换设备/重开都在                          */
const MM_CELL = 4, MM_MAX_CELLS = 40000;
const MM_ZOOM = [15, 26, 42, 66];                 // 每个级别「屏幕宽 = 多少格」
const MM_TERRAIN = ['#5d9440', '#c9b174', '#71757c', '#2d5f8f', '#376b2c', '#3c4048', '#8a4a2a',
  '#c8501a',   // 7 岩浆
  '#9a2f38',   // 8 缠魂藤
  '#4a1f22',   // 9 沼泽泥
  '#6b4a35',   // 10 灵魂沙
  '#4a2a5a',   // 11 冥界矿
  '#14202c'];  // 12 空洞
const MM_LABEL = { village: '村庄', haunted: '鬼屋', tower: '哨塔', well: '水井', circle: '石阵', camp: '废墟营地', cabin: '白桦木屋', portal: '传送门', swamp: '熔岩沼泽' };
const MM_MARK_COLOR = { village: '#f5c451', haunted: '#b07ce0', tower: '#7fd6ff', well: '#6fd8c0', circle: '#c9c9d8', camp: '#e08b4a', cabin: '#d8b48a', portal: '#8b3fd8', swamp: '#ff7a3c' };
const MM = {
  cells: new Map(), marks: new Map(), zoom: 1, px2: 2,
  cv: null, ctx: null, info: null, wrap: null,
  revealT: 0, scanT: 0, drawT: 0, dirty: true, hidden: false,
};
function mmOff() { return DIM === 'nether' ? NETHER_OFF : 0; }   // 冥界坐标另算：显示时减掉 100 万
function mmTerrainType(x, z) {
  if (DIM === 'nether') {                                   // 冥界：从顶往下找第一个实心块
    for (let y = 62; y > NETHER_LAVA_Y - 4; y--) {
      const id = getBlock(x, y, z);
      if (!id) continue;
      if (id === 54 || id === 56) return 6;                 // 冥界树
      if (id === 55 || id === 57) return 4;                 // 树冠
      if (id === 58) return 8;                              // 缠魂藤
      if (id === 59) return 9;                              // 沼泽泥
      if (id === 44) return 7;                              // 岩浆
      if (id === 46) return 11;                             // 冥界碳矿
      if (id === 20) return 11;                             // 钻石矿
      if (id === 48) return 10;                             // 灵魂沙
      return 5;                                             // 冥界岩 / 玄武岩 / 基岩
    }
    return 12;
  }
  const hh = heightAt(x, z);
  if (hh < CFG.SEA) return 3;                               // 海平面以下 = 水
  if (getBlock(x, hh + 1, z) === 7) return 4;               // 树冠 → 深绿
  const id = getBlock(x, hh, z);
  if (id === 5) return 3;
  if (id === 4) return 1;
  if (id === 7) return 4;
  if (id === 50) return 5;
  if (id === 43) return 6;
  if (id === 3 || id === 9 || id === 21 || id === 33) return 2;
  if (id === 1 || id === 16 || id === 25) return 0;
  return 0;
}
function mmReveal() {
  const cx = Math.floor(player.p.x / MM_CELL), cz = Math.floor(player.p.z / MM_CELL);
  const R = 8;                                              // 半径 8 格 = 32 方块
  for (let dx = -R; dx <= R; dx++) for (let dz = -R; dz <= R; dz++) {
    if (dx * dx + dz * dz > R * R) continue;
    if (MM.cells.size >= MM_MAX_CELLS) return;
    const gx = cx + dx, gz = cz + dz, k = gx + ',' + gz;
    if (MM.cells.has(k)) continue;
    const wx = gx * MM_CELL + 2, wz = gz * MM_CELL + 2;
    const ch = chunks.get(ckey(Math.floor(wx / CFG.CH), Math.floor(wz / CFG.CH)));
    if (!ch || !ch.ready) continue;                         // 没建好的区块不采样（免得为了地图卡顿）
    MM.cells.set(k, mmTerrainType(wx, wz));
  }
}
function mmScanStructs() {
  const px = player.p.x, pz = player.p.z;
  if (DIM === 'nether') {                                   // 冥界：只标「熔岩沼泽」（别的结构都在主世界）
    const cx = Math.floor(px / LS_CELL), cz = Math.floor(pz / LS_CELL);
    for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
      const s = lavaSwamp(cx + dx, cz + dz);
      if (!s || Math.hypot(s.x - px, s.z - pz) > 58) continue;
      const key = 'swamp:' + s.x + ',' + s.z;
      if (MM.marks.has(key)) continue;
      MM.marks.set(key, { type: 'swamp', label: '熔岩沼泽', x: s.x, z: s.z, gy: NETHER_LAVA_Y });
      MM.dirty = true;
      toast(`小地图标记：熔岩沼泽（${s.x - NETHER_OFF}, ${s.z - NETHER_OFF}）`, 2.6);
    }
    return;
  }
  for (const t of STRUCT_TYPES) {
    const cx = Math.floor(px / t.cell), cz = Math.floor(pz / t.cell);
    for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
      let o = null;
      try { o = t.get(cx + dx, cz + dz); } catch (e) { continue; }
      if (!o || !o.cx) continue;
      if (Math.hypot(o.cx - px, o.cz - pz) > 40) continue;   // 走到 40 格内才记
      const key = t.name + ':' + o.cx + ',' + o.cz;
      if (MM.marks.has(key)) continue;
      const label = MM_LABEL[t.name] || t.name;
      MM.marks.set(key, { type: t.name, label, x: o.cx, z: o.cz, gy: o.gy || 0 });
      MM.dirty = true;
      toast(`小地图标记：${label}（${o.cx}, ${o.cz}）`, 2.4);
    }
  }
}
function mmZoom(d) {
  MM.zoom = Math.max(0, Math.min(MM_ZOOM.length - 1, MM.zoom + d));
  MM.dirty = true;
}
function mmZoomToast() {
  mmZoom(0);
  toast(`小地图：视野 ${MM_ZOOM[MM.zoom] * MM_CELL} 格（${MM.zoom + 1}/${MM_ZOOM.length} 级）`, 1.4);
}
function mmCycleZoom() { MM.zoom = (MM.zoom + 1) % MM_ZOOM.length; mmZoomToast(); }
const MM_DIR8 = ['北', '东北', '东', '东南', '南', '西南', '西', '西北'];
function mmDraw() {
  const ctx = MM.ctx;
  if (!ctx) return;
  const S = MM.cv.width, across = MM_ZOOM[MM.zoom], ppc = S / across, half = across / 2;
  const gx = player.p.x / MM_CELL, gz = player.p.z / MM_CELL;
  ctx.fillStyle = '#141c26'; ctx.fillRect(0, 0, S, S);
  for (const [k, t] of MM.cells) {
    const i = k.indexOf(',');
    const cxx = +k.slice(0, i), czz = +k.slice(i + 1);
    const sx = (cxx - gx + half) * ppc, sz = (czz - gz + half) * ppc;
    if (sx < -ppc || sz < -ppc || sx > S || sz > S) continue;
    ctx.fillStyle = MM_TERRAIN[t] || MM_TERRAIN[0];
    ctx.fillRect(sx | 0, sz | 0, Math.ceil(ppc) + 1, Math.ceil(ppc) + 1);
  }
  // 结构标记：菱形 + 名字（放大到 ppc≥5 才写字，免得糊成一团）
  for (const mk of MM.marks.values()) {
    const sx = (mk.x / MM_CELL - gx + half) * ppc, sz = (mk.z / MM_CELL - gz + half) * ppc;
    if (sx < -8 || sz < -8 || sx > S + 8 || sz > S + 8) continue;
    const r = 3.2 * MM.px2;
    ctx.beginPath(); ctx.moveTo(sx, sz - r); ctx.lineTo(sx + r, sz); ctx.lineTo(sx, sz + r); ctx.lineTo(sx - r, sz); ctx.closePath();
    ctx.fillStyle = MM_MARK_COLOR[mk.type] || '#f5c451'; ctx.fill();
    ctx.strokeStyle = '#0b1017'; ctx.lineWidth = 1.5 * MM.px2; ctx.stroke();
    if (ppc >= 5) {
      ctx.font = `${Math.round(7.5 * MM.px2)}px sans-serif`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'top';
      ctx.fillStyle = '#0b1017'; ctx.fillText(mk.label, sx + 1, sz + r + 1);
      ctx.fillStyle = '#eaf3ff'; ctx.fillText(mk.label, sx, sz + r);
    }
  }
  // 玩家箭头（朝向 = 相机水平朝向）
  const dx = -Math.sin(player.yaw), dz = -Math.cos(player.yaw);
  const ax = S / 2, az = S / 2, L = 4.6 * MM.px2, W = 3.2 * MM.px2;
  ctx.beginPath();
  ctx.moveTo(ax + dx * L, az + dz * L);
  ctx.lineTo(ax - dx * W - dz * W, az - dz * W + dx * W);
  ctx.lineTo(ax - dx * W + dz * W, az - dz * W - dx * W);
  ctx.closePath();
  ctx.fillStyle = '#ffd84a'; ctx.fill();
  ctx.strokeStyle = '#241a05'; ctx.lineWidth = 1.2 * MM.px2; ctx.stroke();
  // 指北 + 边框
  ctx.font = `${Math.round(8 * MM.px2)}px sans-serif`;
  ctx.textAlign = 'center'; ctx.textBaseline = 'top';
  ctx.fillStyle = '#cfe0f2'; ctx.fillText('北', S / 2, 2);
  ctx.strokeStyle = '#33475e'; ctx.lineWidth = 2; ctx.strokeRect(1, 1, S - 2, S - 2);
  // 状态行：最近的结构 / 探索格数
  if (MM.info) {
    let best = null;
    for (const mk of MM.marks.values()) {
      const d = Math.hypot(mk.x - player.p.x, mk.z - player.p.z);
      if (!best || d < best.d) best = { mk, d };
    }
    let line;
    if (DIM === 'nether') {
      const tag = '冥界 · ';
      line = best
        ? `${tag}${best.mk.label} ${Math.round(best.d)}格\n已探索 ${MM.cells.size} 格 · 视野 ${MM_ZOOM[MM.zoom] * MM_CELL} 格`
        : `${tag}未发现沼泽\n已探索 ${MM.cells.size} 格 · 视野 ${MM_ZOOM[MM.zoom] * MM_CELL} 格`;
    }
    else if (!best) line = `未发现结构\n已探索 ${MM.cells.size} 格 · 视野 ${MM_ZOOM[MM.zoom] * MM_CELL} 格`;
    else {
      let ang = Math.atan2(best.mk.x - player.p.x, -(best.mk.z - player.p.z));
      if (ang < 0) ang += Math.PI * 2;
      const dir = MM_DIR8[Math.round(ang / (Math.PI / 4)) % 8];
      line = `${best.mk.label} ${Math.round(best.d)}格 ${dir}\n已探索 ${MM.cells.size} 格 · 视野 ${MM_ZOOM[MM.zoom] * MM_CELL} 格`;
    }
    MM.info.textContent = line;
  }
}
function mmTick(dt) {
  if (!MM.cv) return;
  const on = started;                                       // 冥界也画地图（数据按世界坐标分开存，天然不串）
  if (MM.wrap && MM._on !== on) { MM._on = on; MM.wrap.style.display = on ? 'block' : 'none'; }
  if (!on) return;
  MM.revealT -= dt; MM.scanT -= dt; MM.drawT -= dt;
  if (MM.revealT <= 0) { MM.revealT = 0.35; mmReveal(); MM.dirty = true; }
  if (MM.scanT <= 0) { MM.scanT = 0.8; mmScanStructs(); }
  if (MM.drawT <= 0 || MM.dirty) { MM.drawT = 0.2; MM.dirty = false; mmDraw(); }
}
function mmSerialize() {
  return { c: Array.from(MM.cells.entries()), m: Array.from(MM.marks.values()) };
}
function mmRestore(d) {
  MM.cells.clear(); MM.marks.clear();
  if (d && Array.isArray(d.c)) for (const e of d.c) {
    if (!Array.isArray(e) || MM.cells.size >= MM_MAX_CELLS) continue;
    MM.cells.set(String(e[0]), e[1] | 0);
  }
  if (d && Array.isArray(d.m)) for (const o of d.m) {
    if (!o || !o.type) continue;
    MM.marks.set(o.type + ':' + o.x + ',' + o.z, { type: o.type, label: o.label || MM_LABEL[o.type] || o.type, x: o.x | 0, z: o.z | 0, gy: o.gy | 0 });
  }
  MM.dirty = true;
}
function mmInit() {
  MM.wrap = $('mmWrap');
  MM.cv = $('mm');
  if (!MM.cv) return;
  MM.cv.width = 132 * MM.px2; MM.cv.height = 132 * MM.px2;
  MM.ctx = MM.cv.getContext('2d');
  MM.ctx.imageSmoothingEnabled = false;
  MM.info = $('mmInfo');
  const zin = $('mmIn'), zout = $('mmOut');
  if (zin) zin.onclick = (e) => { e.preventDefault(); e.stopPropagation(); mmZoom(1); mmZoomToast(); };
  if (zout) zout.onclick = (e) => { e.preventDefault(); e.stopPropagation(); mmZoom(-1); mmZoomToast(); };
  // 点小地图 = 开全屏地图（手机上最顺手的入口）
  MM.cv.style.pointerEvents = 'auto'; MM.cv.style.cursor = 'pointer';
  MM.cv.title = '点击打开全屏地图（M）';
  MM.cv.onclick = () => { if (!uiOpen()) mmOpenBig(); };
  MM.dirty = true;
}

/* ── 全屏地图：拖动平移 / 4 级缩放 / 点击放置标记 / 标记列表可改名删除 ──────
   标记存在 MM.marks 里（type:'custom'），跟着世界存档走；结构标记同表但 type 不同。 */
const MM_BIGZOOM = [20, 40, 80, 160];        // 横跨多少格（每格 4 方块 → 80/160/320/640 方块）
const MM_BIG = { open: false, zoom: 1, x: 0, z: 0, drag: null, hover: null };
let mmBigCtx = null;

function mmBigPpc(cv) { return Math.min(cv.width, cv.height) / MM_BIGZOOM[MM_BIG.zoom]; }
function mmBigResize() {
  const cv = $('mapCv');
  if (!cv) return;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = Math.max(200, cv.clientWidth | 0), h = Math.max(160, cv.clientHeight | 0);
  cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr);
  mmBigCtx = cv.getContext('2d');
  mmBigCtx.imageSmoothingEnabled = false;
}
function mmBigScreenToWorld(clientX, clientY) {
  const cv = $('mapCv'), r = cv.getBoundingClientRect();
  const px = (clientX - r.left) * (cv.width / r.width), py = (clientY - r.top) * (cv.height / r.height);
  const ppc = mmBigPpc(cv);
  return {
    x: Math.round(MM_BIG.x + (px - cv.width / 2) / ppc * MM_CELL),
    z: Math.round(MM_BIG.z + (py - cv.height / 2) / ppc * MM_CELL),
  };
}
function mmMarkCount() { return Array.from(MM.marks.values()).filter(m => m.type === 'custom').length; }
function mmAddMark(x, z, label) {
  const key = 'custom:' + x + ',' + z;
  if (MM.marks.has(key)) { toast('这里已经有标记了', 1.2); return false; }
  const label2 = label || ('标记 ' + (mmMarkCount() + 1));
  MM.marks.set(key, { type: 'custom', label: label2, x, z });
  MM.dirty = true;
  mmBigDraw(); renderMarkList();
  toast(`已标记「${label2}」（${x}, ${z}）`, 2.0);
  saveSoon();
  return true;
}
function mmDelMark(key) {
  const m = MM.marks.get(key);
  if (!m) return false;
  MM.marks.delete(key);
  MM.dirty = true; mmBigDraw(); renderMarkList();
  toast(`已删除标记「${m.label}」`, 1.4);
  saveSoon();
  return true;
}
function mmRenameMark(key) {
  const m = MM.marks.get(key);
  if (!m) return false;
  const nm = prompt('标记名称', m.label);
  if (nm === null) return false;
  const t = String(nm).trim().slice(0, 12);
  if (!t) return false;
  m.label = t; MM.dirty = true; mmBigDraw(); renderMarkList(); saveSoon();
  return true;
}
function renderMarkList() {
  const box = $('mapMarks');
  if (!box) return;
  const list = Array.from(MM.marks.entries()).map(([k, m]) => ({ k, ...m, d: Math.hypot(m.x - player.p.x, m.z - player.p.z) }))
    .sort((a, b) => (a.type === 'custom' ? 0 : 1) - (b.type === 'custom' ? 0 : 1) || a.d - b.d);
  if ($('mapMarkCount')) $('mapMarkCount').textContent = `${mmMarkCount()} 个自定义 · ${list.length} 个标记`;
  box.innerHTML = '';
  if (!list.length) {
    box.innerHTML = '<div style="color:#7f93ab;font-size:11px;padding:6px">还没有标记：在地图上点一下就能放一个</div>';
    return;
  }
  for (const m of list) {
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;align-items:center;gap:6px;padding:4px 5px;margin-bottom:3px;border:1px solid #24344a;'
      + 'border-radius:4px;background:#0e1724;font-size:11px;cursor:pointer';
    row.innerHTML = `<span style="width:8px;height:8px;border-radius:2px;background:${m.type === 'custom' ? '#ffd84a' : (MM_MARK_COLOR[m.type] || '#f5c451')}"></span>`
      + `<b style="font-weight:400;color:#dbe8f6;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escHtml(m.label)}</b>`
      + `<span style="color:#8fa6c0">${Math.round(m.d)}格</span>`
      + `<span data-ren="${m.k}" title="改名" style="color:#7fd6ff;padding:0 2px">改</span>`
      + `<span data-del="${m.k}" title="删除" style="color:#e0524b;padding:0 2px">✕</span>`;
    row.onclick = (e) => {
      const del = e.target.closest('[data-del]'), ren = e.target.closest('[data-ren]');
      if (del) { e.stopPropagation(); mmDelMark(del.dataset.del); return; }
      if (ren) { e.stopPropagation(); mmRenameMark(ren.dataset.ren); return; }
      MM_BIG.x = m.x; MM_BIG.z = m.z; mmBigDraw();
    };
    box.appendChild(row);
  }
}
function mmBigDraw() {
  if (!MM_BIG.open) return;
  const cv = $('mapCv');
  if (!cv) return;
  if (!mmBigCtx) mmBigResize();
  const ctx = mmBigCtx, W = cv.width, H = cv.height;
  const off = mmOff();                                      // 冥界：显示坐标减去 100 万
  const ppc = mmBigPpc(cv);
  const gx = MM_BIG.x / MM_CELL, gz = MM_BIG.z / MM_CELL;
  ctx.fillStyle = '#0f1620'; ctx.fillRect(0, 0, W, H);
  // 已探索格
  for (const [k, t] of MM.cells) {
    const i = k.indexOf(',');
    const cxx = +k.slice(0, i), czz = +k.slice(i + 1);
    const sx = W / 2 + (cxx - gx) * ppc, sz = H / 2 + (czz - gz) * ppc;
    if (sx < -ppc || sz < -ppc || sx > W || sz > H) continue;
    ctx.fillStyle = MM_TERRAIN[t] || MM_TERRAIN[0];
    ctx.fillRect(sx | 0, sz | 0, Math.ceil(ppc) + 1, Math.ceil(ppc) + 1);
  }
  // 64 方块的网格 + 坐标
  if (ppc * 16 >= 14) {
    ctx.strokeStyle = 'rgba(255,255,255,.09)'; ctx.lineWidth = 1;
    const step = 16;                                       // 16 格 = 64 方块
    const c0 = Math.floor(gx - (W / 2) / ppc / step) * step, c1 = Math.ceil(gx + (W / 2) / ppc / step) * step;
    const d0 = Math.floor(gz - (H / 2) / ppc / step) * step, d1 = Math.ceil(gz + (H / 2) / ppc / step) * step;
    ctx.font = `${Math.round(9 * (W / cv.clientWidth || 1))}px sans-serif`;
    ctx.fillStyle = 'rgba(200,220,240,.5)'; ctx.textAlign = 'left'; ctx.textBaseline = 'top';
    for (let c = c0; c <= c1; c += step) {
      const sx = W / 2 + (c - gx) * ppc;
      ctx.beginPath(); ctx.moveTo(sx, 0); ctx.lineTo(sx, H); ctx.stroke();
      if ((c / step) % 2 === 0) ctx.fillText(String(c * MM_CELL - off), sx + 2, 2);
    }
    for (let d = d0; d <= d1; d += step) {
      const sz = H / 2 + (d - gz) * ppc;
      ctx.beginPath(); ctx.moveTo(0, sz); ctx.lineTo(W, sz); ctx.stroke();
      if ((d / step) % 2 === 0) ctx.fillText(String(d * MM_CELL - off), 3, sz + 2);
    }
  }
  // 标记（结构 + 自定义）
  for (const m of MM.marks.values()) {
    const sx = W / 2 + (m.x / MM_CELL - gx) * ppc, sz = H / 2 + (m.z / MM_CELL - gz) * ppc;
    if (sx < -20 || sz < -20 || sx > W + 20 || sz > H + 20) continue;
    const R = Math.max(4, Math.min(8, ppc * 0.55));
    ctx.beginPath();
    if (m.type === 'custom') {
      ctx.moveTo(sx, sz - R * 1.6); ctx.lineTo(sx + R, sz - R * 0.4); ctx.lineTo(sx + R * 0.5, sz + R * 1.2);
      ctx.lineTo(sx - R * 0.5, sz + R * 1.2); ctx.lineTo(sx - R, sz - R * 0.4); ctx.closePath();
    } else {
      ctx.moveTo(sx, sz - R); ctx.lineTo(sx + R, sz); ctx.lineTo(sx, sz + R); ctx.lineTo(sx - R, sz); ctx.closePath();
    }
    ctx.fillStyle = m.type === 'custom' ? '#ffd84a' : (MM_MARK_COLOR[m.type] || '#f5c451');
    ctx.fill();
    ctx.strokeStyle = '#0b1017'; ctx.lineWidth = 1.5; ctx.stroke();
    const fs = Math.max(10, Math.min(14, ppc * 0.7)) * (W / (cv.clientWidth || W));
    ctx.font = `${Math.round(fs)}px sans-serif`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    ctx.fillStyle = '#0b1017'; ctx.fillText(m.label, sx + 1, sz + R * 1.4 + 1);
    ctx.fillStyle = '#eaf3ff'; ctx.fillText(m.label, sx, sz + R * 1.4);
  }
  // 出生点
  if (player.spawn) {
    const sx = W / 2 + (player.spawn.x / MM_CELL - gx) * ppc, sz = H / 2 + (player.spawn.z / MM_CELL - gz) * ppc;
    if (sx > -10 && sz > -10 && sx < W + 10 && sz < H + 10) {
      ctx.strokeStyle = '#7fe06b'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(sx - 5, sz); ctx.lineTo(sx + 5, sz); ctx.moveTo(sx, sz - 5); ctx.lineTo(sx, sz + 5); ctx.stroke();
    }
  }
  // 玩家箭头
  {
    const sx = W / 2 + (player.p.x / MM_CELL - gx) * ppc, sz = H / 2 + (player.p.z / MM_CELL - gz) * ppc;
    const dx = -Math.sin(player.yaw), dz = -Math.cos(player.yaw), L = 9, Wd = 6;
    ctx.beginPath();
    ctx.moveTo(sx + dx * L, sz + dz * L);
    ctx.lineTo(sx - dx * Wd - dz * Wd, sz - dz * Wd + dx * Wd);
    ctx.lineTo(sx - dx * Wd + dz * Wd, sz - dz * Wd - dx * Wd);
    ctx.closePath();
    ctx.fillStyle = '#ffd84a'; ctx.fill(); ctx.strokeStyle = '#241a05'; ctx.lineWidth = 1.5; ctx.stroke();
  }
  // 比例尺 + 坐标读数
  const dpr = W / (cv.clientWidth || W);
  const barBlocks = 64, barPx = (barBlocks / MM_CELL) * ppc;
  ctx.fillStyle = 'rgba(10,17,32,.75)'; ctx.fillRect(10, H - 30 * dpr, barPx + 16 * dpr, 22 * dpr);
  ctx.strokeStyle = '#cfe0f2'; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(14 * dpr, H - 16 * dpr); ctx.lineTo(14 * dpr + barPx, H - 16 * dpr); ctx.stroke();
  ctx.font = `${Math.round(10 * dpr)}px sans-serif`; ctx.textAlign = 'left'; ctx.textBaseline = 'bottom';
  ctx.fillStyle = '#cfe0f2'; ctx.fillText(`${barBlocks} 格`, 14 * dpr, H - 18 * dpr);
  ctx.textAlign = 'right';
  const hv = MM_BIG.hover;
  ctx.fillText(hv ? `x ${hv.x - off}  z ${hv.z - off}` : `中心 x ${Math.round(MM_BIG.x) - off}  z ${Math.round(MM_BIG.z) - off}`, W - 10 * dpr, H - 10 * dpr);
  ctx.textAlign = 'left'; ctx.textBaseline = 'top';
  ctx.fillText(`${DIM === 'nether' ? '冥界 · ' : ''}视野 ${MM_BIGZOOM[MM_BIG.zoom] * MM_CELL} 格 · 已探索 ${MM.cells.size} 格`, 10 * dpr, 8 * dpr);
}
function mmBigZoom(d) {
  MM_BIG.zoom = Math.max(0, Math.min(MM_BIGZOOM.length - 1, MM_BIG.zoom + d));
  mmBigDraw();
}
function mmOpenBig(atX, atZ) {
  const wrap = $('mapFull');
  if (!wrap) return;
  MM_BIG.open = true;
  MM_BIG.x = atX === undefined ? player.p.x : atX;
  MM_BIG.z = atZ === undefined ? player.p.z : atZ;
  wrap.classList.remove('hide');
  mmBigResize();
  renderMarkList();
  mmBigDraw();
  syncPointerLock();
}
function mmCloseBig() {
  MM_BIG.open = false;
  const w = $('mapFull');
  if (w) w.classList.add('hide');
  syncPointerLock();
}
function mmToggleBig() { MM_BIG.open ? mmCloseBig() : mmOpenBig(); }
function mmBigInit() {
  const cv = $('mapCv');
  if (!cv) return;
  // 拖动平移 / 点击放标记（位移 <6px 才算点击）
  let drag = null;
  cv.addEventListener('pointerdown', (e) => {
    drag = { x: e.clientX, y: e.clientY, ox: MM_BIG.x, oz: MM_BIG.z, moved: 0 };
    cv.setPointerCapture && cv.setPointerCapture(e.pointerId);
  });
  cv.addEventListener('pointermove', (e) => {
    if (drag) {
      const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      drag.moved = Math.max(drag.moved, Math.abs(dx) + Math.abs(dy));
      const ppc = mmBigPpc(cv), r = cv.getBoundingClientRect();
      const k = cv.width / r.width;
      MM_BIG.x = drag.ox - (dx * k) / ppc * MM_CELL;
      MM_BIG.z = drag.oz - (dy * k) / ppc * MM_CELL;
      MM_BIG.hover = mmBigScreenToWorld(e.clientX, e.clientY);
      mmBigDraw();
    } else {
      MM_BIG.hover = mmBigScreenToWorld(e.clientX, e.clientY);
      mmBigDraw();
    }
  });
  cv.addEventListener('pointerup', (e) => {
    if (drag && drag.moved < 6) {
      const p2 = mmBigScreenToWorld(e.clientX, e.clientY);
      mmAddMark(p2.x, p2.z);
    }
    drag = null;
  });
  cv.addEventListener('pointerleave', () => { MM_BIG.hover = null; if (!drag) mmBigDraw(); });
  cv.addEventListener('wheel', (e) => { e.preventDefault(); mmBigZoom(e.deltaY > 0 ? -1 : 1); }, { passive: false });
  const on = (id, fn) => { const el = $(id); if (el) el.onclick = fn; };
  on('mapZoomIn', () => mmBigZoom(1));
  on('mapZoomOut', () => mmBigZoom(-1));
  on('mapCenter', () => { MM_BIG.x = player.p.x; MM_BIG.z = player.p.z; mmBigDraw(); });
  on('mapAddCenter', () => mmAddMark(Math.round(MM_BIG.x), Math.round(MM_BIG.z)));
  on('mapClose', () => mmCloseBig());
  const wrap = $('mapFull');
  if (wrap) wrap.addEventListener('click', (e) => { if (e.target === wrap) mmCloseBig(); });
  addEventListener('resize', () => { if (MM_BIG.open) { mmBigResize(); mmBigDraw(); } });
}

let saveSoonT = 0, saveErr = null, saveWarned = false;
function save() {
  if (!currentId || !started) return;
  // 联机里：客人不写本地存档（服务端才是权威）；房主的房间就是他自己的世界，照常存
  if (NET && NET.active && !NET.lid) return;
  try {
    const data = {
      seed: SEED, mode: MODE, time: worldTime, dim: DIM, overPos: player.overPos || null,
      player: { x: player.p.x, y: player.p.y, z: player.p.z, yaw: player.yaw, pitch: player.pitch, hp: player.hp, hunger: player.hunger },
      inv, edits: Array.from(edits.entries()), spawn: player.spawn, armor: player.armor, chests: Array.from(chestInv.entries()),
      compost: Array.from(compostProg.entries()), meta: Array.from(blockMeta.entries()),
      squad: squadData(), map: mmSerialize(),          // 小地图探索/结构标记
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
let loadErr = null;
function loadSave(id) {
  try {
    const raw = localStorage.getItem(worldKey(id));
    if (!raw) return false;
    const d = JSON.parse(raw);
    if (!d || !d.seed) return false;
    SEED = d.seed;
    worldTime = d.time || 0;
    inv = new Array(SLOTS).fill(null);
    (d.inv || []).filter(s => s && isItem(s.id) && s.n > 0).forEach((s, i) => { if (i < SLOTS) inv[i] = { id: s.id, n: s.n, d: s.d, c: s.c }; });
    player.spawn = d.spawn || null;
    if (d.armor) for (const s of ARMOR_SLOTS) player.armor[s] = ITEMS[d.armor[s]] ? d.armor[s] : null;
    compostProg.clear();
    if (Array.isArray(d.compost)) for (const e of d.compost) if (Array.isArray(e)) compostProg.set(e[0], e[1] | 0);
    if (Array.isArray(d.chests)) for (const entry of d.chests) {
      if (!Array.isArray(entry) || !Array.isArray(entry[1])) continue;   // 兼容旧存档
      chestInv.set(entry[0], entry[1].map(s => (s && isItem(s.id) && s.n > 0) ? { id: s.id, n: s.n, c: s.c } : null));
    }
    for (const [k, v] of (d.edits || [])) edits.set(k, v);
    reindexEdits();
    for (const m0 of mobs.slice()) { m0.dying = true; m0.dieT = MOB_DEATH_HOLD + 1; }
    restoreSquad(d.squad);
    blockMeta.clear();
    if (Array.isArray(d.meta)) for (const e of d.meta) if (Array.isArray(e)) blockMeta.set(e[0], e[1]);
    mmRestore(d.map);
    DIM = d.dim === 'nether' ? 'nether' : 'overworld';     // 存档在哪一层，回来就还在哪一层
    player.overPos = d.overPos || null;
    if (d.player) {
      player.p.set(d.player.x, d.player.y, d.player.z);
      player.yaw = d.player.yaw || 0; player.pitch = d.player.pitch || 0;
      player.hp = d.player.hp ?? 20; player.hunger = d.player.hunger ?? 20;
    }
    loadErr = null;
    return true;
  } catch (e) { loadErr = String((e && e.stack) || e); console.error('[blockwild] 读档失败', e); return false; }
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
  updateDoorAnims(dt);
  updateFurnaceJob(dt);
  updateChargerJob(dt);
  torchT -= dt;
  if (torchT <= 0) { torchT = 0.2; updateTorchLights(); }
  updateHeldTorchLight(dt);
  doorSyncT -= dt;
  if (doorSyncT <= 0) { doorSyncT = 0.25; syncDoors(); }

  // ── 相机：疾跑 FOV 微推 + 侧移轻微翻滚 + 受伤抖动（幅度必须小，不然晕）
  const spdC = Math.hypot(player.v.x, player.v.z);
  const sprintC = clamp01((spdC - CFG.WALK * 0.92) / Math.max(0.1, CFG.SPRINT - CFG.WALK * 0.92));
  if (!camBaseFov) camBaseFov = camera.fov;
  camera.fov += (camBaseFov * (1 + 0.055 * sprintC) - camera.fov) * Math.min(1, dt * 6);
  if (Math.abs(camera.fov - camLastFov) > 0.02) { camera.updateProjectionMatrix(); camLastFov = camera.fov; }

  const idealEye = player.p.y + CFG.EYE + Math.sin(player.walkPhase) * 0.018;
  camSmoothY = camSmoothY === null ? idealEye : camSmoothY + (idealEye - camSmoothY) * Math.min(1, dt * 15);
  camera.position.set(player.p.x, camSmoothY, player.p.z);
  // 侧移翻滚：用镜头坐标系的左右速度，跑起来才有"重心"感
  const fx = -Math.sin(player.yaw), fz = -Math.cos(player.yaw);
  const strafe = player.v.x * (-fz) + player.v.z * fx;
  camRoll += (clamp(-strafe * 0.010, -0.028, 0.028) - camRoll) * Math.min(1, dt * 8);
  const shake = anim.hurtK * 0.012;
  const sxA = shake ? Math.sin(now / 17) * shake : 0;
  camera.rotation.set(player.pitch + sxA, player.yaw + sxA * 0.6, camRoll);
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
  DIM = 'overworld';                          // 每次进世界一律从主世界开始
  const loaded = loadSave(world.id);          // 有存档就接着玩，没有就用这个世界自己的种子生成
  if (loaded) {
    // ★ 老 bug 的根因：以前这里无条件 `if (player.p.y < surfaceY+1) player.p.y = surfaceY+1`，
    //   于是「在矿洞/地底退出，回来就站在地表」。现在只在**被方块埋住**时就近往上挪几格。
    const bx = Math.floor(player.p.x), bz = Math.floor(player.p.z);
    const buried = (y) => isSolid(getBlock(bx, y, bz)) || isSolid(getBlock(bx, y + 1, bz));
    let by = Math.floor(player.p.y);
    if (buried(by)) {
      for (let i = 0; i < 24 && buried(by); i++) by++;
      if (buried(by)) by = Math.max(surfaceY(bx, bz), CFG.SEA) + 1;   // 挪不出去（真被埋死）才回地表，别落进海里
      player.p.y = by + 0.05;
    }
    if (DIM !== 'nether' && player.p.x > NETHER_OFF * 0.5) {   // 存档说在主世界、坐标却在冥界：兜底送回出生点
      DIM = 'overworld';
      const sp0 = spawnNearHouse(findSpawn());
      player.p.set(sp0.x, sp0.y, sp0.z);
    }
    if (DIM === 'nether' && player.p.x < NETHER_OFF * 0.5) {   // 存档说在冥界、坐标却在主世界：兜底回主世界
      DIM = 'overworld';
    }
  }
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
  // 只有新世界才做「出生点在水里/悬空就抬到地表」；读档来的位置必须原样保留
  if (!loaded) {
    const sy2 = surfaceY(Math.floor(player.p.x), Math.floor(player.p.z));
    if (player.p.y < sy2 + 1) player.p.y = sy2 + 1.05;
  }
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
$('btnReset').onclick = () => {                    // 回世界列表（联机里 = 退出联机）
  if (NET && NET.active && NET.leave) { NET.leave(); return; }
  save(); location.reload();
};
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
  { name: 'portal', cell: PT_CELL, get: portalFor, cache: portalCache },
);
loadIndex();
renderWorldList();
mmInit();
mmBigInit();
$('btnBag').onclick = () => openPanel(!panelOpen);
$('btnClose').onclick = () => openPanel(false);
$('btnFurnaceClose').onclick = () => closeFurnace();
$('btnChargerClose').onclick = () => closeCharger();
$('btnProcessorClose').onclick = () => closeProcessor();
$('procOne').onclick = () => chipBatch(1);
$('procAll').onclick = () => chipBatch(Infinity);
$('btnPressClose').onclick = () => closePress();
$('pressOne').onclick = () => pressBatch(1);
$('pressAll').onclick = () => pressBatch(Infinity);
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
  CFG, BLOCKS, ITEMS, RECIPES, MOB_DEFS, SMELT, player, chunks, edits, mobs, anim, inv: () => inv,
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
      const cnt = { 13: 0, 15: 0, 39: 0, 20: 0, 52: 0 }, ys = { 13: [99, 0], 15: [99, 0], 39: [99, 0], 20: [99, 0], 52: [99, 0] };
      for (const ch of chunks.values()) {
        const b = ch.blocks, CH = CFG.CH, WH = CFG.WH;
        for (let y = 0; y < WH; y++) for (let i = 0; i < CH * CH; i++) {
          const id = b[(y * CH * CH) + i];
          if (id !== 13 && id !== 15 && id !== 39 && id !== 20 && id !== 52) continue;
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
      // 动画调参用的探针：这些数字直接说明「哪段动作在生效、多强」
      sprintK: +anim.sprintK.toFixed(3), airK: +anim.airK.toFixed(3), waterK: +anim.waterK.toFixed(3),
      hurtK: +anim.hurtK.toFixed(3), swingN: anim.swingN, fov: +camera.fov.toFixed(2),
      camRoll: +camRoll.toFixed(4),
    }),
    // 朝向/动作方向探针：脸朝哪、手往哪甩、头抬还是低（怀疑符号反了时先看这些数）
    remoteFacing: () => Array.from(NET ? (NET.remotes || new Map()) : new Map()).map(([id, r]) => {
      const u = r.obj.userData || {};
      const nose = new THREE.Vector3();
      if (u.face) u.face.getWorldPosition(nose); else nose.copy(r.obj.position);
      const nd = nose.clone().sub(r.obj.position).normalize();
      const hand = new THREE.Vector3();
      if (u.foreR) u.foreR.getWorldPosition(hand);
      const hd = hand.clone().sub(r.obj.position).normalize();
      const up = new THREE.Vector3(0, 0, -1).applyQuaternion(r.obj.quaternion);
      return {
        name: r.name || id, rotY: +r.obj.rotation.y.toFixed(2),
        fwd: [+up.x.toFixed(2), +up.z.toFixed(2)],
        nose: [+nd.x.toFixed(2), +nd.y.toFixed(2), +nd.z.toFixed(2)],
        hand: [+hd.x.toFixed(2), +hd.y.toFixed(2), +hd.z.toFixed(2)],
        headX: +(u.head ? u.head.rotation.x : 0).toFixed(2),
        pitch: +(u.pitch || 0).toFixed(2), swing: +(u.swing || 0).toFixed(2),
      };
    }),
    // 直接量「符号对不对」：脸在旋转后朝上还是朝下、手在 armR 正/负角时朝前还是朝后
    remoteAxes: () => {
      const arr = Array.from(NET ? (NET.remotes || new Map()) : new Map());
      if (!arr.length) return null;
      const [, rr] = arr[0];
      const u = rr.obj.userData;
      const rel = (o) => { o.updateWorldMatrix(true, true); return new THREE.Vector3().setFromMatrixPosition(o.matrixWorld).sub(rr.obj.position); };
      u.head.rotation.x = 0; u.head.updateWorldMatrix(true, true);
      const faceRel = rel(u.face).sub(rel(u.head)).normalize();
      u.head.rotation.x = 0.4; u.head.updateWorldMatrix(true, true);
      const faceUp = rel(u.face).sub(rel(u.head)).normalize().y;
      u.head.rotation.x = 0;
      const handAt = (ax) => { u.armR.rotation.x = ax; u.foreR.updateWorldMatrix(true, true); return rel(u.foreR).normalize(); };
      const hb = handAt(0), hp = handAt(0.8), hn = handAt(-0.8);
      u.armR.rotation.x = 0; u.foreR.updateWorldMatrix(true, true);
      return {
        faceDirAt0: [+faceRel.x.toFixed(2), +faceRel.y.toFixed(2), +faceRel.z.toFixed(2)],
        faceUpAtRotX_pos: +faceUp.toFixed(3),
        handZ_armX0: +hb.z.toFixed(2), handZ_armX_pos: +hp.z.toFixed(2), handZ_armX_neg: +hn.z.toFixed(2),
      };
    },
    remoteAnim: () => Array.from(NET ? (NET.remotes || new Map()) : new Map()).map(([id, r]) => {
      const u = r.obj.userData || {};
      return {
        id, buf: (u.buf || []).length, spd: +(u.spd || 0).toFixed(2),
        gap: Math.round(u.gap || 0), lag: Math.round(u.lag || 0),
        since: Math.round(performance.now() - (u.lastSnapT || 0)),
        walk: +(u.walk || 0).toFixed(2), sprintK: +(u.sprintK || 0).toFixed(2),
        airK: +(u.airK || 0).toFixed(2), mineK: +(u.mineK || 0).toFixed(2), landK: +(u.landK || 0).toFixed(2),
        armR: +(u.armR ? u.armR.rotation.x : 0).toFixed(3), armL: +(u.armL ? u.armL.rotation.x : 0).toFixed(3),
        foreR: +(u.foreR ? u.foreR.rotation.x : 0).toFixed(3), legL: +(u.legL ? u.legL.rotation.x : 0).toFixed(3),
        pos: [+r.obj.position.x.toFixed(2), +r.obj.position.y.toFixed(2), +r.obj.position.z.toFixed(2)],
        roll: +r.obj.rotation.z.toFixed(3),
      };
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
      hsCache.clear(); villageCache.clear(); veinCache.clear(); myCabinCache.clear(); myCabinBusy.clear();
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
    benchChunk: (n, ddx, ddz) => {
      const pcx = Math.floor(player.p.x / CFG.CH) + (ddx || 8), pcz = Math.floor(player.p.z / CFG.CH) + (ddz || 0);
      const t = [];
      for (let i = 0; i < (n || 5); i++) {
        const c = getChunk(pcx + i, pcz);
        const t0 = performance.now();
        buildChunk(c);
        t.push(+(performance.now() - t0).toFixed(1));
      }
      return t;
    },
    dirtySize: () => dirty.size,
    chunkOf: (x, z) => { const c = chunks.get((x >> 4) + ',' + (z >> 4)); return c ? { ready: c.ready, job: !!c.job, jobY: c.job ? c.job.y : null, verts: c.mesh ? c.mesh.geometry.attributes.position.count : 0, inDirty: dirty.has(c) } : null; },
    streamOnce: () => { const t = performance.now(); streamChunks(); return +(performance.now() - t).toFixed(2); },
    meshState: () => ({ jobs: [...chunks.values()].filter(c => c.job).length, ready: [...chunks.values()].filter(c => c.ready).length, chunks: chunks.size }),
    perf: () => ({
      frameMs: +frameMsAvg.toFixed(1), budgetMs: +perfBudget.toFixed(1),
      stale: [...chunks.values()].filter(c => c.stale).length,
      ready: [...chunks.values()].filter(c => c.ready).length,
      chunks: chunks.size, edits: edits.size,
      waterQueued: waterQueue.length - waterHead, flowing: waterFlow.size,
      mobs: mobs.length, drops: drops.length, arrows: arrows.length,
      torch: torchCells.size, genMeta: genMeta.size, doorObjs: doorObjs.size,
      guard: structGuard.size, chestInv: chestInv.size, mmCells: MM.cells.size,
      caches: msCache.size + ravineCache.size + veinCache.size + lsCache.size + hsCache.size + villageCache.size,
      scene: scene.children.length,
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
      if (h && h.id === 161) return useBoneMeal(t);
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
    map: () => ({ cells: MM.cells.size, marks: MM.marks.size, zoom: MM.zoom, acrossCells: MM_ZOOM[MM.zoom], acrossBlocks: MM_ZOOM[MM.zoom] * MM_CELL,
                  info: MM.info ? MM.info.textContent : null, visible: MM.wrap ? MM.wrap.style.display !== 'none' : null,
                  markList: Array.from(MM.marks.values()) }),
    mapZoom: (d) => { mmZoom(d || 0); mmDraw(); return { zoom: MM.zoom, acrossBlocks: MM_ZOOM[MM.zoom] * MM_CELL }; },
    mapReveal: () => { mmReveal(); mmDraw(); return { cells: MM.cells.size }; },
    mapScan: () => { mmScanStructs(); mmDraw(); return { marks: MM.marks.size, list: Array.from(MM.marks.values()) }; },
    mapClear: () => { MM.cells.clear(); MM.marks.clear(); mmDraw(); return true; },
    villagerAI: () => mobs.filter(m => m.kind === 'villager').map(m => ({
      pos: [+m.p.x.toFixed(1), +m.p.y.toFixed(1), +m.p.z.toFixed(1)],
      state: m.ai ? m.ai.state : null, sleeping: !!m.sleeping,
      bed: m.bed ? [m.bed.x, m.bed.y, m.bed.z] : null,
      door: m.ai && m.ai.door ? [m.ai.door.x, m.ai.door.y, m.ai.door.z] : null,
      doorOpen: m.ai && m.ai.door ? !!((getMeta(m.ai.door.x, m.ai.door.y, m.ai.door.z)) & 4) : null,
      give: m.give ? nameOf(m.give.id) : null, jumps: m.jumps || 0,
      stuckT: m.ai ? +(m.ai.stuckT || 0).toFixed(1) : 0,
      giftScale: m.gift ? +m.gift.scale.x.toFixed(2) : null,
      giftY: m.gift ? +m.gift.position.y.toFixed(2) : null,
    })),
    mobJumps: () => mobs.map(m => ({ kind: m.kind, jumps: m.jumps || 0, vy: +m.v.y.toFixed(2), onGround: !!m.onGround })),
    heldTorch: () => ({ on: heldTorchLight.visible, pos: heldTorchLight.position.toArray().map(v => +v.toFixed(1)), intensity: +heldTorchLight.intensity.toFixed(1) }),
    giveVillager: (id) => { const v = mobs.find(m => m.kind === 'villager'); if (!v) return null; v.give = { id, n: 1 }; showVillagerGift(v); return { id, giftY: +v.gift.position.y.toFixed(2), scale: +v.gift.scale.x.toFixed(2), meshes: v.gift.children.length }; },
    mapOpenBig: (x, z) => { mmOpenBig(x, z); return { open: MM_BIG.open, zoom: MM_BIG.zoom, acrossBlocks: MM_BIGZOOM[MM_BIG.zoom] * MM_CELL, marks: MM.marks.size }; },
    mapCloseBig: () => { mmCloseBig(); return MM_BIG.open; },
    mapAddMark: (x, z, label) => { const ok = mmAddMark(x === undefined ? Math.round(MM_BIG.x) : x, z === undefined ? Math.round(MM_BIG.z) : z, label); return { ok, marks: Array.from(MM.marks.values()) }; },
    mapDelMark: (x, z) => mmDelMark('custom:' + x + ',' + z),
    mapBig: () => ({ open: MM_BIG.open, zoom: MM_BIG.zoom, acrossBlocks: MM_BIGZOOM[MM_BIG.zoom] * MM_CELL, cx: Math.round(MM_BIG.x), cz: Math.round(MM_BIG.z),
                     rows: $('mapMarks') ? $('mapMarks').children.length : -1, canvas: $('mapCv') ? [$('mapCv').width, $('mapCv').height] : null }),
    openBag: () => { openPanel(true); return $('creativeGrid').children.length; },
    cur: () => (cursor ? { id: cursor.id, name: nameOf(cursor.id), n: cursor.n } : null),
    pickCreative: (id) => { const sec = $('creativeGrid'); if (!sec) return null; const cells = sec.children; const ids = [...Object.keys(BLOCKS).map(Number), ...Object.keys(ITEMS).map(Number)].filter(i => isItem(i)); const k = ids.indexOf(+id); if (k < 0) return null; cells[k].click(); return { cursor: cursor ? { id: cursor.id, n: cursor.n } : null }; },
    invCount: () => inv.filter(Boolean).length,
    dropCursor: () => dropCursorToWorld(),
    slotShift: (i) => { slotClick(inv, i, { shiftKey: true }); return { slot: inv[i], used: inv.filter(Boolean).length }; },
    dropsInfo: () => drops.map(d => ({ id: d.id, n: d.n, p: [+d.p.x.toFixed(1), +d.p.y.toFixed(1), +d.p.z.toFixed(1)], dist: +Math.hypot(d.p.x - player.p.x, d.p.z - player.p.z).toFixed(1) })),
    mapDim: () => ({ dim: DIM, off: mmOff(), cells: MM.cells.size, marks: MM.marks.size, coords: [+(player.p.x - mmOff()).toFixed(0), +(player.p.z - mmOff()).toFixed(0)] }),
    mapPan: (dx, dz) => { MM_BIG.x += dx || 0; MM_BIG.z += dz || 0; mmBigDraw(); return { cx: Math.round(MM_BIG.x), cz: Math.round(MM_BIG.z) }; },
    mapBigZoom: (d) => { mmBigZoom(d || 0); return { zoom: MM_BIG.zoom, acrossBlocks: MM_BIGZOOM[MM_BIG.zoom] * MM_CELL }; },
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
    furnaceJob: () => furnaceJob ? { out: nameOf(furnaceJob.r.out), t: +furnaceJob.t.toFixed(2), dur: jobDur(furnaceJob), left: furnaceJob.left, fuel: furnaceJob.fuelName } : null,
    furnaceTick: (dt) => { updateFurnaceJob(dt); return furnaceJob ? { out: nameOf(furnaceJob.r.out), t: +furnaceJob.t.toFixed(2), dur: jobDur(furnaceJob), left: furnaceJob.left, fuel: furnaceJob.fuelName } : null; },
    fuelDefs: () => FUEL_DEFS.map(f => ({ ...f })),
    fuelNow: () => furnaceFuel,
    setFuel: (id) => { furnaceFuel = id; renderFurnace(); return furnaceFuel; },
    // ── 电路系统探针（本地 UI 验收用；联机模式下会被 stub 掉）──
    gun: () => {
      const h = held();
      if (!h || !ITEMS[h.id] || ITEMS[h.id].kind !== 'gun') return null;
      return { slot: player.sel, id: h.id, name: nameOf(h.id), charge: gunCharge(h), cap: gunCap(h.id), hud: gunHudEl ? gunHudEl.textContent : null, hudShown: !!(gunHudEl && gunHudEl.style.display === 'block') };
    },
    setCharge: (v) => { const h = held(); if (!h || !ITEMS[h.id] || ITEMS[h.id].kind !== 'gun') return null; h.c = Math.max(0, Math.min(gunCap(h.id), v | 0)); renderHotbar(); refreshGunHud(); return gunCharge(h); },
    fireGun: () => fireEnergyBolt(),
    bolts: () => arrows.filter(a => a.bolt).map(a => ({ dmg: a.dmg, p: [+a.p.x.toFixed(2), +a.p.y.toFixed(2), +a.p.z.toFixed(2)], t: +a.t.toFixed(2) })),
    chargerOpen: () => !$('charger').classList.contains('hide'),
    chargerJobs: () => (chargerJob ? [{ slot: chargerJob.slot, name: nameOf(chargerJob.id), t: +chargerJob.t.toFixed(2), dur: chargerJob.dur }] : []),
    chargerTargets: () => chargerTargets().map(x => ({ slot: x.i, name: nameOf(x.s.id), charge: gunCharge(x.s), cap: gunCap(x.s.id) })),
    chargeStart: (slot) => startCharge(slot === undefined ? chargerTargets()[0] && chargerTargets()[0].i : slot),
    chargerTick: (dt) => { updateChargerJob(dt); return chargerJob ? { t: +chargerJob.t.toFixed(2), dur: chargerJob.dur } : null; },
    chargerHtml: () => ({ hasPanel: !!$('charger'), rows: $('chgList') ? $('chgList').children.length : -1, info: $('chgInfo') ? $('chgInfo').textContent : null }),
    doors: () => [...doorObjs.entries()].map(([k, o]) => ({ k, dir: o.dir, p: +o.p.toFixed(3), targetP: o.targetP, rotY: +o.group.rotation.y.toFixed(3) })),
    doorBox: (dir, open) => {          // 关/开门时门板在世界格内的包围盒（必须落在 0..1，否则穿模邻居）
      const geo = doorGeometry(dir), d = DOOR_DEF[dir];
      const pos = geo.attributes.position.array, a = open ? d.a : 0;
      const cos = Math.cos(a), sin = Math.sin(a);
      let mnx = 9, mxx = -9, mnz = 9, mxz = -9;
      for (let i = 0; i < pos.length; i += 3) {
        const X = pos[i] * cos + pos[i + 2] * sin, Z = -pos[i] * sin + pos[i + 2] * cos;
        mnx = Math.min(mnx, X + d.hx); mxx = Math.max(mxx, X + d.hx);
        mnz = Math.min(mnz, Z + d.hz); mxz = Math.max(mxz, Z + d.hz);
      }
      return { dir, open, x: [+mnx.toFixed(3), +mxx.toFixed(3)], z: [+mnz.toFixed(3), +mxz.toFixed(3)] };
    },
    villagers: () => mobs.filter(m => m.recruit).map(m => ({
      hp: m.hp, hired: m.recruit.hired, follow: m.recruit.follow,
      want: { name: nameOf(m.recruit.want.id), need: m.recruit.want.need, got: m.recruit.want.got },
      give: m.give ? nameOf(m.give.id) : null, hasMark: !!m.mark, hasGift: !!m.gift,
      pos: [+m.p.x.toFixed(1), +m.p.y.toFixed(1), +m.p.z.toFixed(1)],
    })),
    restoreSquad: (l) => restoreSquad(l),
    squadSave: () => squadData(),
    cabinStats: () => Object.assign({}, CABIN_STATS),
    cabinAt: (wx, wz) => { const o = myCabinFor(Math.floor(wx / CABIN_CELL), Math.floor(wz / CABIN_CELL)); return o ? { cx: o.cx, cz: o.cz, gy: o.gy, where: o.where, ops: o.ops } : null; },
    cabinFloat: (wx, wz) => {                    // 小屋地基悬空检测：gy 层有方块、正下方却是空气的格子数
      const o = myCabinFor(Math.floor(wx / CABIN_CELL), Math.floor(wz / CABIN_CELL));
      if (!o) return null;
      let cells = 0, gap = 0;
      for (let x = o.cx - 2; x <= o.cx + 11; x++) for (let z = o.cz - 2; z <= o.cz + 11; z++) {
        if (getBlock(x, o.gy, z) === 0) continue;
        cells++;
        if (getBlock(x, o.gy - 1, z) === 0) gap++;
      }
      return { cx: o.cx, cz: o.cz, gy: o.gy, where: o.where, floorCells: cells, gapUnder: gap };
    },
    structDensity: (cells = 10) => {             // 各结构在 (2n+1)² 个格子里出现的比例（频率体检）
      const out = {};
      for (const t of STRUCT_TYPES) {
        let found = 0, tot = 0;
        for (let cx = -cells; cx <= cells; cx++) for (let cz = -cells; cz <= cells; cz++) {
          tot++;
          if (t.get(cx, cz)) found++;
        }
        out[t.name] = { cell: t.cell, found, tot, pct: +(100 * found / tot).toFixed(1) };
      }
      return out;
    },
    struct: { sel: structSel, export: exportStructure, upload: uploadStructure, list: listStructures, place: placeStructureAt,
      setCorner: setStructCorner, hud: structHud },
    sleep: () => GAME.mobs.filter(m => m.kind === 'villager').map(m => ({
      sleeping: !!m.sleeping, bed: m.bed ? [m.bed.x, m.bed.y, m.bed.z] : null,
      pos: [+m.p.x.toFixed(1), +m.p.y.toFixed(1), +m.p.z.toFixed(1)], rotX: +m.parts.core.rotation.x.toFixed(2) })),
    setNight: (v) => { worldTime = CFG.DAY * (v ? 0.62 : 0.25); updateSky(); return isNight(); },
    sight: (kind) => { const t = mobs.find(m => m.kind === kind); return t ? sightClear(player.p, t.p) : null; },
    limbs: () => { const m = GAME.mobs.find(x => x.recruit); return m ? { limbs: m.parts.limbs.length, arms: [!!m.parts.arm1, !!m.parts.arm2] } : null; },
    squad: () => squadList().map(m => ({ name: MOB_DEFS[m.kind].name, follow: m.recruit.follow,
      equip: m.equip, armorMeshes: m.armorMeshes ? m.armorMeshes.length : 0,
      pos: [+m.p.x.toFixed(1), +m.p.y.toFixed(1), +m.p.z.toFixed(1)] })),
    openPanel: () => { const l = squadList(); if (!l.length) return false; openVillagerPanel(l[0]); return document.getElementById('vpanel').style.display === 'block'; },
    panelText: () => (document.getElementById('vpanel') || {}).innerText || null,
    gear: (slot) => { const l = squadList(); if (!l.length) return false; return equipVillager(l[0], slot); },
    spawnVillager: () => { const p = spawnMobAt('villager', Math.floor(player.p.x) + 2, Math.floor(player.p.y) + 1, Math.floor(player.p.z));
      return p ? { ok: true, want: nameOf(p.recruit.want.id), need: p.recruit.want.need } : { ok: false }; },
    plants: () => { let n36 = 0, n37 = 0, meshes = 0, verts = 0;
      for (const ch of chunks.values()) {
        meshes += ch.plant ? 1 : 0;
        if (ch.plant) verts += ch.plant.geometry.attributes.position.count;
        const b = ch.blocks;
        for (let i = 0; i < b.length; i++) { if (b[i] === 36) n36++; else if (b[i] === 37) n37++; }
      }
      return { grass: n36, flowers: n37, plantMeshes: meshes, plantVerts: verts }; },
    eat: () => ({ on: eatState.on, t: +eatState.t.toFixed(2), bites: eatState.bites, id: eatState.id, hunger: +player.hunger.toFixed(1) }),
    openFurnace: () => openFurnace(),
    openProcessor: () => openProcessor(),
    closeProcessor: () => closeProcessor(),
    processorOpen: () => processorOpen,
    chipCount: () => countOf(170),
    logCount: () => countOf(6),
    processN: (n) => chipBatch(n),
    openPress: () => openPress(),
    closePress: () => closePress(),
    pressOpen: () => pressOpen,
    pressInfo: () => ({ carbon: countOf(177), iron: countOf(106), steel: countOf(178), can: pressCan() }),
    pressN: (n) => pressBatch(n),
    netherOre: () => {                            // 冥界矿脉体检：数一下已加载区块里的冥界碳
      let c = 0, chunksN = 0;
      for (const ch of chunks.values()) {
        chunksN++;
        const bl = ch.blocks, CH = CFG.CH, WH = CFG.WH;
        for (let y = NETHER_LAVA_Y; y < WH; y++) for (let i = 0; i < CH * CH; i++) if (bl[(y * CH * CH) + i] === 46) c++;
      }
      return { chunks: chunksN, carbon: c, perChunk: chunksN ? +(c / chunksN).toFixed(1) : 0 };
    },
    dim: () => DIM,
    goNether: () => travelDimension(null),
    spawnHere: (kind, dx, dz) => spawnMobAt(kind, Math.round(player.p.x + (dx || 0)), Math.round(player.p.y), Math.round(player.p.z + (dz || 0))),
    mobBox: (kind) => { const m = mobs.find(x => x.kind === kind); if (!m) return null; let mn = [1e9, 1e9, 1e9], mx = [-1e9, -1e9, -1e9];
      m.obj.updateMatrixWorld(true);
      m.obj.traverse(o => { if (!o.isMesh || !o.geometry) return; const g = o.geometry; if (!g.boundingBox) g.computeBoundingBox();
        const b = g.boundingBox; for (const cx of [b.min.x, b.max.x]) for (const cy of [b.min.y, b.max.y]) for (const cz of [b.min.z, b.max.z]) {
          const v = new THREE.Vector3(cx, cy, cz).applyMatrix4(o.matrixWorld);
          mn = [Math.min(mn[0], v.x), Math.min(mn[1], v.y), Math.min(mn[2], v.z)];
          mx = [Math.max(mx[0], v.x), Math.max(mx[1], v.y), Math.max(mx[2], v.z)]; } });
      return { size: [+(mx[0] - mn[0]).toFixed(2), +(mx[1] - mn[1]).toFixed(2), +(mx[2] - mn[2]).toFixed(2)], feetGap: +(mn[1] - m.p.y).toFixed(2) }; },
    goOver: () => (DIM === 'nether' ? travelDimension(null) : false),
    loadErr: () => loadErr,
    savedInfo: () => { try { const d = JSON.parse(localStorage.getItem(worldKey(currentId)) || 'null'); return d ? { y: d.player && d.player.y, dim: d.dim, edits: (d.edits || []).length } : null; } catch (e) { return String(e); } },
    burnState: () => ({ playerBurn: +(player.burn || 0).toFixed(2),
                        burnFx: ($('burnFx') || {}).className || '',
                        playerFlames: playerFlames.filter(s => s.visible).length,
                        mobs: mobs.filter(m => m.burn > 0).map(m => ({
                          kind: m.kind, burn: +m.burn.toFixed(2),
                          sprites: (m.fx || []).filter(s => s.visible).length,
                          emissive: m.parts.bodyMat.emissive.getHex().toString(16),
                        })) }),
    setMobBurn: (i, sec = 3) => { const m = mobs[i]; if (!m) return null; m.burn = sec; return m.kind; },
    fromPortal: () => player.fromPortal ? { ...player.fromPortal } : null,
    portalActiveAny: (wx, wz) => {                    // 当前维度里找这座门的核心并读激活状态
      const o = portalFor(Math.floor(wx / PT_CELL), Math.floor(wz / PT_CELL));
      if (!o) return null;
      return isPortalActive({ x: o.cx, y: o.gy + 2, z: o.cz });
    },
    travel: () => travelDimension(),
    usePortal: (x, y, z) => usePortal(x, y, z),
    portalAt: (wx, wz) => { const o = portalFor(Math.floor(wx / PT_CELL), Math.floor(wz / PT_CELL)); return o ? { cx: o.cx, cz: o.cz, gy: o.gy } : null; },
    portalNear: (cells = 6) => {                     // 找离玩家最近的传送门（无头测试/自检用）
      const pcx = Math.floor(player.p.x / PT_CELL), pcz = Math.floor(player.p.z / PT_CELL);
      let best = null;
      for (let dx = -cells; dx <= cells; dx++) for (let dz = -cells; dz <= cells; dz++) {
        const o = portalFor(pcx + dx, pcz + dz);
        if (!o) continue;
        const d = Math.hypot(o.cx - player.p.x, o.cz - player.p.z);
        if (!best || d < best.d) best = { cx: o.cx, cz: o.cz, gy: o.gy, d: Math.round(d) };
      }
      return best;
    },
    portalActive: (x, y, z) => { const c = findPortalCore(x, y, z); return c ? isPortalActive(c) : null; },
    netherMobs: () => GAME.mobs.filter(m => MOB_DEFS[m.kind] && MOB_DEFS[m.kind].dim === 'nether').map(m => m.kind),
    swamps: (r) => { const out = []; const cx = Math.floor(player.p.x / LS_CELL), cz = Math.floor(player.p.z / LS_CELL); for (let dx = -(r || 1); dx <= (r || 1); dx++) for (let dz = -(r || 1); dz <= (r || 1); dz++) { const s = lavaSwamp(cx + dx, cz + dz); if (s) out.push({ x: s.x, z: s.z, trees: s.trees.length, dist: Math.round(Math.hypot(s.x - player.p.x, s.z - player.p.z)) }); } return out; },
    tangle: () => ({ t: +(player.tangle || 0).toFixed(2), near: vineNearPlayer(), bossCd: Math.round(crocBossCd), kings: GAME.mobs.filter(m => m.kind === 'crocKing').length }),
    nearSwamp: () => { const cx = Math.floor(player.p.x / LS_CELL), cz = Math.floor(player.p.z / LS_CELL); for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) { const s = lavaSwamp(cx + dx, cz + dz); if (s && Math.hypot(s.x - player.p.x, s.z - player.p.z) < 60) return s; } return null; },
    spawnKind: (kind, dx = 3, dz = 0) => {           // 指定种类刷一只（自检/截图用）
      const x = Math.floor(player.p.x + dx), z = Math.floor(player.p.z + dz);
      let y = Math.floor(player.p.y);
      for (let k = 0; k < 8; k++) { const id = getBlock(x, y - 1, z); if (id !== 0 && id !== 44) break; y--; }
      const m = spawnMobAt(kind, x, y, z, { force: true });
      return m ? { kind: m.kind, p: [+m.p.x.toFixed(1), +m.p.y.toFixed(1), +m.p.z.toFixed(1)], hp: m.hp } : null;
    },
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

/* ============================================================ 联机层（P0 spike）
 * 开启方式（不加参数 = 单机，行为与之前完全一致）：
 *   /blockwild/?net=http://192.168.50.3:9103&world=W1&nick=KA
 * 世界模型：服务端只存 seed + 方块改动，客户端用同一个 seed 自己生成地形，
 *           所以进服同步是「几十 KB 的编辑表」而不是「8MB 的区块」。
 * 权威划分：位置=客户端（服务端只做距离/速率校验），方块=服务端（拒绝就回滚），
 *           液体/怪物=主机客户端（别的客户端不模拟，避免编辑流互相打架）。
 */
(function bootNet() {
  const q = new URLSearchParams(location.search);
  // ?net=http://host:port 显式指定守护进程；?mp=1 走默认路径（局域网直连 :9203 / 公网同源 PHP 桥）
  let base = q.get('net');
  const host = location.hostname;
  const LAN = /^(localhost|127\.|192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host);
  if (!base && q.has('mp')) {
    // https 页面无法直连 ws://host:9203（混合内容 + 端口未暴露）
    // http 的公网域名同样连不到 :9203（端口没映射到外网）——以前这里只按 https 判断，
    // 于是「http 打开、点联机」永远 Failed to fetch。现在只有局域网 IP / localhost 才直连 WS。
    base = (location.protocol === 'https:' || !LAN)
      ? (location.pathname.replace(/[^/]*$/, '') + 'bwmp.php')
      : ('http://' + host + ':9203');
  }
  if (!base) return;                                   // 没带 ?net= / ?mp → 纯单机
  let nick = (q.get('nick') || localStorage.getItem('bw_nick') || ('P' + Math.random().toString(36).slice(2, 5))).slice(0, 14);
  if (nick) { try { localStorage.setItem('bw_nick', nick); } catch (e) {} }
  // ★ 世界代码：URL 指定 > 上次自己选过的 > 按昵称算出来的「我的世界」。
  //   以前默认写死 'W1'：所有人点「进入联机」都被塞进同一个公共 W1 世界（别人的存档）。
  const myWorld = () => 'W' + (Math.abs(hashString('bw:' + nick)) % 1679616).toString(36).toUpperCase().padStart(4, '0');
  let savedWorld = ''; try { savedWorld = localStorage.getItem('bw_world') || ''; } catch (e) {}
  let world = String(q.get('world') || savedWorld || myWorld()).replace(/[^\w-]/g, '').slice(0, 12) || myWorld();
  // ★ 身份（pid）跟昵称走，不跟世界走：以前 pid = 世界码-昵称，换个世界就成了另一个账号，
  //   好友关系/申请全部失效（"明明是好友却提示还不是好友"）。
  const pid = (q.get('pid') || ('u-' + nick)).slice(0, 24);
  // ★ 「刚进去就被拉到联机世界」的根因就在这里：只要 URL 上带着 ?mp=1（一次联机后地址栏就一直带着，
  //   刷新 / 点「世界」/ iOS 恢复标签页都会再进一次），bootNet 就无条件 join。
  //   现在只有明确意图（?net= 调试入口，或客户端自己跳转时带的 go=1）才自动进服；
  //   裸链接（手输/书签/分享）一律不自动进，退回单机开始界面并打开联机面板预填这个世界码。
  const wantGo = q.has('net') || q.get('go') === '1';
  if (!wantGo) {
    try { history.replaceState(null, '', location.pathname); } catch (e) {}
    window.__bwPrefillMP = { code: world, nick, why: 'link' };
    return;
  }
  const API = base.replace(/\/+$/, '');
  const IS_BRIDGE = /\.php(\?|$)/.test(API);          // 同源 PHP 桥 → 只能轮询
  const EP = IS_BRIDGE ? API : (API + '/api');   // 所有 HTTP 动作的实际地址（桥模式就是 bwmp.php 本身）
  const WSURL = API.replace(/^http/, 'ws') + '/';
  const net = {
    active: true, applying: false, isHost: false, id: pid, code: world, nick,
    ws: null, connected: false, rtt: 0, snapHz: 0, snaps: 0, hzT: 0, mode: IS_BRIDGE ? 'poll' : 'ws', pollT: 0, syncs: 0,
    pending: new Map(), seq: 0, serverSeq: 0, mobSeq: 0, mobT: 0, sendT: 0, hudT: 0, pingT: 0,
    ghosts: new Map(), devOk: false,
    remotes: new Map(), lastSnap: 0, err: '', editOut: 0, rejCount: 0, netBytes: 0,
  };
  NET = net;

  /* ---------- 退出联机（必须有个出口）
   * 以前进了联机就没有任何按钮能出来：「世界」按钮 reload 回来又自动 join（URL 粘着 ?mp），
   * 只能自己在地址栏删参数。现在「世界」按钮和好友面板里都能退出。 */
  net.leave = (ask) => {
    if (ask !== false && !confirm(ask || `退出联机「${net.code}」，回到世界列表？`)) return false;
    net.active = false; net.connected = false;
    try { if (net.ws) net.ws.close(); } catch (e) {}
    // 房主的房间就是他自己的存档：退出前先存一次，别把联机里盖的东西弄丢
    if (net.lid) { try { save(); } catch (e) {} }
    else { try { net.beaconInv(); } catch (e) {} }      // 客人：最后一次把背包存回服务端（beacon 不会被 reload 掐掉）
    try { history.replaceState(null, '', location.pathname); } catch (e) {}
    location.reload();
    return true;
  };

  /* ---------- 远端玩家形象 ---------- */
  function nameTag(text) {
    const cv = document.createElement('canvas');
    cv.width = 256; cv.height = 64;
    const g = cv.getContext('2d');
    g.font = 'bold 34px system-ui, sans-serif';
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillStyle = 'rgba(8,16,26,.72)';
    g.fillRect(0, 12, 256, 40);
    g.fillStyle = '#dff0ff';
    g.fillText(text.slice(0, 12), 128, 33);
    const tex = new THREE.CanvasTexture(cv);
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false }));
    sp.scale.set(1.7, 0.42, 1);
    sp.position.y = 2.15;
    return sp;
  }
  function avatar(id, name) {
    // 远端形象的头/手方向（用 GAME.debug.remoteAxes() 实测出来的基准，模型正面 = -Z）：
    //   脸在 -Z；armR.rotation.x 正 = 手往前甩；head.rotation.x 正 = 抬头（下巴抬高、头顶往后）。
    // 如果哪天看着反了，只需要把 HEAD_PITCH_SIGN 改成 -1（定义在 bootNet 作用域里）。
    // 固定调色板（避开草绿/天空蓝，否则人在草地上几乎看不见）
    const PAL = [0xd9534f, 0x9b59b6, 0xf0ad4e, 0xe67e22, 0x1abc9c, 0xff6fa8, 0xc0392b, 0x8e6bff];
    let hsh = 0;
    for (let i = 0; i < id.length; i++) hsh = (hsh * 31 + id.charCodeAt(i)) | 0;
    const base = PAL[Math.abs(hsh) % PAL.length];
    const col = new THREE.Color(base);
    const dark = col.clone().multiplyScalar(0.62);
    const limbCol = dark.clone().multiplyScalar(0.95);
    const g = new THREE.Group();
    const box = (w, hh, d, c) => new THREE.Mesh(new THREE.BoxGeometry(w, hh, d), new THREE.MeshLambertMaterial({ color: c }));
    const root = (w, hh, d, c, x, y, z) => {
      const m = box(w, hh, d, c);
      m.position.set(x, y, z); m.castShadow = true; m.receiveShadow = true; g.add(m); return m;
    };
    const torso = root(0.52, 0.72, 0.3, col, 0, 1.06, 0);
    const head = root(0.42, 0.42, 0.42, dark, 0, 1.62, 0);
    // 脸：确认「模型正面」到底朝哪边 —— 顺带让人一眼能看出别人面朝哪（以前纯对称，看不出前后）
    const face = box(0.28, 0.12, 0.02, 0x2b1a12);
    face.position.set(0, 0.03, -0.215);
    head.add(face);
    const eyeL = box(0.07, 0.06, 0.02, 0xf2f2f2); eyeL.position.set(-0.09, 0.09, -0.222); head.add(eyeL);
    const eyeR = box(0.07, 0.06, 0.02, 0xf2f2f2); eyeR.position.set(0.09, 0.09, -0.222); head.add(eyeR);
    // ★ 四肢挂在一个「关节」Group 上（肩 / 髋），绕关节转才是摆臂甩腿；
    //   以前直接把方块摆在这里转的是方块自己的中心，看起来像风车。
    const joint = (x, y, w, hh, d, c) => {
      const piv = new THREE.Group();
      piv.position.set(x, y, 0);
      const m = box(w, hh, d, c);
      m.position.set(0, -hh / 2, 0);                 // 从关节往下长
      m.castShadow = true; m.receiveShadow = true;
      piv.add(m);
      g.add(piv);
      return piv;
    };
    const armL = joint(-0.35, 1.40, 0.18, 0.68, 0.2, limbCol);
    const armR = joint(0.35, 1.40, 0.18, 0.68, 0.2, limbCol);
    const legL = joint(-0.13, 0.70, 0.2, 0.7, 0.22, limbCol);
    const legR = joint(0.13, 0.70, 0.2, 0.7, 0.22, limbCol);
    // 右手前臂再分一节，挖掘/挥砍时只甩前臂（A&S 那种"手腕"感）
    const foreR = new THREE.Group();
    foreR.position.set(0, -0.42, 0);
    const foreMesh = box(0.17, 0.30, 0.19, dark);
    foreMesh.position.set(0, -0.15, 0);
    foreR.add(foreMesh);
    armR.add(foreR);
    g.add(nameTag(name));
    g.userData = {
      tx: 0, ty: 0, tz: 0, yaw: 0,
      walk: 0, spd: 0, swing: 0, swingType: '', airK: 0, sprintK: 0, mineK: 0, landK: 0,
      buf: [], airPrev: 0,              // 快照缓冲（渲染延迟插值用）+ 上一帧腾空位（判落地）
      armL, armR, legL, legR, foreR, torso, head, face, flags: 0, phase: Math.random() * 6.28,
    };
    scene.add(g);
    return g;
  }
  function ensureRemote(p) {
    let r = net.remotes.get(p.i);
    if (!r) {
      r = { obj: avatar(p.i, p.n), name: p.n || p.i };
      r.obj.position.set(p.x, p.y, p.z);
      r.obj.userData.tx = p.x; r.obj.userData.ty = p.y; r.obj.userData.tz = p.z; r.obj.userData.yaw = p.w;
      net.remotes.set(p.i, r);
      toast(`${r.name} 进入了房间`, 2.5);            // 有人进来必须看得见（这是"联机到底通没通"最直接的反馈）
    }
    return r;
  }
  function dropRemote(id) {
    const r = net.remotes.get(id);
    if (!r) return;
    scene.remove(r.obj);
    r.obj.traverse(o => { if (o.geometry) o.geometry.dispose(); if (o.material) o.material.dispose(); });
    net.remotes.delete(id);
  }

  /* ---------- 兴趣管理：走远了分块补改动（进服只发 ±128 格） ---------- */
  net.lastPull = { x: 1e9, z: 1e9 };
  net.pullT = 0;
  net.pullRegion = () => {
    const x = Math.floor(player.p.x), z = Math.floor(player.p.z);
    net.lastPull = { x, z };
    fetch(EP, { method: 'POST', headers: { 'content-type': 'text/plain' },
      body: JSON.stringify({ a: 'region', code: net.code, x, z, r: 112 }) })
      .then(r => r.json()).then(d => {
        if (!d.ok || !d.edits) return;
        let n = 0;
        for (const [k, id] of d.edits) {
          if (edits.has(k) && edits.get(k) === id) continue;      // 已经有了就跳过
          const a = k.split(',').map(Number);
          applyServerBlock(a[0], a[1], a[2], id);
          n++;
        }
        if (n > 120) toast(`补齐了附近 ${n} 处改动`, 2);
      }).catch(() => {});
  };

  /* ---------- 非主机打幽灵怪：本地判定 + 上报给主机扣血 ---------- */
  net.hitGhost = (dmg) => {
    if (net.isHost) return false;                     // 主机打的是真怪，不走这条路
    // 以前这里要求 ws 开着：公网轮询模式下客人永远打不动怪。现在统一走 net.send（ws / HTTP 双通道）。
    const dir = cameraDir(), eye = eyePos();
    let best = null, bestT = 1e9;
    for (const [id, g] of net.ghosts) {
      const dx = g.obj.position.x - eye.x, dy = (g.obj.position.y + 0.9) - eye.y, dz = g.obj.position.z - eye.z;
      const t = dx * dir.x + dy * dir.y + dz * dir.z;
      if (t < 0.1 || t > CFG.REACH - 1.2) continue;
      const px = dx - dir.x * t, py = dy - dir.y * t, pz = dz - dir.z * t;
      if (px * px + py * py + pz * pz > 1.1) continue;
      if (t < bestT) { bestT = t; best = id; }
    }
    if (!best) return false;
    net.send('hit', { i: best, d: dmg });
    const g = net.ghosts.get(best);
    if (g) g.hitAt = performance.now();          // 打中反馈（本地闪一下）
    return true;
  };

  /* ---------- 非主机端的「幽灵怪」：只按主机快照摆模型，不跑 AI、不参与战斗 ---------- */
  function syncGhosts(list) {
    const alive = new Set();
    for (const e of list) {
      const [id, kind, x, y, z, rot, hp] = e;
      if (typeof hp === 'number' && hp <= 0) continue;
      alive.add(id);
      let g = net.ghosts.get(id);
      if (!g) {
        const parts = (typeof makeMobModel === 'function') ? makeMobModel(kind) : null;
        if (!parts) continue;
        parts.g.position.set(x, y, z);
        scene.add(parts.g);
        g = { obj: parts.g, tx: x, ty: y, tz: z, rot };
        net.ghosts.set(id, g);
      }
      g.tx = x; g.ty = y; g.tz = z; g.rot = rot;
    }
    for (const [id, g] of Array.from(net.ghosts)) {
      if (alive.has(id)) continue;
      scene.remove(g.obj);
      g.obj.traverse(o => { if (o.geometry && !o.geometry.userData.shared) o.geometry.dispose(); });
      net.ghosts.delete(id);
    }
  }

  /* ---------- 箱子：服务端是唯一权威（两人开同一个箱子看到同一批东西） ---------- */
  net.pullChest = (x, y, z) => {
    const k = x + ',' + y + ',' + z;
    fetch(EP, { method: 'POST', headers: { 'content-type': 'text/plain' },
      body: JSON.stringify({ a: 'chest', code: net.code, pid: net.id, k }) })
      .then(r => r.json()).then(d => {
        if (!d.ok || !Array.isArray(d.slots)) return;
        chestInv.set(k, d.slots);
        if (openChestPos && (openChestPos.x + ',' + openChestPos.y + ',' + openChestPos.z) === k) renderChest();
      }).catch(() => {});
  };
  net.pushChest = () => {
    if (!openChestPos) return;
    const k = openChestPos.x + ',' + openChestPos.y + ',' + openChestPos.z;
    const slots = chestInv.get(k);
    if (!slots) return;
    fetch(EP, { method: 'POST', headers: { 'content-type': 'text/plain' },
      body: JSON.stringify({ a: 'chest', code: net.code, pid: net.id, k, slots }) }).catch(() => {});
  };

  /* ---------- 客人背包：存服务端，退出/换设备都拿得回来（房主用自己的本地存档） ---------- */
  net.pullInv = () => {
    if (net.lid) return;
    fetch(EP, { method: 'POST', headers: { 'content-type': 'text/plain' },
      body: JSON.stringify({ a: 'inv', code: net.code, pid: net.id }) })
      .then(r => r.json()).then(d => {
        const s = d && d.data;
        if (!d.ok || !s) return;
        inv = new Array(SLOTS).fill(null);
        (s.inv || []).filter(x => x && isItem(x.id) && x.n > 0).forEach((x, i) => { if (i < SLOTS) inv[i] = { id: x.id, n: x.n, d: x.d }; });
        if (s.armor) for (const k of ARMOR_SLOTS) if (ITEMS[s.armor[k]]) player.armor[k] = s.armor[k];
        if (s.hp) player.hp = Math.min(20, s.hp | 0);
        if (s.hunger) player.hunger = Math.min(20, s.hunger | 0);
        renderHotbar(); refreshHeld(); renderHearts();
        toast('取回你上次在这个房间的背包（' + (s.inv || []).filter(Boolean).length + ' 格）', 3.5);
      }).catch(() => {});
  };
  net.pushInv = () => {
    if (net.lid || !net.active) return;
    fetch(EP, { method: 'POST', headers: { 'content-type': 'text/plain' },
      body: JSON.stringify({ a: 'inv', code: net.code, pid: net.id,
        set: { inv, armor: player.armor, hp: player.hp, hunger: player.hunger } }) }).catch(() => {});
  };
  // 关标签页/切后台时 fetch 会被浏览器掐掉，用 sendBeacon 兜底（不然最后 5 秒的收获白拿）
  net.beaconInv = () => {
    if (net.lid || !net.active) return false;
    try {
      const body = JSON.stringify({ a: 'inv', code: net.code, pid: net.id,
        set: { inv, armor: player.armor, hp: player.hp, hunger: player.hunger } });
      if (navigator.sendBeacon) {
        navigator.sendBeacon(EP, new Blob([body], { type: 'text/plain' }));
        return true;
      }
    } catch (e) {}
    try { net.pushInv(); } catch (e) {}
    return false;
  };
  try { window.addEventListener('pagehide', () => net.beaconInv()); } catch (e) {}

  /* ---------- 掉落物：主机广播快照，客人只画幽灵；谁捡走就上报 ---------- */
  net.dropGhosts = new Map();
  net.picked = new Set();                        // 已经捡走的掉落物 nid（防过期快照重建 → 重复捡）
  /* 上行消息统一出口：有 ws 走 ws，轮询模式走同名 HTTP action（服务端两个通道都认） */
  net.send = (kind, obj) => {
    if (net.ws && net.ws.readyState === 1) {
      try { net.ws.send(JSON.stringify(Object.assign({ t: kind }, obj))); return; } catch (e) {}
    }
    fetch(EP, { method: 'POST', headers: { 'content-type': 'text/plain' },
      body: JSON.stringify(Object.assign({ a: kind, code: net.code, pid: net.id }, obj)) }).catch(() => {});
  };
  net.sendPick = (nid) => net.send('pick', { i: nid });
  net.castAct = (type) => net.send('act', { act: type });
  // 状态位：1=挖掘 2=疾跑 4=腾空 —— 远端形象靠它播动作（1 个字节，跟位置一起发）
  net.myFlags = () => {
    const spd = Math.hypot(player.v.x, player.v.z);
    return (mineHeld && player.mineTarget && player.alive ? 1 : 0)
         | (spd > CFG.WALK * 0.95 ? 2 : 0)
         | (!player.onGround && !player.inWater && !player.inLava ? 4 : 0);
  };
  net.dropSeqLocal = 0;
  net.addDropGhost = (nid, id, n, x, y, z) => {
    // 客人本地的「预演掉落物」必须和主机的真实掉落物同款（物品=薄板、方块=立方体）
    const mesh = BLOCKS[id]
      ? new THREE.Mesh(new THREE.BoxGeometry(0.38, 0.38, 0.38), new THREE.MeshBasicMaterial({ map: dropTexture(id) }))
      : itemDropMesh(id);
    mesh.position.set(x, y, z);
    scene.add(mesh);
    const g = { obj: mesh, id, n, p: new THREE.Vector3(x, y, z), t: 0, synced: false, vy: 0, thin: !BLOCKS[id] };
    net.dropGhosts.set(nid, g);
    return g;
  };
  // 客人挖出方块 → 不本地模拟，只上报给主机（主机 spawn 真掉落物，再广播回来接管这个幽灵）
  net.remoteDrop = (id, n, x, y, z) => {
    const nid = 'g' + net.id + ':' + (++net.dropSeqLocal);
    net.addDropGhost(nid, id, n, x, y + 0.2, z);
    net.send('drop', { u: [nid, id, n, +x.toFixed(2), +y.toFixed(2), +z.toFixed(2)] });
    return null;
  };
  net.syncDropGhosts = (list) => {
    const alive = new Set();
    for (const e of list) {
      const [nid, id, n, x, y, z] = e;
      if (!isItem(id)) continue;
      if (net.picked.has(String(nid))) continue;        // 已经捡走的：别被过期快照重建出来
      alive.add(nid);
      let g = net.dropGhosts.get(nid) || net.addDropGhost(nid, id, n, x, y, z);
      g.id = id; g.n = n; g.p.set(x, y, z); g.synced = true;
    }
    for (const [nid, g] of Array.from(net.dropGhosts)) {
      if (alive.has(nid)) continue;
      if (g.t < 2 || !g.synced) continue;       // 刚上报、主机还没回的快照：别立刻删掉（否则自己挖的东西闪一下就没）
      scene.remove(g.obj);
      if (!g.obj.userData.sharedGeo) {              // 薄板用共享几何/材质，不能释放
        if (g.obj.geometry) g.obj.geometry.dispose();
        if (g.obj.material && g.obj.material.dispose) g.obj.material.dispose();
      }
      net.dropGhosts.delete(nid);
    }
    net.checkDropPick();                        // 收到快照就顺手判一次（不依赖 rAF，手机切后台也捡得到）
  };
  /* 拾取判定单独拎出来：既在每帧跑，也在收到主机快照时跑一次。
   * 只跑在 rAF 里的话，后台/被节流的页面（手机切出去、iframe）就永远捡不到东西。 */
  net.checkDropPick = () => {
    for (const [nid, g] of Array.from(net.dropGhosts)) {
      if (g.t < 0.3) continue;
      if (net.picked.has(String(nid))) { scene.remove(g.obj); net.dropGhosts.delete(nid); continue; }
      const dx = player.p.x - g.p.x, dz = player.p.z - g.p.z;
      // 客人看到的掉落物坐标是主机 8Hz 同步 + 插值来的，别用主机的贴脸判定（0.95），用水平 1.8m
      if (dx * dx + dz * dz > 3.24) continue;
      addItem(g.id, g.n);
      renderHotbar(); sfx('dig');
      if (g.n > 1) toast(`拾取 ${nameOf(g.id)} ×${g.n}`, 1.1);
      scene.remove(g.obj);
      net.dropGhosts.delete(nid);
      // 记下来：主机快照可能比 pick 广播早到一帧，会把这个幽灵重新建出来 —— 不记就会「捡两次」
      net.picked.add(String(nid));
      if (net.picked.size > 400) net.picked.clear();
      net.sendPick(nid);
      if (!net.lid) net.pushInv();
    }
  };
  net.updateDropGhosts = (dt) => {
    const k = Math.min(1, dt * 12);
    for (const [nid, g] of Array.from(net.dropGhosts)) {
      g.t += dt;
      if (!g.synced) {                          // 还没拿到主机的坐标：本地先自由落体，别悬在半空
        g.vy -= 17 * dt;
        g.p.y += g.vy * dt;
        const below = getBlock(Math.floor(g.p.x), Math.floor(g.p.y - 0.17), Math.floor(g.p.z));
        if (g.vy < 0 && isSolid(below)) { g.p.y = Math.floor(g.p.y - 0.17) + 1.17; g.vy = 0; }
      }
      // 主机 8Hz 的快照直接 set 会一卡一卡，这里插值
      g.obj.position.x += (g.p.x - g.obj.position.x) * k;
      g.obj.position.y += (g.p.y + Math.sin(g.t * 3.2) * 0.05 - g.obj.position.y) * k;
      g.obj.position.z += (g.p.z - g.obj.position.z) * k;
      if (g.thin) orientDropCard(g.obj, g.p.x, g.p.z, g.t);
      else g.obj.rotation.y += dt * 2.4;
    }
    net.checkDropPick();
  };
  net.dropList = () => {
    const u = [];
    for (const d of drops) {
      u.push([d.nid, d.id, d.n, +d.p.x.toFixed(2), +d.p.y.toFixed(2), +d.p.z.toFixed(2)]);
      if (u.length >= 30) break;
    }
    return u;
  };
  net.pushDrops = () => {                       // WS 模式直接发；轮询模式走 sync 附带（见 net.tick）
    const u = net.dropList();
    net.dropCache = u;
    if (net.ws && net.ws.readyState === 1) { try { net.ws.send(JSON.stringify({ t: 'd', u })); } catch (e) {} }
  };

  /* ---------- 应用服务端方块 ---------- */
  function applyServerBlock(x, y, z, b) {
    net.applying = true;
    try { setBlock(x, y, z, b, false); } finally { net.applying = false; }
    edits.set(x + ',' + y + ',' + z, b);        // 内存编辑表：区块卸载再加载不会退回天然地形
    indexEdit(x, y, z, b);                       // 不写 localStorage —— 服务端才是权威
  }

  /* ---------- 本地编辑上行（乐观 + 失败回滚） ---------- */
  net.onLocalEdit = (x, y, z, id, prevId) => {
    const wsOk = !!(net.ws && net.ws.readyState === 1);
    if (!wsOk && !IS_BRIDGE) return;                  // 桥模式没有 ws，靠 sync 轮询把 pending 带上去
    const seq = ++net.seq;
    net.pending.set(seq, { x, y, z, prev: prevId, id });
    if (net.pending.size > 400) { const k = net.pending.keys().next().value; net.pending.delete(k); }
    net.editOut++;
    if (wsOk) { try { net.ws.send(JSON.stringify({ t: 'e', seq, x, y, z, b: id })); } catch (e) {} }
  };

  /* ---------- 网络 ---------- */
  function connect() {
    net.onMsg = (m) => {
      if (m.t === 'ok') {
        net.isHost = !!m.host; net.err = '';
        // 断线期间漏掉的编辑：补上（resync=true 时服务端给的是整表）
        for (const e of (m.missed || [])) applyServerBlock(e[0], e[1], e[2], e[3]);
        if (typeof m.seq === 'number') net.serverSeq = m.seq;
        // 断线时还在 pending 的编辑重新推一遍（否则这几刀永久丢失）
        const again = Array.from(net.pending.values());
        net.pending.clear();
        for (const p0 of again) {
          const seq2 = ++net.seq;
          net.pending.set(seq2, p0);
          try { net.ws.send(JSON.stringify({ t: 'e', seq: seq2, x: p0.x, y: p0.y, z: p0.z, b: p0.id })); } catch (e) {}
        }
        if (again.length) toast(`重连：补发 ${again.length} 个未确认的改动`, 2.2);
      }
      else if (m.t === 'p') {
        net.snaps++; net.lastSnap = performance.now();
        for (const p of (m.u || [])) {
          if (p.i === net.id) continue;
          const r = ensureRemote(p);
          const u = r.obj.userData;
          u.flags = p.f | 0; u.pitch = +p.q || 0;      // 挖掘/疾跑/腾空 状态位 + 俯仰
          // ★ 快照进缓冲，不直接当目标位置：渲染时往回退一段（按实测间隔自适应）在两帧之间插值，
          //   这样 8~12Hz 的网络数据也能变成 60fps 连续运动（A&S 那种顺滑的关键）
          const tNow = performance.now();
          const lastSnap = u.buf[u.buf.length - 1];
          if (lastSnap) {
            const gap = tNow - lastSnap.t;
            if (gap > 10 && gap < 600) u.gap = u.gap ? u.gap * 0.75 + gap * 0.25 : gap;   // 快照间隔 EMA
          }
          u.lastSnapT = tNow;
          u.buf.push({ t: tNow, x: p.x, y: p.y, z: p.z, yaw: p.w, pitch: +p.q || 0, f: p.f | 0 });
          if (u.buf.length > 10) u.buf.shift();
        }
        const alive = new Set((m.u || []).map(x => x.i));
        for (const id of Array.from(net.remotes.keys())) {
          if (alive.has(id)) continue;
          const nm = (net.remotes.get(id) || {}).name || id;
          dropRemote(id);
          toast(`${nm} 离开了房间`, 2.5);
        }
        if (frOpen) renderLobby();
        if (typeof m.time === 'number') worldTime = m.time;
        const wasHost = net.isHost;
        net.isHost = (m.host === net.id);
        // ★ 主机迁移：原主机掉线后本端接管，必须清掉手里的「幽灵怪」——
        //   否则它们会和本端新模拟的真怪叠在一起（实测迁移后 B 端同时有 5 个幽灵 + 自己的真怪）。
        if (net.isHost && !wasHost && net.ghosts.size) {
          for (const [, g] of Array.from(net.ghosts)) { scene.remove(g.obj); }
          net.ghosts.clear();
          // 掉落物幽灵同样要清：否则接管瞬间「旧幽灵 + 新真掉落物」叠在一起（和怪是同一族 bug）
          for (const [, g] of Array.from(net.dropGhosts)) { scene.remove(g.obj); }
          net.dropGhosts.clear();
          toast('你接管了世界主机：怪物改由你模拟', 3);
        }
      } else if (m.t === 'e') {
        if (typeof m.q === 'number') net.serverSeq = m.q;
        applyServerBlock(m.x, m.y, m.z, m.b);
      } else if (m.t === 'hit') {
        if (net.isHost) {                          // 只有主机的怪是真的
          for (const mo of (typeof mobs !== 'undefined' ? mobs : [])) {
            if (mo.nid === m.i && !mo.dying) {
              mo.hp -= (m.d || 1); mo.flash = 0.2; mo.aggro = 16;
              if (mo.hp <= 0) startMobDeath(mo);
              break;
            }
          }
        }
      } else if (m.t === 'm') {
        syncGhosts(m.u || []);
      } else if (m.t === 'ch') {                  // 别人改了这个箱子：同表覆盖
        if (m.k) {
          chestInv.set(m.k, m.slots);
          const openK = openChestPos ? (openChestPos.x + ',' + openChestPos.y + ',' + openChestPos.z) : '';
          if (openK === m.k) { renderChest(); toast('箱子内容已同步', 1.4); }
        }
      } else if (m.t === 'd') {
        net.syncDropGhosts(m.u || []);
      } else if (m.t === 'drop') {                // 客人挖出的掉落物：主机这里生成真的（沿用他上报的 nid）
        const [nid, id, n, x, y, z] = m.u || [];
        if (net.isHost && nid && isItem(id) && n > 0 && !drops.some(d => d.nid === nid)) {
          spawnDrop(id, n, x, y + 0.2, z, { nid, fromHost: true });
        }
      } else if (m.t === 'pick') {
        const g = net.dropGhosts.get(m.i);
        if (g) { scene.remove(g.obj); net.dropGhosts.delete(m.i); }
        if (net.isHost) {                         // 主机手里那个掉落物真的删掉
          // 用字符串比较：客人上报的 nid 是 "g<pid>:<n>"，主机自己的是数字，类型不一致会漏删
          const di = drops.findIndex(x => String(x.nid) === String(m.i));
          if (di >= 0) { scene.remove(drops[di].obj); drops.splice(di, 1); }
          if (net.devOk) console.log('[bw] pick', m.i, 'di=', di, 'left=', drops.length);
        } else if (net.devOk) console.log('[bw] pick(guest)', m.i, 'ghost=', !!g);
      } else if (m.t === 'act') {                 // 别人的挥砍/放置：远端形象播一下
        const r = net.remotes.get(m.i);
        if (r && r.obj.userData) {
          r.obj.userData.swing = 0.4;
          r.obj.userData.swingType = m.a || 'attack';
        }
      } else if (m.t === 'ack') {
        net.pending.delete(m.seq);
      } else if (m.t === 'rej') {
        const p0 = net.pending.get(m.seq);
        net.pending.delete(m.seq);
        net.rejCount++;
        if (p0) applyServerBlock(p0.x, p0.y, p0.z, p0.prev);
        toast('服务端拒绝了这次改动：' + (m.e || ''), 1.6);
      } else if (m.t === 'req' || m.t === 'acc' || m.t === 'deny' || m.t === 'f' || m.t === 'inv') {
        net.onSocial(m);
      } else if (m.t === 'left') {
        dropRemote(m.i);
      } else if (m.t === 'err') {
        if (m.e === 'no_seat') { net.err = 'no_seat'; fetch(EP, { method: 'POST', headers: { 'content-type': 'text/plain' },
          body: JSON.stringify({ a: 'join', code: net.code, pid: net.id, name: net.nick }) })
          .then(r => r.json()).then(d2 => { if (d2.ok) { net.err = ''; reconnect(); } }).catch(() => {}); }
      }
    };
    if (IS_BRIDGE) { net.connected = true; net.err = ''; return; }   // 桥模式：靠 sync 轮询，不开 ws
    let ws;
    try { ws = new WebSocket(WSURL); } catch (e) { net.err = 'ws_bad_url'; return; }
    net.ws = ws;
    ws.onopen = () => {
      net.connected = true; net.err = '';
      ws.send(JSON.stringify({ t: 'hello', code: net.code, id: net.id, name: net.nick, since: net.serverSeq }));
    };
    ws.onclose = () => { net.connected = false; setTimeout(() => { if (net.active) connect(); }, 1500); };
    net.reconnect = () => { try { ws.close(); } catch (e) {} };
    ws.onerror = () => { net.err = 'ws_error'; };
    ws.onmessage = ev => {
      net.netBytes += ev.data.length;
      let mm; try { mm = JSON.parse(ev.data); } catch (e) { return; }
      net.onMsg(mm);
    };
  }

  /* ---------- HUD：数字长在界面上 ---------- */
  let hud = null;
  function drawHud() {
    if (!hud) {
      hud = document.createElement('div');
      hud.id = 'netHud';
      hud.style.cssText = 'position:fixed;left:50%;top:8px;transform:translateX(-50%);z-index:30;'
        + 'font:12px/1.5 ui-monospace,monospace;color:#cfe8ff;background:rgba(8,18,30,.72);'
        + 'border:1px solid rgba(120,200,255,.28);border-radius:8px;padding:4px 10px;pointer-events:none;white-space:nowrap';
      document.body.appendChild(hud);
    }
    // 远端渲染滞后（实测）：快照间隔 × 1.12，说明这一局"别人动起来有多跟手"
    let lagMax = 0;
    for (const r of net.remotes.values()) lagMax = Math.max(lagMax, r.obj.userData.lag || 0);
    hud.innerHTML = `<b style="color:${net.connected ? '#7ef0a0' : '#ff7a7a'}">${net.connected ? '●' : '○'}</b> `
      + `联机 ${net.code}${net.isHost ? ' · 主机' : ''} · <b>${net.rtt.toFixed(0)}ms</b> · 快照 ${net.snapHz.toFixed(0)}Hz · `
      + `待确认 <b style="color:${net.pending.size ? '#ffcf6b' : '#7ef0a0'}">${net.pending.size}</b> · `
      + `${net.mode === 'poll' ? ' · 轮询 ' + Math.round((net.pollEvery || 0.09) * 1000) + 'ms' : ' · WS'} 远端 ${net.remotes.size}${net.isHost ? '' : ' · 幽灵怪 ' + net.ghosts.size}`
      + ` · 滞后 ${Math.round(lagMax)}ms · 序号 ${net.serverSeq} · 上行编辑 ${net.editOut} · 被拒 ${net.rejCount}`
      + (net.err ? ` · <span style="color:#ff9a6b">${net.err}</span>` : '');
  }

  /* ---------- 每帧 ---------- */
  /* 远端渲染延迟插值：把 8~10Hz 的快照缓冲起来，渲染时间往回退 130ms 在两帧之间取插值。
   * 这一条是「丝滑」的最大来源 —— 位置/朝向变成连续函数，网络抖动不会传到画面上。 */
  const REM_LAG = 130;
  const HEAD_PITCH_SIGN = 1;   // 远端抬头/低头方向：实测（模型正面 -Z）正号 = 抬头；看着反了就改成 -1
  net.sampleRemote = (u, nowMs) => {
    const b = u.buf;
    if (!b || !b.length) return null;
    if (b.length === 1) {
      const q0 = b[0];
      return { x: q0.x, y: q0.y, z: q0.z, yaw: q0.yaw, pitch: q0.pitch, f: q0.f, spd: 0 };
    }
    // 渲染滞后按「实测快照间隔」自适应：间隔大（网络慢）就多等一点保证有插值帧，间隔小就少等，直接降延迟
    const lag = u.lag = Math.min(190, Math.max(70, (u.gap || 110) * 1.12));
    const tgt = nowMs - lag;
    let i = b.length - 1;
    while (i > 0 && b[i].t > tgt) i--;
    const a = b[i], c = b[Math.min(b.length - 1, i + 1)];
    const span = Math.max(1, c.t - a.t);
    let f = (tgt - a.t) / span;
    if (!isFinite(f)) f = 1;
    // 丢包时最多外推 30%；如果渲染时刻已经超出最后一条快照太多（>220ms），冻结在最后一条，
    // 否则外推久了会"冲出去再被拉回来"，就是玩家说的「像传送」。
    const hole = tgt - c.t;
    f = hole > 220 ? 1 : Math.max(0, Math.min(1.3, f));
    let dyw = c.yaw - a.yaw;
    while (dyw > Math.PI) dyw -= Math.PI * 2;
    while (dyw < -Math.PI) dyw += Math.PI * 2;
    return {
      x: a.x + (c.x - a.x) * f, y: a.y + (c.y - a.y) * f, z: a.z + (c.z - a.z) * f,
      yaw: a.yaw + dyw * f, pitch: a.pitch + (c.pitch - a.pitch) * f, f: a.f,
      spd: Math.hypot(c.x - a.x, c.z - a.z) / (span / 1000),
    };
  };

  net.tick = (dt) => {
    const nowMs = performance.now();
    net.sendT += dt;
    if (!IS_BRIDGE && net.sendT >= 0.1 && net.ws && net.ws.readyState === 1) {
      net.sendT = 0;
      try {
        net.ws.send(JSON.stringify({ t: 'p', x: +player.p.x.toFixed(2), y: +player.p.y.toFixed(2), z: +player.p.z.toFixed(2), w: +player.yaw.toFixed(2), q: +player.pitch.toFixed(2), f: net.myFlags() }));
      } catch (e) {}
    }
    // ── 公网轮询模式：一个请求同时上传位置/编辑、取回消息（~8Hz）
    if (IS_BRIDGE) {
      net.pollT += dt;
      if (net.inFlight && performance.now() - (net.inFlightAt || 0) > 800) net.inFlight = false;   // 兜底：卡死的请求别把整条链路堵住
      if (net.pollT >= (net.pollEvery || 0.09) && !net.inFlight) {   // 节拍自适应：桥慢就别堆请求，桥快就压到 60ms 降延迟
        net.pollT = 0;
        net.inFlight = true; net.inFlightAt = performance.now();
        const reqT0 = net.inFlightAt;
        // ★ 只发「还没发过 / 超过 1.5s 没被 ack」的编辑。以前每个 tick 把全部 pending 原样重发一遍，
        //   8Hz × 在飞的编辑数 很容易顶到服务端 25 次/秒的上限（applyEdit 按**调用次数**计数）→ 被拒 → 客户端回滚，
        //   表现就是公网模式下「挖掉/放下的方块自己弹回来」。
        const nowMs = Date.now();
        const pend = [];
        for (const [seq, p0] of net.pending) {
          if (p0.nextAt && nowMs < p0.nextAt) continue;
          p0.nextAt = nowMs + 1500;
          pend.push({ seq, x: p0.x, y: p0.y, z: p0.z, b: p0.id });
          if (pend.length >= 20) break;
        }
        // 桥请求必须有超时：偶尔一次 PHP 卡 2 秒会把整条链路堵住（表现就是"位置停一下再瞬移"）
        const ctl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
        const toT = setTimeout(() => { try { if (ctl) ctl.abort(); } catch (e) {} }, 2000);
        fetch(EP, { method: 'POST', headers: { 'content-type': 'text/plain' }, signal: ctl ? ctl.signal : undefined, body: JSON.stringify(Object.assign({
          a: 'sync', code: net.code, pid: net.id, name: net.nick,
          x: +player.p.x.toFixed(2), y: +player.p.y.toFixed(2), z: +player.p.z.toFixed(2),
          w: +player.yaw.toFixed(2), q: +player.pitch.toFixed(2), edits: pend, f: net.myFlags(),
        }, net.isHost ? { mobs: net.mobCache || [], drops: net.dropCache || [] } : {})) }).then(r => r.json()).then(d => {
          if (!d.ok) { net.err = d.e || 'sync'; net.connected = false; return; }
          net.connected = true; net.err = ''; net.syncs++;
          if (typeof d.seq === 'number') net.serverSeq = d.seq;
          net.isHost = (d.host === net.id);
          for (const s of (d.ack || [])) {
            if (s > 0) net.pending.delete(s);
            else { const p1 = net.pending.get(-s); net.pending.delete(-s); net.rejCount++; if (p1) applyServerBlock(p1.x, p1.y, p1.z, p1.prev); }
          }
          for (const m of (d.out || [])) net.onMsg(m);
        }).catch((e2) => {
          if (!(e2 && e2.name === 'AbortError')) { net.connected = false; net.err = 'net'; }
        }).finally(() => {
          clearTimeout(toT);
          net.inFlight = false;
          // ★ 别用 performance.now() 前后差算 RTT：无头页面里那测到的是「事件循环 + 渲染帧」，
          //   实测 10ms 的请求会被量成 1800ms。取 Resource Timing 的 duration 才是真实耗时。
          try {
            const es = performance.getEntriesByType('resource').filter(en => en.name.indexOf(EP) >= 0 && en.name.indexOf('?t=') < 0);
            const last = es[es.length - 1];
            if (last && last.duration > 0) {
              net.pollRtt = net.pollRtt ? net.pollRtt * 0.7 + last.duration * 0.3 : last.duration;
              // 节拍 = RTT 的 0.9 倍，夹在 60~200ms：桥快就多问几次（降延迟），桥慢就少问（不加剧拥塞）
              net.pollEvery = Math.min(0.2, Math.max(0.06, (net.pollRtt * 0.9) / 1000));
            }
          } catch (e3) {}
        });
      }
    }

    // 主机每 0.15s 生成一次怪快照（WS 直接发；轮询模式挂在 sync 请求上，见下方 poll 分支）
    if (net.isHost) {
      net.mobT += dt;
      if (net.mobT >= 0.15) {
        net.mobT = 0;
        const u = [];
        for (const m of (typeof mobs !== 'undefined' ? mobs : [])) {
          if (m.dying || m.hp <= 0 || !m.obj) continue;
          m.nid = m.nid || (net.mobSeq = (net.mobSeq || 0) + 1);
          u.push([m.nid, m.kind, +m.p.x.toFixed(2), +m.p.y.toFixed(2), +m.p.z.toFixed(2), +m.obj.rotation.y.toFixed(2), Math.round(m.hp)]);
          if (u.length >= 24) break;
        }
        net.mobCache = u;
        if (net.ws && net.ws.readyState === 1) { try { net.ws.send(JSON.stringify({ t: 'm', u })); } catch (e) {} }
      }
    }
    const kG = Math.min(1, dt * 10);
    for (const g of net.ghosts.values()) {
      g.obj.position.x += (g.tx - g.obj.position.x) * kG;
      g.obj.position.y += (g.ty - g.obj.position.y) * kG;
      g.obj.position.z += (g.tz - g.obj.position.z) * kG;
      let dg = g.rot - g.obj.rotation.y;
      while (dg > Math.PI) dg -= Math.PI * 2;
      while (dg < -Math.PI) dg += Math.PI * 2;
      g.obj.rotation.y += dg * kG;
    }
    for (const r of net.remotes.values()) {
      const u = r.obj.userData;
      const s = net.sampleRemote(u, nowMs);
      if (!s) continue;
      // 位置直接用缓冲插值结果（它本身已经连续，再 lerp 只是白加延迟）
      r.obj.position.set(s.x, s.y, s.z);
      let dy = s.yaw - r.obj.rotation.y;
      while (dy > Math.PI) dy -= Math.PI * 2;
      while (dy < -Math.PI) dy += Math.PI * 2;
      r.obj.rotation.y += dy * Math.min(1, dt * 22);
      const yawRate = dy / Math.max(dt, 1e-3);

      /* ── 远端玩家的动作（别人能看到的动画）
       * 只有位置/朝向是网络同步的，四肢的动作全部由「位移速度 + 状态位 + 一次性能量」本地推算：
       *   走路/疾跑 → 摆臂甩腿 + 身体起伏；挖掘位 → 前臂连续凿；挥砍事件 → 整条胳膊抡一下；
       *   腾空位 → 收腿抬臂。这样只多 1 个字节的状态位，不用为每个动作都发消息。 */
      // 速度用「两帧快照」算，而不是逐帧位置差 —— 网络抖一下不会让腿抽
      u.spd += (s.spd - u.spd) * Math.min(1, dt * 12);
      const walkAmt = clamp01(u.spd / CFG.WALK);
      u.sprintK += (clamp01((u.spd - CFG.WALK * 0.9) / Math.max(0.1, CFG.SPRINT - CFG.WALK * 0.9)) - u.sprintK) * Math.min(1, dt * 6);
      const airNow = (s.f & 4) ? 1 : 0;
      if (u.airPrev === 1 && airNow === 0) u.landK = 1;      // 「腾空→着地」→ 落地缓冲
      u.airPrev = airNow;
      u.airK += (airNow - u.airK) * Math.min(1, dt * 9);
      u.mineK += (((s.f & 1) ? 1 : 0) - u.mineK) * Math.min(1, dt * 12);
      u.landK = Math.max(0, u.landK - dt * 3.4);
      u.walk += dt * (6 + 9 * u.sprintK) * (walkAmt > 0.04 ? 1 : 0);
      const stride = Math.sin(u.walk);
      const airK = u.airK, landK = u.landK;

      /* 所有动作先「叠加成目标角度」，再用阻尼追上去。
       * 直接赋值的话，动作切换/丢包那一帧肢体就会硬跳；阻尼追随让每根骨头都是有质量的。 */
      const legLT = stride * 0.62 * walkAmt * (1 - airK * 0.7) - airK * 0.35 + landK * 0.25;
      const legRT = -stride * 0.62 * walkAmt * (1 - airK * 0.7) + airK * 0.20 + landK * 0.25;
      const armSwing = stride * (0.50 + 0.35 * u.sprintK) * walkAmt;
      const armLT = -armSwing - airK * 0.45 - landK * 0.20;
      let armRT = armSwing - airK * 0.30 - landK * 0.25;
      let foreRT = 0;
      if (u.swing > 0) {
        u.swing = Math.max(0, u.swing - dt);
        const a = Math.sin(clamp01(1 - u.swing / 0.4) * Math.PI);
        // ★ 符号：armR.rotation.x 为正是「手往前甩」（模型正面是 -Z，实测 hand.z 从 0 → -0.25）。
        //   以前这里写成负号，等于整条胳膊往背后抡 —— 玩家看到的就是"动作全反了"。
        armRT += a * (u.swingType === 'place' ? 0.55 : 1.25);
        foreRT += a * (u.swingType === 'place' ? 0.30 : 0.75);
      }
      if (u.mineK > 0.02) {
        const a = Math.sin((((nowMs / 1000) * 2.2) % 1) * Math.PI);
        armRT += a * 0.95 * u.mineK;
        foreRT += a * 0.85 * u.mineK;
      }
      if (walkAmt < 0.04 && u.mineK < 0.02 && u.swing <= 0) armRT += Math.sin(nowMs / 900 + u.phase) * 0.03;
      // 阻尼频率：前臂最快、腿最慢 —— 看起来有质量差
      const dampA = 1 - Math.exp(-30 * dt), dampF = 1 - Math.exp(-36 * dt), dampL = 1 - Math.exp(-24 * dt);
      u.armL.rotation.x += (armLT - u.armL.rotation.x) * dampA;
      u.armR.rotation.x += (armRT - u.armR.rotation.x) * dampA;
      u.foreR.rotation.x += (foreRT - u.foreR.rotation.x) * dampF;
      u.legL.rotation.x += (legLT - u.legL.rotation.x) * dampL;
      u.legR.rotation.x += (legRT - u.legR.rotation.x) * dampL;
      // 转身惯性：快速左右转身时身体轻微侧倾（A&S 里很明显的一个细节）
      const rollT = clamp(-yawRate * 0.05, -0.07, 0.07);
      r.obj.rotation.z += (rollT - r.obj.rotation.z) * Math.min(1, dt * 10);
      // 身体：疾跑前倾 + 走路起伏 + 落地屈膝压身 + 头随俯仰点头
      u.torso.rotation.x = u.sprintK * 0.12 + landK * 0.10;
      const bobY = Math.abs(stride) * 0.02 * walkAmt - landK * 0.05;
      u.torso.position.y = 1.06 + bobY;
      u.head.position.y = 1.62 + bobY * 0.8;
      u.head.rotation.x = HEAD_PITCH_SIGN * clamp((u.pitch || 0) * 0.45, -0.55, 0.55);
    }
    // 主机每 0.2s 广播掉落物；客人每 5s 把背包存回服务端
    net.dropT = (net.dropT || 0) + dt;
    if (net.dropT >= 0.2) { net.dropT = 0; if (net.isHost) net.pushDrops(); }
    net.invT = (net.invT || 0) + dt;
    if (net.invT >= 5) { net.invT = 0; if (!net.lid && net.active) net.pushInv(); }
    net.pullT += dt;
    if (net.pullT >= 2) {
      net.pullT = 0;
      if (Math.hypot(player.p.x - net.lastPull.x, player.p.z - net.lastPull.z) > 48) net.pullRegion();
    }
    net.hudT += dt;
    if (net.hudT >= 0.5) {
      net.hudT = 0;
      const now = performance.now();
      const el = Math.max(0.5, (now - (net.hzT || now - 500)) / 1000);
      net.snapHz = Math.min(30, net.snaps / el);      // 夹上限：被节流的后台页会算出 40+ 的假频率
      net.snaps = 0; net.hzT = now;
      drawHud();
    }
    net.pingT += dt;
    if (net.pingT >= 2) {
      net.pingT = 0;
      // ★ RTT 必须取 Resource Timing 的 duration：用 performance.now() 前后差测到的是
      //   「事件循环 + 渲染帧」，实测会把 3ms 的本地往返量成 2399ms（这个坑我在大乱斗里踩过一次）。
      const tag = Date.now();
      fetch(EP + '?t=' + tag, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: JSON.stringify({ a: 'ping' }) })
        .then(r => r.text()).then(() => {
          // 桥模式下 URL 是 bwmp.php?t=…，所以按 ?t= 数字匹配（以前只匹配 /api?t= → 桥模式永远显示 0ms）
          const es = performance.getEntriesByType('resource').filter(e => /[?&]t=\d+/.test(e.name));
          const e = es[es.length - 1];
          net.rtt = e ? e.duration : 0;
        }).catch(() => { net.rtt = -1; });
    }
  };

  /* ---------- 进服 ----------
   * 客人：join 拿 seed → 用同一个 seed 生成同一片地形。
   * 房主：host 把「我现在这个单机世界」的 seed + 已有改动上传成房间，然后 startGame(自己的世界) ——
   *       开房后地形/背包/建筑原样还在，接着玩；房间码跟世界绑死，明天再开还是同一个房间。 */
  const isHostMode = q.get('host') === '1' && !!q.get('lid');
  net.lid = isHostMode ? String(q.get('lid')) : '';
  const hostMeta = net.lid ? worldMeta(net.lid) : null;
  const hostSeed = hostMeta ? (hostMeta.seed | 0) : 0;

  // 开房后把这个世界的已有改动分批同步进房间（服务端幂等合并，重复开房不会翻倍）
  function uploadMyWorld() {
    const pairs = Array.from(edits.entries());
    let i = 0, added = 0;
    const CH = 800;
    const step = () => {
      if (i >= pairs.length) {
        if (pairs.length) toast(`房间已载入你世界里的 ${pairs.length} 处改动`, 3.5);
        return;
      }
      const chunk = pairs.slice(i, i + CH); i += CH;
      fetch(EP, { method: 'POST', headers: { 'content-type': 'text/plain' },
        body: JSON.stringify({ a: 'host', code: net.code, pid: net.id, name: net.nick, chunk: true, edits: chunk }) })
        .then(r => r.json()).then(d => { if (d && d.ok) added += d.added || 0; setTimeout(step, 30); })
        .catch(() => setTimeout(step, 500));
    };
    if (pairs.length) step();
  }

  fetch(EP, {
    method: 'POST', headers: { 'content-type': 'text/plain' },
    body: JSON.stringify(isHostMode
      ? { a: 'host', code: net.code, pid: net.id, name: net.nick, seed: hostSeed, x: 0, z: 0, r: 128 }
      : { a: 'join', code: net.code, pid: net.id, name: net.nick, x: 0, z: 0, r: 128 }),
  }).then(r => r.json()).then(d => {
    // 进服后把 URL 洗干净：否则「世界」按钮 reload / 刷新 / iOS 恢复标签页都会再自动 join 一次
    const cleanUrl = () => { try { history.replaceState(null, '', location.pathname); } catch (e) {} };
    if (!d.ok) {
      net.active = false; cleanUrl();
      toast(d.e === 'seed_mismatch' ? '这个房间码已经被别的存档占了，换个世界再开房' : ('联机进服失败：' + (d.e || '?')), 6);
      if (window.__bwWireEntry) window.__bwWireEntry();
      return;
    }
    cleanUrl();
    if (d.id && d.id !== net.id) { net.id = d.id; toast('昵称被占用了，你在房间里叫 ' + d.id, 4); }
    if (!isHostMode) { try { localStorage.setItem('bw_world', net.code); } catch (e) {} }
    net.isHost = !!d.isHost;
    // 房主：开「我自己那个世界」的存档（seed 相同 → 地形/背包/建筑原样带进房间）
    const w = (isHostMode && hostMeta)
      ? hostMeta
      : { id: 'mp_' + net.code, name: '联机房间 ' + net.code, seed: d.seed | 0, mode: 'survival' };
    startGame(w);
    for (const [k, id] of (d.edits || [])) {
      const a = k.split(',').map(Number);
      edits.set(k, id); indexEdit(a[0], a[1], a[2], id);
    }
    // ★ 进服包里带的改动必须作用到「已经生成的区块」上：startGame 已经把出生点周围 5×5 区块建好了，
    //   只写 edits/indexEdit 只影响**之后**生成的区块 —— 结果是「别人挖过的洞，你进服时看不到」。
    //   做法：清掉区块缓存（genChunk 会重新生成并自动套用 editsByChunk），再标记重建。
    if ((d.edits || []).length) {
      for (const [k2, cc] of Array.from(chunks)) {
        if (cc.mesh) scene.remove(cc.mesh);
        if (cc.glass) scene.remove(cc.glass);
        if (cc.water) scene.remove(cc.water);
        if (cc.plant) scene.remove(cc.plant);
        chunks.delete(k2);
      }
      const c0x = Math.floor(player.p.x / CFG.CH), c0z = Math.floor(player.p.z / CFG.CH);
      for (let dx = -2; dx <= 2; dx++) for (let dz = -2; dz <= 2; dz++) dirty.add(getChunk(c0x + dx, c0z + dz));
    }
    for (const pl of (d.players || [])) if (pl.i !== net.id) ensureRemote(pl);
    // ★ 客人进房：优先回到「你上次在这个房间里的位置/朝向」；
    //   只有第一次进房（服务端没有你的记录）才落到房主旁边，免得两人叠在出生点互相看不见。
    if (!isHostMode) {
      if (d.pos && typeof d.pos.x === 'number') {
        player.p.set(d.pos.x, d.pos.y, d.pos.z);
        if (typeof d.pos.w === 'number') player.yaw = d.pos.w;
        if (typeof d.pos.q === 'number') player.pitch = d.pos.q;
        // 万一这个位置后来被别人盖了方块埋住：就近往上找一个能站的地方
        const bx = Math.floor(player.p.x), bz = Math.floor(player.p.z);
        const solid = (y) => isSolid(getBlock(bx, y, bz)) || isSolid(getBlock(bx, y + 1, bz));
        let by = Math.floor(player.p.y);
        if (solid(by)) {
          for (let i = 0; i < 24 && solid(by); i++) by++;
          player.p.y = by + 0.05;
        }
        toast('回到你上次在房间里的位置', 2.5);
      } else {
        const others = (d.players || []).filter(p => p.i !== net.id);
        if (others.length) {
          const o = others[0];
          player.p.set(o.x + 1.8, o.y + 0.1, o.z + 1.8);
          toast('已站在 ' + (o.n || '房主') + ' 旁边', 3);
        }
      }
    }
    if (typeof d.time === 'number') worldTime = d.time;
    connect();
    if (isHostMode) uploadMyWorld();
    else setTimeout(() => net.pullInv(), 400);        // 客人：把上次在这个房间的背包取回来
    toast(`联机「${net.code}」· ${net.isHost ? '你是房主' : '已加入'} · 玩家 ${(d.players || []).length}`, 4);   // join 返回的列表已包含自己
  }).catch(e => {
    net.active = false;
    try { history.replaceState(null, '', location.pathname); } catch (e2) {}
    toast('联机服务器连不上：' + e.message, 6);
    if (window.__bwWireEntry) window.__bwWireEntry();       // 连不上 → 退回单机入口，别让按钮点了没反应
  });

  const btnFR = document.getElementById('btnFriends');
  /* ---------------- 好友 / 申请加入 ---------------- */
  const apiCall = (obj) => fetch(EP, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: JSON.stringify(obj) }).then(r => r.json());
  let frPanel = null, frOpen = false, frReq = [], frForceOpen = false, frInv = [];
  const frSeen = new Set();                       // 已提示过的申请：acct 心跳每 20s 重复回同一批 req，不能每次都弹面板
  const PCB = 'background:#0e1a28;color:#d8ecff;border:1px solid #2a4a66;border-radius:6px;padding:4px 6px;font:12px ui-monospace,monospace';

  function ensureFriendsUI() {
    if (frPanel) return;
    const btn = document.getElementById('btnFriends');
    if (btn) {
      btn.style.display = '';
      btn.onclick = () => { frOpen = !frOpen; frPanel.style.display = frOpen ? 'block' : 'none'; if (frOpen) net.friendsPull(); };
    }
    frPanel = document.createElement('div');
    frPanel.id = 'friendPanel';
    frPanel.style.cssText = 'position:fixed;right:10px;top:44px;z-index:40;display:none;width:300px;max-height:70vh;overflow:auto;'
      + 'font:12px/1.6 ui-monospace,monospace;color:#d8ecff;background:rgba(9,20,32,.94);'
      + 'border:1px solid rgba(120,200,255,.35);border-radius:10px;padding:10px 12px;box-shadow:0 8px 24px rgba(0,0,0,.45)';
    frPanel.innerHTML = '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">'
      + '<b style="color:#8fe3ff">联机</b><span id="frWho" style="color:#8ea3ba"></span></div>'
      + '<div id="lbState" style="background:rgba(120,200,255,.08);border-radius:8px;padding:6px 8px;margin-bottom:8px;line-height:1.5"></div>'
      + '<div id="lbInv" style="margin-bottom:6px"></div>'
      + '<div id="lbPlayers" style="margin-bottom:8px"></div>'
      + '<div id="lbActions" style="display:flex;gap:6px;margin-bottom:6px"></div>'
      + '<div style="display:flex;gap:6px;margin-bottom:8px">'
      + '<input id="lbCode" maxlength="12" placeholder="房间码（好友发你的）" style="flex:1;min-width:0;' + PCB + '">'
      + '<button class="btn" data-act="joinCode" style="padding:3px 8px">加入</button></div>'
      + '<div style="display:flex;gap:6px;margin-bottom:8px">'
      + '<input id="frName" maxlength="14" placeholder="好友昵称" style="flex:1;min-width:0;' + PCB + '">'
      + '<button class="btn" id="frAdd" style="padding:3px 8px">加好友</button></div>'
      + '<div id="frMsg" style="color:#ffcf6b;font-size:11px;min-height:14px;margin-bottom:6px"></div>'
      + '<div id="frReq"></div><div id="frList" style="color:#8ea3ba">加载中…</div>';
    document.body.appendChild(frPanel);
    frPanel.querySelector('#frAdd').onclick = () => {
      const el = frPanel.querySelector('#frName');
      const target = (el.value || '').trim();
      if (!target) return;
      apiCall({ a: 'fadd', pid: net.id, nick: net.nick, code: net.code, target }).then(d => {
        frMsg(d.ok ? `已加好友：${d.friend.nick}${d.friend.online ? '（在线）' : '（离线）'}` : '加好友失败：' + d.e);
        if (d.ok) { el.value = ''; net.friendsPull(); }
      }).catch(() => frMsg('网络错误'));
    };
    frPanel.addEventListener('click', ev => {
      const b = ev.target.closest('button[data-act]');
      if (!b) return;
      const act = b.dataset.act;
      if (act === 'join') {
        apiCall({ a: 'jreq', pid: net.id, nick: net.nick, code: net.code, to: b.dataset.pid }).then(d => {
          frMsg(d.ok ? '已发送申请，等对方同意…' : ({ offline: '对方不在线', not_friend: '还不是好友' }[d.e] || '申请失败：' + d.e));
        }).catch(() => frMsg('网络错误'));
      } else if (act === 'acc' || act === 'deny') {
        apiCall({ a: 'jres', pid: net.id, nick: net.nick, code: net.code, from: b.dataset.from, ok: act === 'acc' }).then(d => {
          if (d.ok) { frMsg(act === 'acc' ? '已同意，对方正在加入…' : '已拒绝'); frReq = frReq.filter(x => x.from !== b.dataset.from); renderReq(); }
        }).catch(() => frMsg('网络错误'));
      } else if (act === 'open') {
        frOpen = true; frPanel.style.display = 'block';
      } else if (act === 'leave') {
        net.leave();
      } else if (act === 'host') {
        hostRoom();
      } else if (act === 'copy') {
        copyInvite();
      } else if (act === 'joinCode') {
        const el = frPanel.querySelector('#lbCode');
        joinByCode(el && el.value);
      } else if (act === 'joinInv') {
        joinByCode(b.dataset.code);
      } else if (act === 'tp') {
        net.tpTo(b.dataset.id);
        renderLobby();
      } else if (act === 'invite') {
        apiCall({ a: 'invite', pid: net.id, nick: net.nick, code: net.code, to: b.dataset.pid })
          .then(d => frMsg(d.ok ? (d.pushed ? '邀请已发出，对方会看到「加入」按钮' : '邀请已发出（对方没在游戏里，下次上线能看到）')
                               : ({ not_friend: '还不是好友', no_room: '先开房再邀请' }[d.e] || ('邀请失败：' + d.e))))
          .catch(() => frMsg('网络错误'));
      }
    });
  }
  function frMsg(t) { const el = frPanel && frPanel.querySelector('#frMsg'); if (el) el.textContent = t; }

  /* ---------------- 联机面板：状态 / 玩家（名字+距离+传送）/ 开房·邀请·加入 ----------------
   * 用户要的流程：先在自己的世界里玩 → 点「开房」把这个世界变成房间 → 把房间码/邀请发给好友。
   * 房间码跟世界 id 绑死（存在世界 meta 里），所以同一个世界反复开房永远是同一个房间。 */
  const roomCodeOf = (w) => {
    if (!w) return '';
    if (!w.mpCode) {
      w.mpCode = 'R' + (Math.abs(hashString('room:' + w.id)) % 1679616).toString(36).toUpperCase().padStart(4, '0');
      const m = worldMeta(w.id);
      if (m) { m.mpCode = w.mpCode; saveIndex(); }
    }
    return w.mpCode;
  };
  function hostRoom() {
    if (net.active) return frMsg('已经在联机房间里了');
    if (!started) return frMsg('先回世界列表进一个世界，再开房');
    const w = worldMeta(currentId);
    if (!w) return frMsg('找不到当前世界的存档');
    const code = roomCodeOf(w);
    try { localStorage.setItem('bw_nick', net.nick); } catch (e) {}
    frMsg('正在开房 ' + code + ' …（把这个世界的方块上传到房间）');
    location.href = location.pathname + '?mp=1&go=1&host=1&lid=' + encodeURIComponent(w.id)
      + '&world=' + encodeURIComponent(code) + '&nick=' + encodeURIComponent(net.nick);
  }
  function joinByCode(code) {
    const c = String(code || '').trim().replace(/[^\w-]/g, '').toUpperCase();
    if (!c) return frMsg('先填房间码');
    if (net.active && c === net.code) return frMsg('你已经在这个房间里了');
    frMsg('正在进入房间 ' + c + ' …');
    setTimeout(() => {
      location.href = location.pathname + '?mp=1&go=1&world=' + encodeURIComponent(c) + '&nick=' + encodeURIComponent(net.nick);
    }, 300);
  }
  function copyInvite() {
    if (!net.active) return frMsg('先开房才有邀请链接');
    const link = location.origin + location.pathname + '?mp=1&go=1&world=' + encodeURIComponent(net.code);
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(link);
      else { const ta = document.createElement('textarea'); ta.value = link; document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove(); }
      frMsg('已复制邀请链接（房间 ' + net.code + '）：' + link);
    } catch (e) { frMsg('复制失败，手动发这句：房间码 ' + net.code + ' · ' + link); }
  }
  net.tpTo = (id) => {
    const r = net.remotes.get(id);
    if (!r) return false;
    const o = r.obj.position;
    player.p.set(o.x + 1.4, o.y + 0.6, o.z + 1.4);
    toast('已传送到 ' + (r.name || id) + ' 身边', 2);
    return true;
  };
  function renderLobby() {
    if (!frPanel) return;
    const st = frPanel.querySelector('#lbState'), ac = frPanel.querySelector('#lbActions');
    if (net.active) {
      if (st) st.innerHTML = '<div>联机中 · 房间 <b style="color:#8fe3ff;font-size:15px;letter-spacing:2px">' + escHtml(net.code) + '</b>'
        + (net.isHost ? ' <span style="color:#7ef0a0">房主</span>' : '') + '</div>'
        + '<div style="color:#8ea3ba">玩家 ' + (net.remotes.size + 1) + ' · ' + (net.connected ? '已连接' : '连接中断') + ' · ' + (net.rtt | 0) + 'ms'
        + (net.lid ? ' · 房间=你自己的世界，进度照常保存' : '') + '</div>';
      if (ac) ac.innerHTML = '<button class="btn" data-act="copy" style="flex:1;padding:4px 8px">复制邀请链接</button>'
        + '<button class="btn" data-act="leave" style="padding:4px 8px;color:#ffb0b0;border-color:#5a2b2b">退出联机</button>';
    } else {
      const w = currentId ? worldMeta(currentId) : null;
      if (st) st.innerHTML = '<div>当前：单机' + (w ? ' · 世界「' + escHtml(w.name) + '」' : ' · 世界列表') + '</div>'
        + '<div style="color:#8ea3ba">' + (started
          ? '点下面「开房」把这个世界变成联机房间，然后把房间码或邀请发给好友'
          : '先回世界列表进一个世界，再开房邀请好友') + '</div>';
      if (ac) ac.innerHTML = started
        ? '<button class="btn gold" data-act="host" style="flex:1;padding:4px 8px">开房：一起玩「' + escHtml((w && w.name) || '这个世界') + '」</button>'
        : '<span style="color:#7a8b9c;font-size:11px">进世界后才能开房 / 或者用下面的房间码加入好友</span>';
    }
    const iv = frPanel.querySelector('#lbInv');
    if (iv) iv.innerHTML = frInv.length ? frInv.map(v =>
      '<div style="display:flex;justify-content:space-between;align-items:center;gap:6px;margin-bottom:4px;color:#ffcf6b">'
      + '<span>' + escHtml(v.nick) + ' 邀请你进房间 <b>' + escHtml(v.code) + '</b></span>'
      + '<button class="btn" data-act="joinInv" data-code="' + escHtml(v.code) + '" style="padding:2px 7px">加入</button></div>').join('') : '';
    const pl = frPanel.querySelector('#lbPlayers');
    if (pl) {
      if (!net.active) pl.innerHTML = '';
      else {
        const rows = ['<div style="color:#7ef0a0;padding:2px 0">● ' + escHtml(net.nick) + ' · 你' + (net.isHost ? '（房主）' : '') + '</div>'];
        for (const [id, r] of net.remotes) {
          const o = r.obj.position;
          const d = Math.hypot(o.x - player.p.x, o.z - player.p.z) | 0;
          rows.push('<div style="display:flex;justify-content:space-between;align-items:center;gap:6px;padding:2px 0;border-top:1px solid rgba(120,200,255,.12)">'
            + '<span>● ' + escHtml(r.name || id) + ' · <b style="color:#8fe3ff">' + d + 'm</b></span>'
            + '<button class="btn" data-act="tp" data-id="' + escHtml(id) + '" style="padding:2px 7px">传送过去</button></div>');
        }
        pl.innerHTML = rows.join('');
      }
    }
    const who = frPanel.querySelector('#frWho');
    if (who) who.textContent = net.active ? (net.nick + ' · ' + net.code) : (net.nick || '');
  }
  function renderReq() {
    const el = frPanel && frPanel.querySelector('#frReq');
    if (!el) return;
    el.innerHTML = frReq.length
      ? '<div style="color:#ffcf6b;margin-bottom:4px">加入申请</div>' + frReq.map(r =>
          `<div style="display:flex;justify-content:space-between;align-items:center;gap:6px;margin-bottom:4px">
             <span>${r.nick} 想加入</span>
             <span><button class="btn" data-act="acc" data-from="${r.from}" style="padding:2px 7px">同意</button>
             <button class="btn" data-act="deny" data-from="${r.from}" style="padding:2px 7px">拒绝</button></span>
           </div>`).join('')
      : '';
  }
  function renderFriends(d) {
    ensureFriendsUI();
    if (Array.isArray(d.inv)) frInv = d.inv;
    renderLobby();
    if (Array.isArray(d.req) && d.req.length) {
      frReq = d.req;
      renderReq();
      const fresh = d.req.some(r => !frSeen.has(r.from + '@' + r.at));
      for (const r of d.req) frSeen.add(r.from + '@' + r.at);
      if (fresh || frForceOpen) {                 // 只在「来了新申请」时自动弹出（以前心跳也会重弹）
        frForceOpen = false;
        if (!frOpen) { frOpen = true; frPanel.style.display = 'block'; }
      }
    } else { renderReq(); }
    const list = frPanel.querySelector('#frList');
    if (!list) return;
    const fs2 = d.friends || [];
    list.innerHTML = fs2.length ? fs2.map(f =>
      `<div style="display:flex;justify-content:space-between;align-items:center;gap:6px;padding:3px 0;border-top:1px solid rgba(120,200,255,.12)">
         <span><b style="color:${f.online ? '#7ef0a0' : '#7a8b9c'}">${f.online ? '●' : '○'}</b> ${escHtml(f.nick)}
         <span style="color:#7a8b9c">${f.online ? (f.world ? '· 房间 ' + escHtml(f.world) : '· 在线') : '· 离线'}</span></span>
         ${net.active
            ? `<button class="btn" data-act="invite" data-pid="${escHtml(f.pid)}" style="padding:2px 7px">邀请</button>`
            : (f.online && f.world ? `<button class="btn" data-act="join" data-pid="${escHtml(f.pid)}" style="padding:2px 7px">申请加入</button>` : '')}
       </div>`).join('') : '<span style="color:#7a8b9c">还没有好友，上面输入对方的昵称加一个</span>';
  }
  net.friendsPull = () => apiCall({ a: 'friends', pid: net.id, nick: net.nick, code: net.code })
    .then(d => { if (d.ok) renderFriends(d); }).catch(() => {});
  net.heartbeat = () => apiCall({ a: 'acct', pid: net.id, nick: net.nick, code: net.code })
    .then(d => { if (d.ok) renderFriends(d); }).catch(() => {});

  // ws 推送：好友申请 / 对方同意 / 被拒绝 / 好友列表变了
  net.onSocial = (m) => {
    if (m.t === 'req') {
      frSeen.add(m.req.from + '@' + m.req.at);
      frReq = [m.req]; ensureFriendsUI(); renderReq(); frForceOpen = true;
      net.friendsPull();                       // 拉一次完整列表（以前这里拿 friends:[] 渲染，好友列表会被清空成"还没有好友"）
      toast(`${m.req.nick} 申请加入你的世界`, 4);
    }
    else if (m.t === 'acc') {
      if (m.code === net.code) { toast(`${m.nick} 同意了你加入「${m.code}」——你已经在这个世界里了`, 3); return; }
      toast(`${m.nick} 同意了你加入「${m.code}」，正在进入…`, 3);
      const dev = q.has('dev') ? '&dev=1' : '';
      setTimeout(() => { location.href = location.pathname + '?mp=1&go=1&world=' + encodeURIComponent(m.code) + '&nick=' + encodeURIComponent(net.nick) + dev; }, 900);
    }
    else if (m.t === 'deny') toast(`${m.nick} 拒绝了你的加入申请`, 3);
    else if (m.t === 'inv') {                       // 房主邀请：面板自动弹出来，点「加入」就进他的房间
      frInv = frInv.filter(x => x.code !== m.code).concat([{ code: m.code, nick: m.nick, at: Date.now() }]);
      ensureFriendsUI(); renderLobby();
      if (!frOpen) { frOpen = true; frPanel.style.display = 'block'; }
      toast(`${m.nick} 邀请你进房间 ${m.code}（点「加入」）`, 6);
    }
    else if (m.t === 'f') { ensureFriendsUI(); net.friendsPull(); toast(`${m.nick} 把你加为好友`, 3); }
  };

  ensureFriendsUI();
  net.heartbeat();
  setInterval(() => { net.heartbeat(); }, 20000);              // 在线状态心跳
  setInterval(() => { if (frOpen) net.friendsPull(); }, 4000);  // 面板开着时刷列表
  setInterval(() => { if (frOpen && net.active) renderLobby(); }, 1000);   // 距离每秒刷新

  window.NET = net;
  if (btnFR) btnFR.style.display = '';
  // ★ 这里以前是 `mpBtn.style.display = 'none'`，但它在 IIFE 里同步执行 —— 只要 URL 带 ?mp=1
  //   （哪怕联机服务器根本连不上、人还停在开始界面），这个按钮就会「闪一下就消失」。
  //   改成：不隐藏，只在联机失败时让它变成「退回单机」的出口。
  const mpBtn = document.getElementById('btnMP');
  if (mpBtn) {
    mpBtn.onclick = () => {
      if (net.active) { toast('已经在联机里了', 2); return; }
      location.href = location.pathname;          // 联机没连上 → 退回单机（去掉 ?mp）
    };
  }



  // ★ 联机时关掉 GAME.debug：give/tp/setBlock/travel 都能被控制台随手调用，等于开挂按钮。
  //   注意这是「防手滑/防随手作弊」，真正的门槛在服务端（方块编辑校验）。?dev=1 只给我自己验收用。
  net.devOk = q.has('dev');
  if (!net.devOk && window.GAME && window.GAME.debug) {
    const stubbed = new Set(['give', 'tp', 'setBlock', 'travel', 'start', 'startCreative', 'startWorld',
      'createWorld', 'clearInv', 'equip', 'fly', 'setHp', 'steps', 'killMobs', 'spawnKind', 'spawnAt',
      'usePortal', 'openPress', 'pressN', 'processN', 'setTime', 'furnaceTick', 'chipBatch',
      'chargeStart', 'chargerTick', 'setCharge']);
    const kept = {};
    for (const k of Object.keys(window.GAME.debug)) {
      kept[k] = stubbed.has(k) ? (() => 'disabled_in_multiplayer') : window.GAME.debug[k];
    }
    window.GAME.debug = kept;
    console.warn('[bw] 联机模式：调试接口已关闭（加 ?dev=1 可解开，仅用于验收）');
  }
})();

/* ---------------- 好友入口（单机模式下也要看得见） ----------------
 * 之前「好友」按钮只在 ?mp=1 时由联机层显示，直接用 www.schoolexams.net/blockwild/ 打开是看不到的。
 * 现在单机模式也显示这个按钮，点开就是"好友 / 联机"入口：填昵称 → 探测服务器 → 进联机。 */
(function wireFriendsEntry() {
  const btn = document.getElementById('btnFriends');
  if (!btn) return;
  let panel = null, open = false;
  const defNick = (() => { try { return localStorage.getItem('bw_nick') || ''; } catch (e) { return ''; } })();
  const defWorld = (() => { try { return localStorage.getItem('bw_world') || ''; } catch (e) { return ''; } })();
  const inpCss = 'background:#0e1a28;color:#d8ecff;border:1px solid #2a4a66;border-radius:6px;padding:4px 6px;font:12px ui-monospace,monospace';
  const pickBase = () => {
    const LAN = /^(localhost|127\.|192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(location.hostname);
    return (location.protocol === 'https:' || !LAN)
      ? (location.pathname.replace(/[^/]*$/, '') + 'bwmp.php')
      : ('http://' + location.hostname + ':9203');
  };
  function build() {
    const pre = window.__bwPrefillMP || null;
    panel = document.createElement('div');
    panel.id = 'mpEntry';
    panel.style.cssText = 'position:fixed;right:10px;top:44px;z-index:40;width:300px;'
      + 'font:12px/1.6 ui-monospace,monospace;color:#d8ecff;background:rgba(9,20,32,.94);'
      + 'border:1px solid rgba(120,200,255,.35);border-radius:10px;padding:10px 12px;box-shadow:0 8px 24px rgba(0,0,0,.45)';
    const curW = currentId ? worldMeta(currentId) : null;
    panel.innerHTML = '<b style="color:#8fe3ff">联机</b>'
      + (started && curW
          ? '<div style="margin:6px 0 8px"><button class="btn gold" id="mpHost" style="width:100%;padding:5px 8px">开房：一起玩「' + escHtml(curW.name) + '」</button>'
            + '<div style="color:#8ea3ba;font-size:11px;margin-top:4px">把当前这个世界变成联机房间，好友能看到同一片地形和你的建筑</div></div>'
          : '<div style="color:#8ea3ba;margin:6px 0 8px">先回世界列表进一个世界，就能开房邀好友；也可以直接填房间码加入别人。</div>')
      + '<div style="display:flex;gap:6px;margin-bottom:6px"><input id="mpCode" maxlength="12" placeholder="房间码（空 = 我的世界）" value="'
      + escHtml(pre ? pre.code : defWorld) + '" style="flex:1;min-width:0;' + inpCss + '"></div>'
      + '<div style="display:flex;gap:6px"><input id="mpNick" maxlength="14" placeholder="你的昵称" value="'
      + escHtml(pre ? pre.nick : defNick) + '" style="flex:1;min-width:0;' + inpCss + '">'
      + '<button class="btn" id="mpGo" style="padding:3px 8px">加入房间</button></div>'
      + '<div id="mpHint" style="font-size:11px;color:#7a8b9c;margin-top:6px">'
      + (pre ? '这个链接要加入「' + escHtml(pre.code) + '」——点「加入房间」确认'
             : '开房后把房间码发给好友；好友填码点「加入房间」') + '</div>';
    document.body.appendChild(panel);
    const hostBtn = panel.querySelector('#mpHost');
    if (hostBtn) hostBtn.onclick = () => {
      const w = worldMeta(currentId);
      if (!w) return;
      if (!w.mpCode) {
        w.mpCode = 'R' + (Math.abs(hashString('room:' + w.id)) % 1679616).toString(36).toUpperCase().padStart(4, '0');
        const m = worldMeta(w.id); if (m) { m.mpCode = w.mpCode; saveIndex(); }
      }
      const nick2 = (panel.querySelector('#mpNick').value || '').trim() || defNick || ('P' + Math.random().toString(36).slice(2, 5));
      try { localStorage.setItem('bw_nick', nick2); } catch (e) {}
      location.href = location.pathname + '?mp=1&go=1&host=1&lid=' + encodeURIComponent(w.id)
        + '&world=' + encodeURIComponent(w.mpCode) + '&nick=' + encodeURIComponent(nick2);
    };
    panel.querySelector('#mpGo').onclick = () => {
      const el = panel.querySelector('#mpNick'), hint = panel.querySelector('#mpHint');
      const nick2 = (el.value || '').trim() || ('P' + Math.random().toString(36).slice(2, 5));
      const code = (panel.querySelector('#mpCode').value || '').trim().replace(/[^\w-]/g, '').toUpperCase().slice(0, 12);
      try {
        localStorage.setItem('bw_nick', nick2);
        if (code) localStorage.setItem('bw_world', code); else localStorage.removeItem('bw_world');
      } catch (e) {}
      const base = pickBase();
      hint.style.color = '#8ea3ba'; hint.textContent = '正在探测 ' + base + ' …';
      fetch(/[.]php/.test(base) ? base : (base + '/api'), { method: 'POST', headers: { 'content-type': 'text/plain' }, body: JSON.stringify({ a: 'ping' }) })
        .then(r => r.json()).then(d => {
          if (!d.ok) throw new Error('probe');
          hint.style.color = '#7ef0a0'; hint.textContent = '服务器在线，正在进入' + (code ? '「' + code + '」' : '你的世界') + '…';
          // go=1：这是玩家亲手点的「进入联机」，bootNet 才允许自动进服
          setTimeout(() => { location.href = location.pathname + '?mp=1&go=1&nick=' + encodeURIComponent(nick2) + (code ? '&world=' + encodeURIComponent(code) : ''); }, 400);
        }).catch(() => {
          hint.style.color = '#ff9a6b';
          hint.innerHTML = '连不上 <b>' + escHtml(base) + '</b><br>检查一下 NAS 上的联机守护进程（127.0.0.1:9203）是否在跑。<br>'
            + '<span style="color:#7a8b9c">局域网直连：http://192.168.50.3:5802/blockwild/?mp=1</span>';
        });
    };
  }
  const toggle = () => { if (!panel) build(); open = !open; panel.style.display = open ? 'block' : 'none'; };
  const init = () => {                                     // 单机（或联机失败）时把入口接上
    btn.style.display = '';
    btn.onclick = toggle;                                  // 游戏内右上角「好友」
    const startBtn = document.getElementById('btnMP');     // 开始界面「🌐 联机」
    if (startBtn) startBtn.onclick = toggle;
    // ★ 裸链接带世界码（?mp=1 但没有 go=1）：不自动进服，只把面板打开、预填世界码让人确认
    if (window.__bwPrefillMP && !open) { toggle(); }
  };
  window.__bwWireEntry = init;
  if (NET && NET.active) return;                            // 联机正常：顶部好友面板由 bootNet 接管
  init();
})();

requestAnimationFrame(frame);
