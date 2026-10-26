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
};
const ITEMS = {
  100: { name: '木镐', kind: 'pick' },
  101: { name: '石镐', kind: 'pick' },
  102: { name: '木剑', kind: 'sword', dmg: 5 },
  103: { name: '石剑', kind: 'sword', dmg: 7 },
  104: { name: '木棍', kind: 'mat' },
  105: { name: '苹果', kind: 'food', food: 4 },
};
const isItem = id => !!BLOCKS[id] || !!ITEMS[id];
const defOf = id => BLOCKS[id] || ITEMS[id];
const nameOf = id => (defOf(id) || { name: '?' }).name;

let atlasCanvas = null, atlasTex = null;
function makeAtlas() {
  const S = 16, N = 4, cv = document.createElement('canvas');
  cv.width = cv.height = S * N;
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
    g.drawImage(atlasCanvas, (t % 4) * 16, ((t / 4) | 0) * 16, 16, 16, 0, 0, S, S);
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
    const stone = id === 101;
    g.strokeStyle = '#b98a4e'; g.lineWidth = 4; g.lineCap = 'round';
    g.beginPath(); g.moveTo(9, 27); g.lineTo(21, 12); g.stroke();
    g.strokeStyle = stone ? '#9a9a9a' : '#c8a06a'; g.lineWidth = 5;
    g.beginPath(); g.moveTo(9, 9); g.quadraticCurveTo(20, 5, 27, 13); g.stroke();
  } else if (ITEMS[id] && ITEMS[id].kind === 'sword') { // 剑
    const stone = id === 103;
    g.strokeStyle = stone ? '#b9b9b9' : '#c8a06a'; g.lineWidth = 5; g.lineCap = 'round';
    g.beginPath(); g.moveTo(10, 25); g.lineTo(24, 7); g.stroke();
    g.strokeStyle = '#8d6534'; g.lineWidth = 4;
    g.beginPath(); g.moveTo(7, 21); g.lineTo(14, 28); g.stroke();
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

function treeAt(wx, wz) {
  if (h2(wx * 2.17 + 91, wz * 3.31 - 17) < 0.982) return null;
  const g = heightAt(wx, wz);
  if (g <= CFG.SEA + 1 || g >= 45) return null;
  return { g, h: 4 + ((h2(wx * 5.3, wz * 7.9) * 3) | 0) };
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
      if (y > 2 && y < h - 2 && id !== 4 && n3(wx * 0.075, y * 0.11, wz * 0.075) > 0.668) id = 0;  // 洞穴
      if (id) b[idx(lx, y, lz)] = id;
    }
    for (let y = Math.max(h + 1, 0); y <= SEA && y < WH; y++) b[idx(lx, y, lz)] = 5;  // 水
  }
  // 树（含 3 格 padding，跨区块不会断枝）
  for (let lx = -3; lx < CH + 3; lx++) for (let lz = -3; lz < CH + 3; lz++) {
    const wx = ox + lx, wz = oz + lz;
    const t = treeAt(wx, wz);
    if (!t) continue;
    const top = t.g + t.h;
    for (let y = 1; y <= t.h; y++) put(lx, t.g + y, lz, 6, false);
    for (let dy = -2; dy <= 1; dy++) {
      const r = dy <= -1 ? 2 : 1;
      for (let dx = -r; dx <= r; dx++) for (let dz = -r; dz <= r; dz++) {
        if (r > 1 && Math.abs(dx) === r && Math.abs(dz) === r) continue;
        put(lx + dx, top + dy, lz + dz, 7, true);
      }
    }
    put(lx, top + 2, lz, 7, true);
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
      const u0 = (t % 4) * 0.25 + 0.0015, v0 = 1 - (((t / 4) | 0) + 1) * 0.25 + 0.0015;
      const iu = 0.25 - 0.003, iv = 0.25 - 0.003;
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
  sel: 0, mining: 0, mineTarget: null,
};
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
  ent.onGround = false;
  for (let i = 0; i < steps; i++) {
    const sx = dx / steps, sy = dy / steps, sz = dz / steps;
    if (sx) { ent.p.x += sx; if (collides(ent.p.x, ent.p.y, ent.p.z)) { ent.p.x -= sx; ent.v.x = 0; } }
    if (sz) { ent.p.z += sz; if (collides(ent.p.x, ent.p.y, ent.p.z)) { ent.p.z -= sz; ent.v.z = 0; } }
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
  const arm = new THREE.Mesh(new THREE.BoxGeometry(0.135, 0.135, 0.46), skinMat);
  arm.position.z = -0.3;
  const sleeve = new THREE.Mesh(new THREE.BoxGeometry(0.165, 0.165, 0.2), sleeveMat);
  sleeve.position.z = -0.13;
  const cuff = new THREE.Mesh(new THREE.BoxGeometry(0.17, 0.17, 0.045), new THREE.MeshLambertMaterial({ color: 0x244f5a }));
  cuff.position.z = -0.235;
  const hand = new THREE.Mesh(new THREE.BoxGeometry(0.155, 0.155, 0.14), new THREE.MeshLambertMaterial({ color: 0xe0aa77 }));
  hand.position.z = -0.56;
  g.add(arm, sleeve, cuff, hand);
  return g;
}
const armR = makeArm(1), armL = makeArm(-1);
armR.position.set(0.3, -0.3, -0.26);
armR.rotation.set(-0.2, -0.34, 0.12);
armL.position.set(-0.3, -0.34, -0.24);
armL.rotation.set(-0.26, 0.4, -0.12);
handScene.add(armR, armL);

// 手持方块（右手），按当前选中方块换材质
const heldGroup = new THREE.Group();
heldGroup.position.set(0.01, -0.02, -0.54);
heldGroup.rotation.set(0.2, 0.6, 0.1);
armR.add(heldGroup);
let heldMesh = null, heldFor = -1;
const faceTexCache = new Map();
function blockFaceMat(tile) {
  if (faceTexCache.has(tile)) return faceTexCache.get(tile);
  const tx = atlasTex.clone();
  tx.needsUpdate = true;
  tx.repeat.set(0.25, 0.25);
  tx.offset.set((tile % 4) * 0.25, 1 - (((tile / 4) | 0) + 1) * 0.25);
  const m = new THREE.MeshLambertMaterial({ map: tx });
  faceTexCache.set(tile, m);
  return m;
}
function refreshHeld() {
  const h = held();
  const id = h && BLOCKS[h.id] ? h.id : -1;
  if (id === heldFor) return;
  heldFor = id;
  if (heldMesh) { heldGroup.remove(heldMesh); heldMesh.geometry.dispose(); heldMesh = null; }
  if (id < 0) return;
  const d = BLOCKS[id];
  const mats = [d.side, d.side, d.top, d.bottom ?? d.top, d.side, d.side].map(blockFaceMat);
  const geo = new THREE.BoxGeometry(0.2, 0.2, 0.2);
  heldMesh = new THREE.Mesh(geo, mats);
  heldMesh.rotation.set(0.1, 0.5, 0);
  heldGroup.add(heldMesh);
}

/* ============================================================ 音效 */
let AC = null;
function sfx(kind) {
  if (!AC) return;
  const t = AC.currentTime;
  const o = AC.createOscillator(), g = AC.createGain();
  o.connect(g); g.connect(AC.destination);
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
function updateSky() {
  const f = ((worldTime / CFG.DAY) % 1 + 1) % 1;
  const sunAlt = Math.sin(f * Math.PI * 2); // f=0 黎明, .25 正午, .5 黄昏, .75 午夜
  const day = smooth(-0.12, 0.3, sunAlt);
  lightLevel = 0.22 + 0.78 * day;
  skyNow.copy(skyNight).lerp(skyDay, day);
  const sunset = clamp01(1 - Math.abs(sunAlt) / 0.32) * clamp01(day * 3 + 0.2);
  skyNow.lerp(skySet, sunset * 0.55);
  scene.background = skyNow;
  scene.fog.color.copy(skyNow);
  const f2 = 0.4 + 0.6 * lightLevel;
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
const mobs = [];
const mobMatBody = new THREE.MeshLambertMaterial({ color: 0x2f5d5a });
const mobMatHead = new THREE.MeshLambertMaterial({ color: 0x9fd8c8 });
const mobMatEye = new THREE.MeshBasicMaterial({ color: 0xff4d4d });
function makeGrunt() {
  const g = new THREE.Group();
  const body = new THREE.Mesh(new THREE.BoxGeometry(0.62, 0.86, 0.44), mobMatBody);
  body.position.y = 0.44;
  const head = new THREE.Mesh(new THREE.BoxGeometry(0.46, 0.42, 0.44), mobMatHead);
  head.position.y = 1.08;
  const e1 = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.08, 0.03), mobMatEye);
  e1.position.set(-0.11, 1.12, 0.23);
  const e2 = e1.clone(); e2.position.x = 0.11;
  const arm1 = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.5, 0.16), mobMatBody);
  arm1.position.set(-0.39, 0.62, 0);
  const arm2 = arm1.clone(); arm2.position.x = 0.39;
  g.add(body, head, e1, e2, arm1, arm2);
  return g;
}
function spawnMob() {
  const ang = Math.random() * Math.PI * 2, dist = 14 + Math.random() * 12;
  const x = Math.floor(player.p.x + Math.cos(ang) * dist);
  const z = Math.floor(player.p.z + Math.sin(ang) * dist);
  const y = surfaceY(x, z);
  if (getBlock(x, y + 1, z) !== 0) return null;
  const m = {
    p: new THREE.Vector3(x + 0.5, y + 1.02, z + 0.5), v: new THREE.Vector3(),
    hp: 20, onGround: false, atkCd: 0, obj: makeGrunt(), phase: Math.random() * 9, wander: 0, dir: new THREE.Vector2(),
  };
  m.obj.position.copy(m.p);
  scene.add(m.obj);
  mobs.push(m);
  return m;
}
function updateMobs(dt) {
  const night = isNight();
  for (let i = mobs.length - 1; i >= 0; i--) {
    const m = mobs[i];
    const dx = player.p.x - m.p.x, dz = player.p.z - m.p.z;
    const dist = Math.hypot(dx, dz);
    if (dist > 64 || m.hp <= 0 || (!night && dist > 8)) {
      scene.remove(m.obj);
      m.obj.traverse(o => { if (o.geometry && o.geometry !== undefined) o.geometry.dispose?.(); });
      mobs.splice(i, 1);
      continue;
    }
    let mx = 0, mz = 0;
    if (night && dist < 26 && player.alive) {
      mx = dx / (dist || 1); mz = dz / (dist || 1);
    } else {
      m.wander -= dt;
      if (m.wander <= 0) { m.wander = 1.5 + Math.random() * 2.5; const a = Math.random() * Math.PI * 2; m.dir.set(Math.cos(a), Math.sin(a)); }
      mx = m.dir.x * 0.4; mz = m.dir.y * 0.4;
    }
    const spd = night && dist < 26 ? 2.9 : 1.3;
    m.v.x = mx * spd; m.v.z = mz * spd;
    m.v.y -= CFG.GRAV * dt;
    const before = m.p.x, beforeZ = m.p.z;
    moveBody(m, m.v.x * dt, m.v.y * dt, m.v.z * dt);
    if (m.onGround && (Math.abs(m.p.x - before) < 0.001 || Math.abs(m.p.z - beforeZ) < 0.001)) m.v.y = CFG.JUMP * 0.85;
    if (m.p.y < -6) { m.hp = 0; }
    // 面向玩家
    const face = Math.atan2(dx, dz);
    m.obj.rotation.y = face;
    m.obj.position.copy(m.p);
    m.phase += dt * (2 + spd);
    m.obj.children[4].rotation.x = Math.sin(m.phase * 3) * 0.5;
    m.obj.children[5].rotation.x = -Math.sin(m.phase * 3) * 0.5;
    // 攻击
    m.atkCd -= dt;
    if (night && dist < 1.45 && m.atkCd <= 0 && player.alive && Math.abs(m.p.y - player.p.y) < 1.8) {
      m.atkCd = 1.3;
      damagePlayer(3);
    }
  }
  if (isNight() && mobs.length < CFG.MAX_MOBS && Math.random() < dt * 0.9) spawnMob();
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
  player.hp = Math.max(0, player.hp - n);
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
function respawn() {
  const sx = 8, sz = 8;
  player.p.set(sx + 0.5, surfaceY(sx, sz) + 1.2, sz + 0.5);
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
function renderInventoryPanel() {
  hud.invGrid.innerHTML = '';
  for (let i = 0; i < SLOTS; i++) {
    const s = inv[i];
    const d = document.createElement('div');
    d.className = 'cell';
    if (s) {
      d.innerHTML = `<img src="${iconURL(s.id)}" alt=""><span class="n">${s.n > 1 ? s.n : ''}</span>`;
      d.title = nameOf(s.id);
      d.onclick = () => { if (i < 9) { player.sel = i; refreshHeld(); renderHotbar(); } toast(`选中 ${nameOf(s.id)}`, 1.2); };
    }
    hud.invGrid.appendChild(d);
  }
  hud.invCount.textContent = `${inv.length}/${SLOTS}`;
  hud.recList.innerHTML = '';
  for (const r of RECIPES) {
    const ok = Object.entries(r.need).every(([id, n]) => countOf(+id) >= n);
    const d = document.createElement('div');
    d.className = 'rec' + (ok ? '' : ' no');
    const need = Object.entries(r.need).map(([id, n]) => `${nameOf(+id)}×${n}`).join(' + ');
    d.innerHTML = `<img src="${iconURL(r.out)}" alt=""><div class="t">${nameOf(r.out)} ×${r.n}<i>${need}</i></div><div class="go">${ok ? '制作 →' : '缺材料'}</div>`;
    d.onclick = () => { if (!ok) return; craft(r); };
    hud.recList.appendChild(d);
  }
}
const RECIPES = [
  { out: 8, n: 4, need: { 6: 1 } },
  { out: 104, n: 4, need: { 8: 2 } },
  { out: 10, n: 1, need: { 8: 4 } },
  { out: 100, n: 1, need: { 8: 3, 104: 2 } },
  { out: 101, n: 1, need: { 9: 3, 104: 2 } },
  { out: 102, n: 1, need: { 8: 2, 104: 1 } },
  { out: 103, n: 1, need: { 9: 2, 104: 1 } },
];
function craft(r) {
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
  if (e.button === 0) { mineHeld = true; attackQueued = true; }
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
  const pickOk = heldKind() === 'pick';
  let speed = 1 / Math.max(0.12, def.hard);
  if (def.pick) speed *= pickOk ? 1 : 0.28;
  player.mining += dt * speed;
  player.mineTarget = target;
  player.swing = Math.max(player.swing, 0.55);
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
    if (def.pick && heldKind() !== 'pick') toast('石头需要镐才能采集', 1.8);
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
  player.swing = 0.8;
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
  renderHotbar(); refreshHeld(); saveSoon();
  return true;
}
function attack() {
  const dir = cameraDir(), eye = eyePos();
  let best = null, bestT = 3.4;
  for (const m of mobs) {
    const c = m.p.clone(); c.y += 0.25;
    const to = c.clone().sub(eye);
    const t = to.dot(dir);
    if (t < 0 || t > bestT) continue;
    const perp = to.clone().addScaledVector(dir, -t).length();
    if (perp < 0.85) { best = m; bestT = t; }
  }
  if (!best) return false;
  const dmg = (defOf(held() ? held().id : 0) || {}).dmg || 1;
  best.hp -= dmg;
  best.v.y = 4.2;
  best.v.x += dir.x * 4; best.v.z += dir.z * 4;
  sfx('hit');
  player.swing = 1;
  if (best.hp <= 0) toast('击倒了夜行怪', 1.4);
  return true;
}

/* ============================================================ 更新循环 */
let lastT = 0, acc = 0, fps = 60, frameCount = 0, fpsT = 0, startedAt = 0;
const STEP = 1 / 60;
let saveTimer = 0;

function updatePlayer(dt) {
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
  updateSky();
  updatePlayer(dt);
  updateMobs(dt);

  // 目标方块
  const t = player.alive ? raycastVoxel(eyePos(), cameraDir(), CFG.REACH) : null;
  if (t) {
    targetOutline.visible = true;
    targetOutline.position.set(t.x + 0.5, t.y + 0.5, t.z + 0.5);
  } else targetOutline.visible = false;

  if (attackQueued) { attack(); attackQueued = false; }
  if (mineHeld && t) doMine(dt, t);
  else if (!mineHeld) { player.mining = 0; player.mineTarget = null; }
  if (placeQueued) {
    placeQueued = false;
    const h = held();
    if (h && (defOf(h.id) || {}).kind === 'food') eat(); else placeBlock();
  }

  // 手部动画
  const miningPulse = mineHeld && t ? 1 : 0;
  if (miningPulse) player.swing = (player.swing + dt * 5.5) % 1;
  else player.swing = Math.max(0, player.swing - dt * 3.2);
  const swingArc = Math.sin(Math.min(1, player.swing) * Math.PI);
  const bob = Math.sin(player.walkPhase) * 0.022;
  const breathe = Math.sin(performance.now() * 0.0013) * 0.006;
  armR.rotation.set(-0.2 - swingArc * 0.85, -0.34 + swingArc * 0.35, 0.12 - swingArc * 0.16);
  armR.position.set(0.3, -0.3 + bob + breathe, -0.26 - swingArc * 0.1);
  armL.rotation.set(-0.26 - swingArc * 0.4, 0.4 - swingArc * 0.2, -0.12);
  armL.position.set(-0.3, -0.34 - bob * 0.7 + breathe, -0.24);

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
    `FPS <b>${Math.round(fps)}</b>  区块 <b>${chunks.size}</b>  ${mem}\n` +
    `坐标 <b>${player.p.x.toFixed(1)} ${player.p.y.toFixed(1)} ${player.p.z.toFixed(1)}</b> 朝${dirName}\n` +
    `时间 <b>${clockText()}</b> ${isNight() ? '夜晚' : '白天'}  怪物 <b>${mobs.length}</b>\n` +
    `手持 <b>${held() ? nameOf(held().id) : '空手'}</b>${heldKind() === 'pick' ? '（镐）' : heldKind() === 'sword' ? '（剑）' : ''}`;
  if (s !== lastStatus) { hud.status.innerHTML = s; lastStatus = s; }
  renderHearts();
}

/* ============================================================ 存档 */
function save() {
  try {
    const data = {
      seed: SEED, time: worldTime,
      player: { x: player.p.x, y: player.p.y, z: player.p.z, yaw: player.yaw, pitch: player.pitch, hp: player.hp, hunger: player.hunger },
      inv, edits: Array.from(edits.entries()),
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

  camera.position.set(player.p.x, player.p.y + CFG.EYE + Math.sin(player.walkPhase) * 0.018, player.p.z);
  camera.rotation.set(player.pitch, player.yaw, 0);
  heldGroup.visible = !!heldMesh;

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
    player.hp = 20; player.hunger = 20;
    inv = [];
    addItem(10, 1);      // 送一个工作台
    addItem(105, 2);     // 两个苹果
    addItem(8, 8);       // 几块木板
    worldTime = CFG.DAY * 0.03;
  }
  try { AC = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) { AC = null; }
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
  CFG, BLOCKS, ITEMS, RECIPES, player, chunks, edits, mobs, inv: () => inv,
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
  heightAt,
  icons: { armR, armL, handScene, solidMat, waterMat, scene, camera, handCam, renderer },
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
    spawnMob: () => { const m = spawnMob(); return m ? [m.p.x, m.p.y, m.p.z] : null; },
    killMobs() { for (const m of mobs) scene.remove(m.obj); mobs.length = 0; },
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
