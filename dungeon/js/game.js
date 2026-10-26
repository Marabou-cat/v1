// game.js — 灰烬遗迹 / Ashfall Ruins
// 开放世界 dungeon 原型：外观自定义 + 护甲/武器装备 + 小地图区域 + 多种怪 + 精英守卫
import * as THREE from 'three';
import { buildHumanoid, buildSlime, buildGolem, buildBow, disposeGroup } from './models.js';

const BUILD = 'd1';

/* ============================== 数据表 ============================== */
const SKINS = ['#f0c9a4', '#e3b391', '#c98f63', '#9c6a45', '#6f4a30'];
const HAIRSTYLES = [{ n: '短发', s: 0 }, { n: '刺猬', s: 1 }, { n: '长发', s: 2 }, { n: '发髻', s: 3 }];
const HAIRCOLORS = ['#241a13', '#4a2f1c', '#8a5a2b', '#c9a35c', '#b44a3a', '#8f97a8'];
const BUILDS = [{ n: '标准', b: 1.0 }, { n: '魁梧', b: 1.15 }];

const WEAPONS = {
  sword: { name: '铁剑', icon: 'i-sword', dmg: 22, range: 2.6, arc: 1.9, dur: 0.40, hitAt: 0.17, kb: 5.5, cost: 9, desc: '均衡的三连斩', locked: false },
  greatsword: { name: '铁巨剑', icon: 'i-sword', dmg: 38, range: 3.1, arc: 2.5, dur: 0.62, hitAt: 0.27, kb: 9.5, cost: 15, desc: '慢速重击，大范围击退', locked: false },
  spear: { name: '长枪', icon: 'i-arrow', dmg: 26, range: 3.8, arc: 0.95, dur: 0.48, hitAt: 0.17, kb: 7, cost: 11, desc: '超长突刺，正面窄角', locked: false },
  axe: { name: '裂石战斧', icon: 'i-sword', dmg: 34, range: 2.8, arc: 2.2, dur: 0.55, hitAt: 0.22, kb: 11, cost: 13, desc: '守卫掉落 · 横扫重斧', locked: true },
};
const ARMOR = {
  cloth: { name: '旅人布衣', def: 0.0, desc: '没有防护，但跑得快', shirt: '#46628f' },
  leather: { name: '猎人皮甲', def: 0.12, desc: '减伤 12%', shirt: '#3d2f22' },
  iron: { name: '卫兵铁甲', def: 0.24, desc: '减伤 24%', shirt: '#2c3540' },
  knight: { name: '守誓骑士铠', def: 0.36, desc: '减伤 36%', shirt: '#242b34' },
};

const MDEF = {
  slime: { hp: 46, dmg: 8, speed: 2.3, aggro: 13, range: 1.9, atkCd: 1.5, wind: 0.42, xp: 16, gold: 7, radius: 0.52, h: 0.9, name: '苔沼史莱姆' },
  goblin: { hp: 82, dmg: 15, speed: 3.0, aggro: 16, range: 2.3, atkCd: 1.7, wind: 0.46, xp: 26, gold: 13, radius: 0.46, h: 1.3, name: '废墟哥布林' },
  skeleton: { hp: 66, dmg: 11, speed: 2.5, aggro: 24, range: 15, keep: 9, atkCd: 2.3, wind: 0.5, xp: 30, gold: 16, radius: 0.44, h: 1.6, name: '骸骨射手', ranged: true },
  boss: { hp: 520, dmg: 26, speed: 2.2, aggro: 26, range: 6.2, atkCd: 2.4, wind: 0.9, xp: 240, gold: 260, radius: 1.35, h: 3.4, name: '石像守卫' },
};

const SPAWNS = [
  { k: 'slime', x: -10, z: 12 }, { k: 'slime', x: -18, z: 19 }, { k: 'slime', x: -33, z: 33 },
  { k: 'slime', x: -21, z: 39 }, { k: 'slime', x: 9, z: 16 },
  { k: 'goblin', x: 17, z: 3 }, { k: 'goblin', x: 25, z: -8 }, { k: 'goblin', x: -9, z: -7 },
  { k: 'goblin', x: 6, z: -19 }, { k: 'goblin', x: -24, z: -20 },
  { k: 'skeleton', x: -7, z: -27 }, { k: 'skeleton', x: 9, z: -31 }, { k: 'skeleton', x: 1, z: -23 },
  // ↓ 副本「废墟深处」独立地图里的怪
  { k: 'boss', x: 0, z: -18.5, map: 'dungeon' },
  { k: 'skeleton', x: -9, z: -8, map: 'dungeon' }, { k: 'skeleton', x: 9, z: -8, map: 'dungeon' },
  { k: 'goblin', x: -12, z: 5, map: 'dungeon' }, { k: 'goblin', x: 12, z: 5, map: 'dungeon' },
  { k: 'slime', x: -6, z: 15, map: 'dungeon' }, { k: 'slime', x: 6, z: 15, map: 'dungeon' },
];

/* ============================== 世界几何 ============================== */
let BOUND = 68;
const POND = { x: -26, z: 26, r: 11.5, water: -1.35 };
const FLAT = [
  { x0: -17, x1: 17, z0: -60, z1: -33, level: 0.55, m: 7 }, // 废墟庭院
  { x0: -8, x1: 8, z0: 18, z1: 33, level: 0.92, m: 6 },     // 营地
];
const smooth = t => t * t * (3 - 2 * t);

function hOver(x, z) {
  let h = Math.sin(x * 0.055) * 0.62 + Math.cos(z * 0.048) * 0.55 + Math.sin(x * 0.031 + z * 0.042) * 0.80;
  h += Math.sin(x * 0.013 - z * 0.017) * 1.15;
  for (const f of FLAT) {
    const dx = Math.max(f.x0 - x, 0, x - f.x1);
    const dz = Math.max(f.z0 - z, 0, z - f.z1);
    const k = smooth(Math.max(0, 1 - Math.hypot(dx, dz) / f.m));
    h = h * (1 - k) + f.level * k;
  }
  const pd = Math.hypot(x - POND.x, z - POND.z);
  if (pd < POND.r * 2.2) h -= 3.1 * Math.exp(-(pd * pd) / (POND.r * POND.r * 0.85));
  return h;
}
// 副本是独立地图：自己的地面高度、碰撞、雾、灯光、出生点
function hDungeon(x, z) {
  let h = 0.35 + Math.sin(x * 0.09) * 0.015 + Math.cos(z * 0.08) * 0.015;
  if (Math.abs(x) < 7.2 && z < -13 && z > -24.5) h = 0.78;   // boss 台座
  return h;
}
let HF = hOver;                       // 当前地图的高度函数
let activeId = 'overworld';
export function heightAt(x, z) { return HF(x, z); }
const inWater = (x, z) => activeId === 'overworld' && Math.hypot(x - POND.x, z - POND.z) < POND.r * 0.98 && heightAt(x, z) < POND.water - 0.1;

/* ============================== 基础三件套 ============================== */
const canvas = document.getElementById('c');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.16;

const scene = new THREE.Scene();
scene.fog = new THREE.Fog(0x9fb2c0, 70, 200);

const camera = new THREE.PerspectiveCamera(58, innerWidth / innerHeight, 0.1, 500);
camera.position.set(0, 6, 34);

/* 天空渐变 */
let skyMesh;
{
  const skyGeo = new THREE.SphereGeometry(320, 24, 16);
  const skyMat = new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false, fog: false,
    uniforms: {
      top: { value: new THREE.Color('#203550') },
      mid: { value: new THREE.Color('#7c93a8') },
      bot: { value: new THREE.Color('#e0b283') },
    },
    vertexShader: 'varying float h; void main(){ h = normalize(position).y; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
    fragmentShader: `uniform vec3 top; uniform vec3 mid; uniform vec3 bot; varying float h;
      void main(){ float t = clamp(h*1.35+0.18,0.0,1.0);
        vec3 c = mix(bot, mid, smoothstep(0.0,0.42,t));
        c = mix(c, top, smoothstep(0.38,1.0,t));
        gl_FragColor = vec4(c,1.0); }`,
  });
  skyMesh = new THREE.Mesh(skyGeo, skyMat);
  scene.add(skyMesh);
}

const hemi = new THREE.HemisphereLight(0xbcd6ee, 0x6b5b43, 1.02);
scene.add(hemi);
const sun = new THREE.DirectionalLight(0xffd9a8, 2.5);
sun.position.set(34, 46, 26);
sun.castShadow = true;
sun.shadow.mapSize.set(1024, 1024);
sun.shadow.camera.left = -42; sun.shadow.camera.right = 42;
sun.shadow.camera.top = 42; sun.shadow.camera.bottom = -42;
sun.shadow.camera.near = 1; sun.shadow.camera.far = 140;
sun.shadow.bias = -0.0016;
scene.add(sun);
const ambient = new THREE.AmbientLight(0xffffff, 0.12);
scene.add(ambient);

/* ============================== 静态世界 ============================== */
const colliders = [];   // {x,z,r} 当前地图
const mapGroups = { overworld: new THREE.Group(), dungeon: new THREE.Group() };
mapGroups.dungeon.visible = false;
scene.add(mapGroups.overworld, mapGroups.dungeon);
let WG = mapGroups.overworld;   // 当前正在往哪个 Group 里建

function addCollider(x, z, r) { colliders.push({ x, z, r }); }

function buildTerrain() {
  const SEG = 120, SIZE = 180;
  const geo = new THREE.PlaneGeometry(SIZE, SIZE, SEG, SEG);
  geo.rotateX(-Math.PI / 2);
  const pos = geo.attributes.position;
  const cols = [];
  const c = new THREE.Color();
  const grass = new THREE.Color('#5e8646');
  const grass2 = new THREE.Color('#4a703c');
  const rock = new THREE.Color('#7c7a6b');
  const sand = new THREE.Color('#b8a077');
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), z = pos.getZ(i);
    const y = heightAt(x, z);
    pos.setY(i, y);
    const n = (Math.sin(x * 0.7) * Math.cos(z * 0.63) + 1) * 0.5;
    c.copy(grass).lerp(grass2, n * 0.75);
    const pd = Math.hypot(x - POND.x, z - POND.z);
    if (pd < POND.r + 3.5) c.lerp(sand, Math.max(0, 1 - pd / (POND.r + 2.5)));
    if (y > 1.9) c.lerp(rock, Math.min(1, (y - 1.9) / 1.6));
    cols.push(c.r, c.g, c.b);
  }
  geo.setAttribute('color', new THREE.Float32BufferAttribute(cols, 3));
  geo.computeVertexNormals();
  const m = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, metalness: 0 });
  const mesh = new THREE.Mesh(geo, m);
  mesh.receiveShadow = true;
  WG.add(mesh);

  // 草簇：先把矩阵全算好，再用精确 count 建 InstancedMesh
  //（曾用「预分配 760 但只填 k 个」，未初始化实例矩阵让 GPU 画出满屏黑色垃圾三角形）
  const mats = [];
  const d = new THREE.Object3D();
  for (let i = 0; i < 2600 && mats.length < 620; i++) {
    const x = (Math.random() * 2 - 1) * 64, z = (Math.random() * 2 - 1) * 64;
    if (Math.hypot(x - POND.x, z - POND.z) < POND.r + 1.5) continue;
    if (x > -18 && x < 18 && z > -62 && z < -32) continue;
    const y = heightAt(x, z);
    if (y < POND.water + 0.3) continue;
    d.position.set(x, y + 0.1, z);
    d.rotation.set(0, Math.random() * 6.28, (Math.random() - 0.5) * 0.18);
    d.scale.setScalar(0.7 + Math.random() * 0.8);
    d.updateMatrix();
    mats.push(d.matrix.clone());
  }
  const tuft = new THREE.InstancedMesh(
    new THREE.ConeGeometry(0.042, 0.2, 4),
    new THREE.MeshStandardMaterial({ color: 0x60874a, roughness: 1, flatShading: true }),
    mats.length
  );
  mats.forEach((m, i) => tuft.setMatrixAt(i, m));
  tuft.instanceMatrix.needsUpdate = true;
  tuft.frustumCulled = false;
  WG.add(tuft);
}

function buildWater() {
  const g = new THREE.Mesh(
    new THREE.CircleGeometry(POND.r * 0.99, 40),
    new THREE.MeshStandardMaterial({ color: 0x2e6f86, roughness: 0.16, metalness: 0.35, transparent: true, opacity: 0.82, envMapIntensity: 1 })
  );
  g.rotation.x = -Math.PI / 2;
  g.position.set(POND.x, POND.water, POND.z);
  g.receiveShadow = true;
  WG.add(g);
  const rim = new THREE.Mesh(new THREE.RingGeometry(POND.r * 0.98, POND.r * 1.05, 40), new THREE.MeshBasicMaterial({ color: 0xcbb68c, transparent: true, opacity: 0.35 }));
  rim.rotation.x = -Math.PI / 2;
  rim.position.set(POND.x, POND.water + 0.02, POND.z);
  WG.add(rim);
}

function buildTrees() {
  const trunkM = new THREE.MeshStandardMaterial({ color: 0x4a3625, roughness: 0.95 });
  const leafA = new THREE.MeshStandardMaterial({ color: 0x3f6b38, roughness: 0.92, flatShading: true });
  const leafB = new THREE.MeshStandardMaterial({ color: 0x4f7d42, roughness: 0.92, flatShading: true });
  const spots = [];
  let guard = 0;
  while (spots.length < 34 && guard++ < 500) {
    const a = Math.random() * Math.PI * 2, r = 20 + Math.random() * 46;
    const x = Math.cos(a) * r, z = Math.sin(a) * r;
    if (Math.hypot(x - POND.x, z - POND.z) < POND.r + 4) continue;
    if (x > -22 && x < 22 && z > -66 && z < -28) continue;
    if (Math.abs(x) < 12 && z > -10 && z < 34) continue; // 主路留空
    if (spots.some(s => Math.hypot(s.x - x, s.z - z) < 6)) continue;
    spots.push({ x, z });
  }
  for (const s of spots) {
    const sc = 0.82 + Math.random() * 0.7;
    const y = heightAt(s.x, s.z);
    const g = new THREE.Group();
    g.position.set(s.x, y, s.z);
    const th = 2.6 * sc;
    const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.13 * sc, 0.22 * sc, th, 7), trunkM);
    trunk.position.y = th / 2; trunk.castShadow = true; trunk.receiveShadow = true;
    g.add(trunk);
    for (let i = 0; i < 3; i++) {
      const rr = (1.35 - i * 0.34) * sc;
      const cone = new THREE.Mesh(new THREE.ConeGeometry(rr, 1.5 * sc, 8), i % 2 ? leafA : leafB);
      cone.position.y = th * 0.72 + i * 0.78 * sc;
      cone.rotation.y = Math.random() * 3;
      cone.castShadow = true; cone.receiveShadow = true;
      g.add(cone);
    }
    WG.add(g);
    addCollider(s.x, s.z, 0.55 * sc);
  }
}

function buildRocks() {
  const mats = [0x6f6f66, 0x5d5f57, 0x7d7a6c];
  for (let i = 0; i < 26; i++) {
    let x, z, guard = 0;
    do { x = (Math.random() * 2 - 1) * 58; z = (Math.random() * 2 - 1) * 58; guard++; }
    while (guard < 40 && (Math.hypot(x - POND.x, z - POND.z) < POND.r + 2 || (x > -20 && x < 20 && z > -64 && z < -30) || Math.abs(x) < 10 && z > 8 && z < 34));
    const sc = 0.5 + Math.random() * 1.5;
    const m = new THREE.Mesh(new THREE.DodecahedronGeometry(sc, 0), new THREE.MeshStandardMaterial({ color: mats[i % 3], roughness: 0.98, flatShading: true }));
    m.position.set(x, heightAt(x, z) + sc * 0.42, z);
    m.rotation.set(Math.random() * 3, Math.random() * 3, Math.random() * 3);
    m.scale.y = 0.75 + Math.random() * 0.4;
    m.castShadow = true; m.receiveShadow = true;
    WG.add(m);
    if (sc > 0.85) addCollider(x, z, sc * 0.8);
  }
}

const stoneM = () => new THREE.MeshStandardMaterial({ color: 0x8a8577, roughness: 0.95 });
const stoneD = () => new THREE.MeshStandardMaterial({ color: 0x6f6b60, roughness: 0.98 });
const torchMat = new THREE.MeshBasicMaterial({ color: 0xffb45c });

function buildRuins() {
  const L = 0.55;
  const g = new THREE.Group();
  WG.add(g);
  // 地面石台
  const floor = new THREE.Mesh(new THREE.BoxGeometry(33, 0.7, 26), stoneM());
  floor.position.set(0, L - 0.35, -46.5);
  floor.receiveShadow = true;
  g.add(floor);
  // 台阶
  for (let i = 0; i < 3; i++) {
    const st = new THREE.Mesh(new THREE.BoxGeometry(9, 0.22, 1.5), stoneD());
    st.position.set(0, 0.12 + i * 0.14, -32.6 - i * 1.3);
    st.receiveShadow = true; st.castShadow = true;
    g.add(st);
  }
  // 侧墙 + 后墙（分段）
  const seg = (x, z, w, h, d, ry = 0) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), stoneM());
    m.position.set(x, L + h / 2, z);
    m.rotation.y = ry;
    m.castShadow = true; m.receiveShadow = true;
    g.add(m);
    addCollider(x, z, Math.max(0.7, Math.min(w, d) * 0.62));
  };
  for (let z = -58; z <= -35; z += 4) {
    seg(-16.2, z, 1.5, 4.2, 3.4);
    seg(16.2, z, 1.5, 4.2, 3.4);
  }
  for (let x = -15; x <= 15; x += 4) {
    if (Math.abs(x) < 3.2) continue;  // 门洞
    seg(x, -59.2, 3.4, 4.6, 1.6);
  }
  // 立柱
  for (const [px, pz] of [[-13.5, -34], [13.5, -34], [-13.5, -55], [13.5, -55]]) {
    const col = new THREE.Mesh(new THREE.CylinderGeometry(0.85, 0.95, 5.2, 10), stoneM());
    col.position.set(px, L + 2.6, pz);
    col.castShadow = true; col.receiveShadow = true;
    g.add(col);
    addCollider(px, pz, 1.05);
  }
  // 拱门 + 传送门
  const archL = new THREE.Mesh(new THREE.BoxGeometry(1.1, 4.4, 1.4), stoneD());
  archL.position.set(-2.9, L + 2.2, -59.1); archL.castShadow = true; g.add(archL);
  const archR = archL.clone(); archR.position.x = 2.9; g.add(archR);
  const archTop = new THREE.Mesh(new THREE.BoxGeometry(7.6, 1.3, 1.5), stoneM());
  archTop.position.set(0, L + 4.9, -59.1); archTop.castShadow = true; g.add(archTop);
  const portal = new THREE.Mesh(new THREE.PlaneGeometry(4.2, 4.6), new THREE.MeshBasicMaterial({ color: 0x0a1018 }));
  portal.position.set(0, L + 2.3, -58.9);
  g.add(portal);
  const ring = new THREE.Mesh(new THREE.TorusGeometry(2.15, 0.13, 8, 30), new THREE.MeshBasicMaterial({ color: 0x76d6ff, transparent: true, opacity: 0.7 }));
  ring.position.set(0, L + 2.3, -58.8);
  g.add(ring);
  G.portalRing = ring;
  const pl = new THREE.PointLight(0x74cdff, 12, 18, 2);
  pl.position.set(0, L + 2.4, -57.4);
  scene.add(pl);
  // 火盆
  for (const [bx, bz] of [[-7.5, -34], [7.5, -34]]) {
    const bowl = new THREE.Mesh(new THREE.CylinderGeometry(0.42, 0.28, 0.34, 8), stoneD());
    bowl.position.set(bx, L + 0.17, bz); bowl.castShadow = true; g.add(bowl);
    const fire = new THREE.Mesh(new THREE.ConeGeometry(0.26, 0.7, 6), torchMat);
    fire.position.set(bx, L + 0.72, bz); g.add(fire);
    const lgt = new THREE.PointLight(0xff9b45, 8, 12, 2);
    lgt.position.set(bx, L + 1.0, bz);
    scene.add(lgt);
    FIRELIGHTS.push({ mesh: fire, light: lgt, base: 1 });
  }
  addCollider(-2.9, -59.1, 0.8); addCollider(2.9, -59.1, 0.8);
}

const FIRELIGHTS = [];

function buildCamp() {
  const y = heightAt(0, 26);
  const g = new THREE.Group();
  WG.add(g);
  // 石圈 + 篝火
  for (let i = 0; i < 9; i++) {
    const a = (i / 9) * Math.PI * 2;
    const st = new THREE.Mesh(new THREE.DodecahedronGeometry(0.22, 0), new THREE.MeshStandardMaterial({ color: 0x77736a, roughness: 1, flatShading: true }));
    st.position.set(Math.cos(a) * 0.85, y + 0.16, 26 + Math.sin(a) * 0.85);
    st.castShadow = true; g.add(st);
  }
  for (let i = 0; i < 4; i++) {
    const log = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.11, 1.0, 6), new THREE.MeshStandardMaterial({ color: 0x4a3625, roughness: 1 }));
    log.position.set(0, y + 0.16, 26);
    log.rotation.set(Math.PI / 2, i * 0.8, 0);
    g.add(log);
  }
  const flame = new THREE.Mesh(new THREE.ConeGeometry(0.34, 1.05, 7), new THREE.MeshBasicMaterial({ color: 0xffa04a }));
  flame.position.set(0, y + 0.72, 26);
  g.add(flame);
  const flame2 = new THREE.Mesh(new THREE.ConeGeometry(0.2, 0.7, 6), new THREE.MeshBasicMaterial({ color: 0xffe08a }));
  flame2.position.set(0, y + 0.62, 26);
  g.add(flame2);
  const lgt = new THREE.PointLight(0xff9a45, 22, 20, 2);
  lgt.position.set(0, y + 1.4, 26);
  scene.add(lgt);
  FIRELIGHTS.push({ mesh: flame, mesh2: flame2, light: lgt, base: 1 });
  addCollider(0, 26, 0.75);
  // 帐篷
  const tent = new THREE.Mesh(new THREE.ConeGeometry(1.9, 2.3, 4), new THREE.MeshStandardMaterial({ color: 0x6b5138, roughness: 0.95, flatShading: true }));
  tent.position.set(5.2, y + 1.05, 30.5);
  tent.rotation.y = 0.6;
  tent.castShadow = true; tent.receiveShadow = true;
  g.add(tent);
  addCollider(5.2, 30.5, 1.6);
  // 补给箱
  const crate = new THREE.Mesh(new THREE.BoxGeometry(1.0, 0.8, 0.9), new THREE.MeshStandardMaterial({ color: 0x7a5c37, roughness: 0.9 }));
  crate.position.set(-3.4, y + 0.4, 29.4);
  crate.rotation.y = 0.35;
  crate.castShadow = true; crate.receiveShadow = true;
  g.add(crate);
  addCollider(-3.4, 29.4, 0.75);
  // 旗
  const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 3.2, 6), new THREE.MeshStandardMaterial({ color: 0x4a3625 }));
  pole.position.set(-5.6, y + 1.6, 24);
  g.add(pole);
  const flag = new THREE.Mesh(new THREE.PlaneGeometry(1.3, 0.75), new THREE.MeshStandardMaterial({ color: 0x9c2f2f, roughness: 0.9, side: THREE.DoubleSide }));
  flag.position.set(-4.95, y + 2.75, 24);
  g.add(flag);
  addCollider(-5.6, 24, 0.3);
}

function buildMountains() {
  const m = new THREE.MeshBasicMaterial({ color: 0x8193a2, fog: true });
  for (let i = 0; i < 20; i++) {
    const a = (i / 20) * Math.PI * 2 + Math.random() * 0.16;
    const r = 132 + Math.random() * 44;
    const h = 20 + Math.random() * 26;
    const c = new THREE.Mesh(new THREE.ConeGeometry(h * 1.55, h, 6), m);
    c.position.set(Math.cos(a) * r, h * 0.30, Math.sin(a) * r);
    c.rotation.y = Math.random() * 3;
    WG.add(c);
  }
}


/* ---------------- 副本地图：废墟深处（独立场景，由传送门进入） ---------------- */
function buildDungeon() {
  const g = WG;
  const L = 0.35;
  const wallM = new THREE.MeshStandardMaterial({ color: 0x6f6c63, roughness: 0.97 });
  const wallD = new THREE.MeshStandardMaterial({ color: 0x54524c, roughness: 0.98 });
  const floorM = new THREE.MeshStandardMaterial({ color: 0x78746a, roughness: 0.95 });
  const tileM = new THREE.MeshStandardMaterial({ color: 0x655f56, roughness: 1 });

  const floor = new THREE.Mesh(new THREE.BoxGeometry(44, 1.4, 54), floorM);
  floor.position.set(0, L - 0.7, 0);
  floor.receiveShadow = true;
  g.add(floor);
  for (let i = -5; i <= 5; i++) {
    const a = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.02, 53), tileM);
    a.position.set(i * 4, L + 0.012, 0);
    g.add(a);
    const b = new THREE.Mesh(new THREE.BoxGeometry(43, 0.02, 0.08), tileM);
    b.position.set(0, L + 0.012, i * 5);
    g.add(b);
  }

  const wall = (x, z, w, d) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, 7.2, d), wallM);
    m.position.set(x, L + 3.6, z);
    m.castShadow = true; m.receiveShadow = true;
    g.add(m);
    const len = Math.max(w, d);
    for (let t = -len / 2; t <= len / 2 + 0.01; t += 1.55) {
      addCollider(w > d ? x + t : x, w > d ? z : z + t, 1.32);
    }
  };
  wall(-22.3, 0, 1.8, 54);
  wall(22.3, 0, 1.8, 54);
  wall(0, -27.3, 45, 1.8);
  wall(0, 27.3, 45, 1.8);

  // 立柱
  for (const [px, pz] of [[-15, -12], [15, -12], [-15, 12], [15, 12]]) {
    const c = new THREE.Mesh(new THREE.CylinderGeometry(1.15, 1.35, 7.2, 10), wallD);
    c.position.set(px, L + 3.6, pz);
    c.castShadow = true; c.receiveShadow = true;
    g.add(c);
    const cap = new THREE.Mesh(new THREE.BoxGeometry(2.9, 0.4, 2.9), wallM);
    cap.position.set(px, L + 7.3, pz);
    g.add(cap);
    addCollider(px, pz, 1.55);
  }

  // boss 台座 + 符文圈
  const dais = new THREE.Mesh(new THREE.CylinderGeometry(7.4, 7.7, 0.5, 26), wallD);
  dais.position.set(0, L + 0.25, -18.5);
  dais.receiveShadow = true;
  g.add(dais);
  const rune = new THREE.Mesh(new THREE.TorusGeometry(5.4, 0.1, 8, 44), new THREE.MeshBasicMaterial({ color: 0x6fd0ff, transparent: true, opacity: 0.5 }));
  rune.rotation.x = -Math.PI / 2;
  rune.position.set(0, L + 0.53, -18.5);
  g.add(rune);
  G.dungeonRune = rune;

  // 墙上火把（带 2 盏实光就够了，手机上点光很贵）
  const torchSpots = [[-21.2, -12], [21.2, -12], [-21.2, 12], [21.2, 12]];
  torchSpots.forEach(([tx, tz], i) => {
    const br = new THREE.Mesh(new THREE.CylinderGeometry(0.34, 0.2, 0.5, 7), wallD);
    br.position.set(tx, L + 2.7, tz);
    g.add(br);
    const fl = new THREE.Mesh(new THREE.ConeGeometry(0.26, 0.78, 6), torchMat);
    fl.position.set(tx, L + 3.3, tz);
    g.add(fl);
    let light = null;
    if (i % 2 === 0) {
      light = new THREE.PointLight(0xff9b45, 16, 20, 2);
      light.position.set(tx * 0.94, L + 3.4, tz);
      g.add(light);
    }
    FIRELIGHTS.push({ mesh: fl, light: light || { intensity: 0, id: i }, base: 1 });
  });

  // 出口传送门（回到大世界）
  for (const s of [-1, 1]) {
    const post = new THREE.Mesh(new THREE.BoxGeometry(1.1, 4.8, 1.4), wallD);
    post.position.set(3.2 * s, L + 2.4, 25.6);
    post.castShadow = true;
    g.add(post);
    addCollider(3.2 * s, 25.6, 0.85);
  }
  const lintel = new THREE.Mesh(new THREE.BoxGeometry(8, 1.2, 1.5), wallM);
  lintel.position.set(0, L + 5.1, 25.6);
  lintel.castShadow = true;
  g.add(lintel);
  const exitPlane = new THREE.Mesh(new THREE.PlaneGeometry(4.4, 4.8), new THREE.MeshBasicMaterial({ color: 0x0a1018 }));
  exitPlane.position.set(0, L + 2.5, 25.5);
  exitPlane.rotation.y = Math.PI;
  g.add(exitPlane);
  const exitRing = new THREE.Mesh(new THREE.TorusGeometry(2.25, 0.13, 8, 30), new THREE.MeshBasicMaterial({ color: 0x76d6ff, transparent: true, opacity: 0.7 }));
  exitRing.position.set(0, L + 2.5, 25.4);
  exitRing.rotation.y = Math.PI;
  g.add(exitRing);
  G.dungeonRing = exitRing;
  const exitLight = new THREE.PointLight(0x74cdff, 22, 26, 2);
  exitLight.position.set(0, L + 2.6, 23.6);
  g.add(exitLight);

  // 碎石 / 骸骨堆装饰
  for (let i = 0; i < 12; i++) {
    const a = Math.random() * 6.28, r = 4 + Math.random() * 16;
    const sc = 0.3 + Math.random() * 0.7;
    const m = new THREE.Mesh(new THREE.DodecahedronGeometry(sc, 0), new THREE.MeshStandardMaterial({ color: 0x5d5a52, roughness: 1, flatShading: true }));
    m.position.set(Math.cos(a) * r, L + sc * 0.35, Math.sin(a) * r);
    m.rotation.set(Math.random() * 3, Math.random() * 3, 0);
    m.castShadow = true; m.receiveShadow = true;
    g.add(m);
  }
}

/* ============================== 状态 ============================== */
const G = {
  mode: 'creation', t: 0, paused: false, shake: 0,
  hero: null, monsters: [], arrows: [], orbs: [], fx: [], texts: [],
  gold: 0, level: 1, xp: 0, xpNeed: 45, hpBoost: 0, axeUnlocked: false,
  bossDead: false, bossAggro: false, deadT: 0,
  appearance: { skin: 1, hair: 1, hairColor: 0, build: 0 },
  gear: { armor: 'cloth', weapon: 'sword' },
  stats: { kills: 0, dmgDone: 0, dmgTaken: 0 },
  cam: { yaw: Math.PI, pitch: 0.30, dist: 7.0 },
  portalRing: null,
};
window.__DG_G = G;

const MAPS = {};
let activeMap = null;
function finishMap(id, cfg) {
  MAPS[id] = Object.assign({ id, solids: colliders.slice() }, cfg);
  colliders.length = 0;
  return MAPS[id];
}
FIRELIGHTS.length = 0;
// ① 大世界
WG = mapGroups.overworld; HF = hOver;
buildTerrain(); buildWater(); buildTrees(); buildRocks(); buildRuins(); buildCamp(); buildMountains();
finishMap('overworld', {
  h: hOver, label: '灰烬原野',
  spawn: new THREE.Vector3(2.4, hOver(2.4, 30.6) + 0.05, 30.6), face: Math.PI,
  bound: 68, fog: { c: 0x9fb2c0, n: 70, f: 200 }, sun: 2.5, hemi: 1.02, amb: 0.12, sky: true,
  portal: { x: 0, z: -56.5, r: 4.2, to: 'dungeon', text: '进入废墟深处' },
});
// ② 副本（独立地图，只能通过传送门进出）
WG = mapGroups.dungeon; HF = hDungeon;
buildDungeon();
finishMap('dungeon', {
  h: hDungeon, label: '废墟深处',
  spawn: new THREE.Vector3(0, hDungeon(0, 16) + 0.05, 16), face: Math.PI,
  bound: 20, fog: { c: 0x141c24, n: 10, f: 62 }, sun: 0.75, hemi: 0.52, amb: 0.26, sky: false,
  portal: { x: 0, z: 24.6, r: 3.4, to: 'overworld', text: '返回地表' },
});
activeMap = MAPS.overworld; activeId = 'overworld'; HF = hOver; BOUND = 68;
colliders.length = 0; colliders.push(...MAPS.overworld.solids);

/* ============================== 英雄 ============================== */
const heroStart = MAPS.overworld.spawn.clone();
const hero = {
  pos: heroStart.clone(), yaw: Math.PI, vel: new THREE.Vector3(),
  hp: 120, stam: 100, level: 1, xp: 0,
  atk: null, roll: 0, rollDir: new THREE.Vector3(), invuln: 0, hurtT: 0,
  walkPhase: 0, moveAmt: 0, dead: false, atkT: 0, combo: 0, stepT: 0,
};
G.hero = hero;

function maxHp() { return 120 + (hero.level - 1) * 12 + G.hpBoost; }
function atkPower() { return 1 + (hero.level - 1) * 0.06; }

function makeHeroModel() {
  const A = G.appearance, AR = ARMOR[G.gear.armor];
  const m = buildHumanoid({
    height: 1.78,
    skin: SKINS[A.skin],
    shirt: AR.shirt,
    pants: '#2b3543',
    hairStyle: A.hair >= 0 ? HAIRSTYLES[A.hair].s : -1,
    hairColor: HAIRCOLORS[A.hairColor],
    bulk: BUILDS[A.build].b,
    armor: G.gear.armor,
    weapon: G.gear.weapon,
    eyes: '#20242c',
    helmet: G.gear.armor === 'knight',
    cape: G.gear.armor === 'knight',
  });
  m.group.position.copy(hero.pos);
  m.group.rotation.y = hero.yaw;
  scene.add(m.group);
  return m;
}

let heroModel = makeHeroModel();
function rebuildHero() {
  if (heroModel) { scene.remove(heroModel.group); disposeGroup(heroModel.group); }
  heroModel = makeHeroModel();
  heroModel.group.visible = !hero.dead;
}

/* ============================== 怪物 ============================== */
function buildMonsterModel(kind) {
  if (kind === 'slime') {
    const tint = ['#67c274', '#5aa8c9', '#a97ad1'][Math.floor(Math.random() * 3)];
    const m = buildSlime(tint);
    m.rig.barY = 1.0;
    return m;
  }
  if (kind === 'boss') {
    const m = buildGolem();
    m.rig.barY = 3.9;
    return m;
  }
  if (kind === 'skeleton') {
    const m = buildHumanoid({
      height: 1.58, skin: '#e8e3d3', shirt: '#cfc9b6', pants: '#cfc9b6', bootColor: '#d8d2c0',
      hairStyle: -1, bones: true, headStyle: 'skull', armor: 'cloth', weapon: null, eyes: '#12161a',
    });
    const bow = buildBow();
    bow.position.set(0, -0.02, 0.06);
    bow.rotation.set(0, 0, 0.1);
    bow.scale.setScalar(0.9);
    m.rig.handL.add(bow);
    m.rig.bow = bow;
    m.rig.barY = 2.0;
    return m;
  }
  const m = buildHumanoid({
    height: 1.28, skin: '#7fa65a', shirt: '#5a3f2a', pants: '#3d2d1e', bootColor: '#3a2a1c',
    hairStyle: 1, hairColor: '#2a1d12', armor: 'leather', weapon: 'axe', ears: true, headScale: 1.12, eyes: '#f0c14a',
  });
  if (m.rig.weaponModel) m.rig.weaponModel.scale.setScalar(0.72);
  m.rig.barY = 1.75;
  return m;
}

function makeHealthBar(m) {
  const bg = new THREE.Mesh(new THREE.PlaneGeometry(0.9, 0.11), new THREE.MeshBasicMaterial({ color: 0x0b0f14, transparent: true, opacity: 0.85, depthWrite: false }));
  const fill = new THREE.Mesh(new THREE.PlaneGeometry(0.84, 0.065), new THREE.MeshBasicMaterial({ color: 0x8ce07a, depthWrite: false }));
  fill.position.z = 0.002;
  bg.add(fill);
  bg.visible = false;
  return { bg, fill };
}

function spawnMonster(sp) {
  const def = MDEF[sp.k];
  const mapId = sp.map || 'overworld';
  const hf = MAPS[mapId].h;
  const model = buildMonsterModel(sp.k);
  const pos = new THREE.Vector3(sp.x, hf(sp.x, sp.z), sp.z);
  model.group.position.copy(pos);
  mapGroups[mapId].add(model.group);
  const hb = makeHealthBar();
  hb.bg.position.y = (model.rig.barY || 1.2) * (def.h / 1.78);
  model.group.add(hb.bg);
  const m = {
    boss: sp.k === 'boss', mapId,
    kind: sp.k, def, model, group: model.group, rig: model.rig,
    pos, home: new THREE.Vector3(sp.x, 0, sp.z), yaw: Math.random() * 6.28,
    hp: def.hp, maxHp: def.hp, atk: null, atkCd: 1 + Math.random(), hitT: 0,
    vel: new THREE.Vector3(), aggro: false, dead: false, deadT: 0, respawn: 0,
    walkPhase: Math.random() * 6, moveAmt: 0, state: 'idle', idT: 1 + Math.random() * 2,
    wander: new THREE.Vector3(), combo: Math.random() < 0.5, hb, barY: (model.rig.barY || 1.2),
    chargeT: 0, chargeDir: new THREE.Vector3(), cHit: false, slamT: 0,
  };
  ALL_MONSTERS.push(m);
  return m;
}
const ALL_MONSTERS = [];
for (const sp of SPAWNS) spawnMonster(sp);
G.monsters = ALL_MONSTERS.filter(m => m.mapId === activeId);

/* ============================== 特效 / 文字 ============================== */
const dmgLayer = document.getElementById('dmgLayer');
function floatText(x, y, z, txt, cls = '') {
  if (G.texts.length > 26) return;
  const el = document.createElement('div');
  el.className = 'dmg ' + cls;
  el.textContent = txt;
  dmgLayer.appendChild(el);
  G.texts.push({ el, x, y, z, t: 0, life: cls === 'crit' ? 1.0 : 0.85, vy: 1.6, dx: (Math.random() - 0.5) * 0.5 });
}

function addFx(mesh, life, update) {
  scene.add(mesh);
  G.fx.push({ mesh, t: 0, life, update });
}

const slashGeo = new THREE.RingGeometry(0.62, 1.0, 22, 1, -0.9, 1.8);
slashGeo.rotateX(-Math.PI / 2);

function fxSlash(pos, yaw, radius, arc) {
  const g = new THREE.Mesh(new THREE.RingGeometry(0.55, 1.0, 20, 1, -arc / 2, arc), new THREE.MeshBasicMaterial({
    color: 0xfff1c9, transparent: true, opacity: 0.9, side: THREE.DoubleSide, depthWrite: false, blending: THREE.AdditiveBlending,
  }));
  g.geometry.rotateX(-Math.PI / 2);
  g.position.set(pos.x, pos.y + 1.05, pos.z);
  g.rotation.y = yaw - Math.PI / 2;
  g.scale.setScalar(radius * 0.55);
  addFx(g, 0.24, (o, p) => { o.material.opacity = 0.9 * (1 - p); o.scale.setScalar(radius * (0.55 + p * 0.62)); });
}

function fxSparks(pos, n = 7, color = 0xffd9a0) {
  for (let i = 0; i < n; i++) {
    const s = new THREE.Mesh(new THREE.SphereGeometry(0.055 + Math.random() * 0.05, 5), new THREE.MeshBasicMaterial({ color, transparent: true }));
    s.position.set(pos.x, pos.y + 1.0, pos.z);
    const v = new THREE.Vector3((Math.random() - 0.5) * 6, 2 + Math.random() * 4, (Math.random() - 0.5) * 6);
    addFx(s, 0.32, (o, p) => {
      o.position.addScaledVector(v, 1 / 60);
      v.y -= 22 / 60;
      o.material.opacity = 1 - p;
      o.scale.setScalar(1 - p * 0.6);
    });
  }
}

function fxRing(pos, radius, color = 0xffb066, life = 0.5) {
  const g = new THREE.Mesh(new THREE.RingGeometry(0.82, 1.0, 36), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.95, side: THREE.DoubleSide, depthWrite: false, blending: THREE.AdditiveBlending }));
  g.geometry.rotateX(-Math.PI / 2);
  g.position.set(pos.x, pos.y + 0.16, pos.z);
  addFx(g, life, (o, p) => { o.scale.setScalar(1 + p * radius); o.material.opacity = 0.95 * (1 - p); });
}

function fxPuff(pos) {
  const g = new THREE.Mesh(new THREE.SphereGeometry(0.12, 6), new THREE.MeshBasicMaterial({ color: 0xcbbd9b, transparent: true, opacity: 0.55 }));
  g.position.set(pos.x + (Math.random() - 0.5) * 0.3, pos.y + 0.08, pos.z + (Math.random() - 0.5) * 0.3);
  addFx(g, 0.42, (o, p) => { o.position.y += 0.012; o.scale.setScalar(1 + p * 2.4); o.material.opacity = 0.5 * (1 - p); });
}

/* ============================== 战斗 ============================== */
const P = { radius: 0.44, walk: 5.0, rollSpeed: 11.0, rollTime: 0.42, rollCost: 26, stamRegen: 26, stamDelay: 0.5 };

function nearestTarget(maxDist, maxAngle) {
  let best = null, bd = maxDist;
  const fx = Math.sin(hero.yaw), fz = Math.cos(hero.yaw);
  for (const m of G.monsters) {
    if (m.dead) continue;
    const dx = m.pos.x - hero.pos.x, dz = m.pos.z - hero.pos.z;
    const d = Math.hypot(dx, dz);
    if (d > bd + m.def.radius) continue;
    const dot = (dx * fx + dz * fz) / (d || 1);
    if (dot < Math.cos(maxAngle)) continue;
    bd = d; best = m;
  }
  return best;
}

function doAttack() {
  if (G.mode !== 'play' || hero.dead) return;
  if (hero.roll > 0) return;
  const W = WEAPONS[G.gear.weapon];
  if (hero.stam < W.cost) { flashStam(); return; }
  if (hero.atk) return;
  const tgt = nearestTarget(5.0, 1.15);
  if (tgt) hero.yaw = Math.atan2(tgt.pos.x - hero.pos.x, tgt.pos.z - hero.pos.z);
  hero.stam -= W.cost;
  hero.stamDelay = 0.55;
  hero.atk = { t: 0, dur: W.dur, hit: false, W, hitIndex: 0 };
}

function flashStam() {
  const el = document.getElementById('stFill');
  el.style.filter = 'brightness(2.2)';
  setTimeout(() => { el.style.filter = ''; }, 130);
}

function heroStrike(atk) {
  const W = atk.W;
  const fx = Math.sin(hero.yaw), fz = Math.cos(hero.yaw);
  let hitAny = false;
  for (const m of G.monsters) {
    if (m.dead) continue;
    const dx = m.pos.x - hero.pos.x, dz = m.pos.z - hero.pos.z;
    const d = Math.hypot(dx, dz);
    if (d > W.range + m.def.radius) continue;
    const dot = (dx * fx + dz * fz) / (d || 1);
    if (dot < Math.cos(W.arc / 2)) continue;
    const crit = Math.random() < 0.16;
    let dmg = W.dmg * atkPower() * (crit ? 1.7 : 1) * (1 + Math.random() * 0.12);
    hurtMonster(m, dmg, W.kb * (crit ? 1.35 : 1), hero.pos, crit);
    hitAny = true;
  }
  fxSlash(hero.pos, hero.yaw, W.range, W.arc);
  if (hitAny) { G.shake = Math.min(0.55, 0.16 + W.kb * 0.02); hitstop = 0.045; }
}

let hitstop = 0;

function hurtMonster(m, dmg, kb, fromPos, crit) {
  if (m.dead) return;
  m.hp -= dmg;
  G.stats.dmgDone += dmg;
  m.hitT = 0.22;
  m.aggro = true;
  const dx = m.pos.x - fromPos.x, dz = m.pos.z - fromPos.z;
  const d = Math.hypot(dx, dz) || 1;
  m.vel.x += (dx / d) * kb;
  m.vel.z += (dz / d) * kb;
  floatText(m.pos.x, m.pos.y + m.def.h * 0.95, m.pos.z, Math.round(dmg) + (crit ? '!' : ''), crit ? 'crit' : '');
  fxSparks(m.pos, crit ? 10 : 6, crit ? 0xffe27a : 0xffd0a0);
  if (m.boss) G.bossAggro = true;
  if (m.hp <= 0) killMonster(m);
}

function killMonster(m) {
  m.dead = true;
  m.deadT = 0;
  m.hp = 0;
  G.stats.kills++;
  const n = m.boss ? 6 : 3;
  for (let i = 0; i < n; i++) {
    const el = new THREE.Mesh(new THREE.SphereGeometry(0.11, 6), new THREE.MeshBasicMaterial({ color: 0xffd777 }));
    el.position.set(m.pos.x + (Math.random() - 0.5) * 0.9, m.pos.y + 0.6, m.pos.z + (Math.random() - 0.5) * 0.9);
    scene.add(el);
    G.orbs.push({ mesh: el, pos: el.position, vel: new THREE.Vector3((Math.random() - 0.5) * 2.4, 3 + Math.random() * 2, (Math.random() - 0.5) * 2.4), value: Math.max(1, Math.round(m.def.gold / n)), t: 0 });
  }
  G.gold += Math.round(m.def.gold * 0.4);
  addXp(m.def.xp);
  if (m.boss) {
    G.bossDead = true;
    if (!G.axeUnlocked) { G.axeUnlocked = true; WEAPONS.axe.locked = false; }
    banner('废墟已清除', '石像守卫倒下 · 获得裂石战斧 · 金币 +260');
    G.gold += 260;
    updateHUD();
    setTimeout(() => { if (G.mode === 'play') showToast('按背包键可装备「裂石战斧」'); }, 2200);
  } else {
    m.respawn = 26 + Math.random() * 10;
  }
}

function addXp(v) {
  G.xp += v;
  while (G.xp >= G.xpNeed) {
    G.xp -= G.xpNeed;
    G.level++;
    hero.level = G.level;
    G.xpNeed = Math.round(G.xpNeed * 1.45);
    hero.hp = maxHp();
    banner('等级提升', 'Lv ' + G.level + ' · 生命与攻击提高');
    fxRing(hero.pos, 4.5, 0xffe0a0, 0.7);
  }
}

function hurtHero(dmg, from) {
  if (hero.dead || hero.invuln > 0 || G.mode !== 'play') return;
  const def = ARMOR[G.gear.armor].def;
  const final = Math.max(1, dmg * (1 - def));
  hero.hp -= final;
  G.stats.dmgTaken += final;
  hero.hurtT = 0.32;
  hero.invuln = 0.65;
  G.shake = Math.min(0.7, 0.22 + final * 0.012);
  floatText(hero.pos.x, hero.pos.y + 1.8, hero.pos.z, '-' + Math.round(final), 'hurt');
  if (hero.hp <= 0) { hero.hp = 0; heroDie(); }
}

function heroDie() {
  hero.dead = true;
  G.mode = 'dead';
  G.deadT = 2.6;
  banner('你倒下了', '在营火旁苏醒…');
  hero.atk = null;
  hero.roll = 0;
}

function respawnHero() {
  hero.dead = false;
  hero.hp = maxHp();
  hero.stam = 100;
  hero.pos.copy(activeMap.spawn);
  hero.pos.y = heightAt(hero.pos.x, hero.pos.z);
  hero.invuln = 2.0;
  heroModel.group.visible = true;
  heroModel.body.rotation.set(0, 0, 0);
  heroModel.body.position.y = 0;
  G.mode = 'play';
  G.cam.yaw = Math.PI;
  showToast('在营火旁苏醒 · 生命已恢复');
  for (const m of G.monsters) { m.aggro = false; m.atk = null; }
}

function doRoll() {
  if (G.mode !== 'play' || hero.dead || hero.roll > 0) return;
  if (hero.stam < P.rollCost) { flashStam(); return; }
  const dir = moveDir();
  const d = dir.lengthSq() > 0.01 ? dir : new THREE.Vector3(Math.sin(hero.yaw), 0, Math.cos(hero.yaw));
  hero.rollDir.copy(d).normalize();
  hero.yaw = Math.atan2(hero.rollDir.x, hero.rollDir.z);
  hero.roll = P.rollTime;
  hero.invuln = Math.max(hero.invuln, 0.34);
  hero.stam -= P.rollCost;
  hero.stamDelay = 0.6;
  hero.atk = null;
  fxPuff(hero.pos);
}

/* ============================== 输入 ============================== */
const input = { ix: 0, iz: 0, stickActive: false };
const keys = new Set();
const stickEl = document.getElementById('stick');
const nubEl = document.getElementById('stickNub');
const stick = { id: null, cx: 0, cy: 0 };

function moveDir() {
  const ix = input.ix, iz = input.iz;
  if (Math.abs(ix) < 0.02 && Math.abs(iz) < 0.02) return new THREE.Vector3();
  const yaw = G.cam.yaw;
  const fwd = new THREE.Vector3(Math.sin(yaw), 0, Math.cos(yaw));
  const right = new THREE.Vector3(-Math.cos(yaw), 0, Math.sin(yaw));
  return fwd.multiplyScalar(iz).addScaledVector(right, ix).normalize().multiplyScalar(Math.min(1, Math.hypot(ix, iz)));
}

function updateKeyMove() {
  let ix = 0, iz = 0;
  if (keys.has('KeyW') || keys.has('ArrowUp')) iz += 1;
  if (keys.has('KeyS') || keys.has('ArrowDown')) iz -= 1;
  if (keys.has('KeyD') || keys.has('ArrowRight')) ix += 1;
  if (keys.has('KeyA') || keys.has('ArrowLeft')) ix -= 1;
  if (!input.stickActive && (ix || iz)) {
    input.ix = ix; input.iz = iz;
  } else if (!input.stickActive && !ix && !iz) {
    input.ix = 0; input.iz = 0;
  }
}

addEventListener('keydown', e => {
  if (e.repeat) return;
  keys.add(e.code);
  if (e.code === 'Space' || e.code === 'ShiftLeft' || e.code === 'ShiftRight') { doRoll(); e.preventDefault(); }
  if (e.code === 'KeyJ' || e.code === 'KeyK') { doAttack(); e.preventDefault(); }
  if (e.code === 'KeyE') { usePortal(); e.preventDefault(); }
  if (e.code === 'Tab') { e.preventDefault(); toggleGear(); }
  if (e.code === 'Escape') closePanel();
  if (e.code === 'Enter' && G.mode === 'creation') startGame();
});
addEventListener('keyup', e => keys.delete(e.code));

function stickStart(e) {
  stick.id = e.pointerId;
  stick.cx = e.clientX; stick.cy = e.clientY;
  stickEl.style.left = (e.clientX - 66) + 'px';
  stickEl.style.top = (e.clientY - 66) + 'px';
  stickEl.style.bottom = 'auto';
  stickEl.classList.add('on');
  input.stickActive = true;
}
function stickMove(e) {
  const dx = e.clientX - stick.cx, dy = e.clientY - stick.cy;
  const max = 46;
  const d = Math.hypot(dx, dy);
  const k = d > max ? max / d : 1;
  const nx = dx * k, ny = dy * k;
  nubEl.style.transform = `translate(${nx}px,${ny}px)`;
  input.ix = nx / max;
  input.iz = -ny / max;
}
function stickEnd() {
  stick.id = null;
  input.stickActive = false;
  input.ix = 0; input.iz = 0;
  nubEl.style.transform = 'translate(0,0)';
  stickEl.classList.remove('on');
  stickEl.style.left = ''; stickEl.style.top = ''; stickEl.style.bottom = '';
}

let look = null;
addEventListener('pointerdown', e => {
  if (e.target.closest('button,.card,.chip,.sw,.tab,.closeBtn,.primary,.ghost,#panelWrap,#createWrap,#stick')) return;
  if (G.mode !== 'play') return;
  if (e.clientX < innerWidth * 0.44 && e.clientY > innerHeight * 0.32) {
    stickStart(e);
  } else {
    look = { id: e.pointerId, x: e.clientX, y: e.clientY };
  }
}, { passive: true });

addEventListener('pointermove', e => {
  if (stick.id === e.pointerId) { stickMove(e); return; }
  if (look && look.id === e.pointerId) {
    const dx = e.clientX - look.x, dy = e.clientY - look.y;
    look.x = e.clientX; look.y = e.clientY;
    G.cam.yaw += dx * 0.0062;
    G.cam.pitch = Math.max(-0.08, Math.min(0.95, G.cam.pitch + dy * 0.0042));
  }
}, { passive: true });

addEventListener('pointerup', e => {
  if (stick.id === e.pointerId) stickEnd();
  if (look && look.id === e.pointerId) look = null;
});
addEventListener('pointercancel', e => {
  if (stick.id === e.pointerId) stickEnd();
  if (look && look.id === e.pointerId) look = null;
});
addEventListener('wheel', e => {
  if (G.mode !== 'play') return;
  G.cam.dist = Math.max(4.2, Math.min(11, G.cam.dist + Math.sign(e.deltaY) * 0.6));
}, { passive: true });

/* ============================== 物理 / 模拟 ============================== */
function resolveColliders(p, radius) {
  for (const c of colliders) {
    const dx = p.x - c.x, dz = p.z - c.z;
    const d = Math.hypot(dx, dz);
    const min = c.r + radius;
    if (d < min && d > 0.0001) {
      const push = min - d;
      p.x += (dx / d) * push;
      p.z += (dz / d) * push;
    }
  }
  const r = Math.hypot(p.x, p.z);
  if (r > BOUND) { p.x = (p.x / r) * BOUND; p.z = (p.z / r) * BOUND; }
}

function stepHero(dt) {
  hero.invuln = Math.max(0, hero.invuln - dt);
  hero.hurtT = Math.max(0, hero.hurtT - dt);
  hero.roll = Math.max(0, hero.roll - dt);
  hero.stamDelay = Math.max(0, hero.stamDelay - dt);
  if (hero.stamDelay <= 0 && hero.stam < 100) hero.stam = Math.min(100, hero.stam + P.stamRegen * dt);

  if (hero.atk) {
    hero.atk.t += dt;
    if (!hero.atk.hit && hero.atk.t >= hero.atk.W.hitAt) { hero.atk.hit = true; heroStrike(hero.atk); }
    if (hero.atk.t >= hero.atk.dur) hero.atk = null;
  }

  const wet = inWater(hero.pos.x, hero.pos.z);
  let speed = P.walk * (wet ? 0.62 : 1);
  if (hero.atk) speed *= 0.24;

  if (hero.roll > 0) {
    const k = hero.roll / P.rollTime;
    const s = P.rollSpeed * (0.35 + 0.65 * k);
    hero.pos.x += hero.rollDir.x * s * dt;
    hero.pos.z += hero.rollDir.z * s * dt;
  } else {
    const dir = moveDir();
    if (dir.lengthSq() > 0.0001) {
      speed *= Math.min(1, dir.length());
      hero.pos.x += dir.x * speed * dt;
      hero.pos.z += dir.z * speed * dt;
      const ty = Math.atan2(dir.x, dir.z);
      let d = ty - hero.yaw;
      d = Math.atan2(Math.sin(d), Math.cos(d));
      hero.yaw += d * Math.min(1, dt * 13);
      hero.moveAmt = Math.min(1, hero.moveAmt + dt * 6);
      hero.stepT -= dt * Math.min(1, dir.length());
      if (hero.stepT <= 0) { hero.stepT = 0.30; fxPuff(hero.pos); }
    } else {
      hero.moveAmt = Math.max(0, hero.moveAmt - dt * 7);
    }
  }
  if (hero.roll > 0) hero.moveAmt = 1;

  resolveColliders(hero.pos, P.radius);
  let gh = heightAt(hero.pos.x, hero.pos.z);
  if (wet) gh = Math.max(gh, POND.water - 0.55);
  hero.pos.y += (gh - hero.pos.y) * Math.min(1, dt * 16);
  hero.groupY = hero.pos.y;

  if (heroModel) {
    heroModel.group.position.set(hero.pos.x, hero.pos.y, hero.pos.z);
    heroModel.group.rotation.y = hero.yaw;
    heroModel.group.visible = !hero.dead;
  }
}

function stepMonsters(dt) {
  for (const m of G.monsters) {
    const g = m.group;
    if (m.dead) {
      if (m.deadT < 1.0) {
        m.deadT += dt;
        g.position.y = m.pos.y - m.deadT * 1.1;
        if (m.deadT > 0.9) g.visible = false;
      }
      if (m.respawn > 0) {
        m.respawn -= dt;
        if (m.respawn <= 0) {
          m.dead = false; m.hp = m.maxHp; m.atk = null; m.hitT = 0; m.aggro = false;
          m.pos.set(m.home.x, heightAt(m.home.x, m.home.z), m.home.z);
          g.position.copy(m.pos); g.visible = true; m.vel.set(0, 0, 0); m.hb.bg.visible = false;
        }
      }
      continue;
    }
    if (m.hitT > 0) {
      m.hitT -= dt;
      m.pos.x += m.vel.x * dt; m.pos.z += m.vel.z * dt;
      m.vel.multiplyScalar(Math.pow(0.02, dt));
      resolveColliders(m.pos, m.def.radius);
      m.pos.y = heightAt(m.pos.x, m.pos.z);
      g.position.copy(m.pos);
      continue;
    }

    const dx = hero.pos.x - m.pos.x, dz = hero.pos.z - m.pos.z;
    const dist = Math.hypot(dx, dz);
    m.atkCd = Math.max(0, m.atkCd - dt);

    if (!hero.dead && dist < m.def.aggro) m.aggro = true;
    if (hero.dead) m.aggro = false;
    if (m.aggro && dist > m.def.aggro * 2.6) m.aggro = false;

    let moved = 0;
    if (m.atk) {
      m.atk.t += dt;
      const A = m.atk;
      if (A.type === 'melee') {
        if (!A.fired && A.t >= A.wind) {
          A.fired = true;
          if (dist < m.def.range + 0.8 && !hero.dead) {
            hurtHero(m.def.dmg, m.pos);
            fxSparks(new THREE.Vector3(hero.pos.x, hero.pos.y, hero.pos.z), 5, 0xff9a7a);
          }
        }
        if (A.t >= A.dur) { m.atk = null; m.atkCd = m.def.atkCd; }
      } else if (A.type === 'shoot') {
        if (!A.fired && A.t >= A.wind) {
          A.fired = true;
          shootArrow(m);
        }
        if (A.t >= A.dur) { m.atk = null; m.atkCd = m.def.atkCd; }
      } else if (A.type === 'slam') {
        if (!A.fired && A.t >= A.wind) {
          A.fired = true;
          fxRing(new THREE.Vector3(m.pos.x, m.pos.y, m.pos.z), 9, 0xffa050, 0.55);
          fxSparks(new THREE.Vector3(m.pos.x, m.pos.y, m.pos.z), 16, 0xffc07a);
          G.shake = 0.55;
          const d2 = Math.hypot(hero.pos.x - m.pos.x, hero.pos.z - m.pos.z);
          if (d2 < 6.4 && !hero.dead) hurtHero(m.def.dmg, m.pos);
        }
        if (A.t >= A.dur) { m.atk = null; m.atkCd = m.def.atkCd; m.combo = !m.combo; }
      } else if (A.type === 'charge') {
        if (!A.fired && A.t >= A.wind) { A.fired = true; G.shake = 0.3; }
        if (A.fired && A.t < A.wind + 0.55) {
          const sp = 15;
          m.pos.x += A.dir.x * sp * dt;
          m.pos.z += A.dir.z * sp * dt;
          moved = sp;
          const d3 = Math.hypot(hero.pos.x - m.pos.x, hero.pos.z - m.pos.z);
          if (d3 < 2.2 && !A.cHit && !hero.dead) { A.cHit = true; hurtHero(m.def.dmg * 0.8, m.pos); fxSparks(new THREE.Vector3(hero.pos.x, hero.pos.y, hero.pos.z), 8, 0xffb070); }
        }
        if (A.t >= A.wind + 0.55) { m.atk = null; m.atkCd = 1.1; m.combo = !m.combo; }
      }
    } else if (m.aggro && !hero.dead) {
      const ty = Math.atan2(dx, dz);
      let d = ty - m.yaw;
      d = Math.atan2(Math.sin(d), Math.cos(d));
      m.yaw += d * Math.min(1, dt * 7);

      if (m.kind === 'skeleton') {
        if (dist > m.def.keep) { m.pos.x += (dx / dist) * m.def.speed * dt; m.pos.z += (dz / dist) * m.def.speed * dt; moved = m.def.speed; }
        else if (dist < m.def.keep * 0.62) { m.pos.x -= (dx / dist) * m.def.speed * 0.9 * dt; m.pos.z -= (dz / dist) * m.def.speed * 0.9 * dt; moved = m.def.speed * 0.9; }
        if (dist < m.def.range && dist > 3.4 && m.atkCd <= 0) m.atk = { type: 'shoot', t: 0, wind: 0.55, dur: 0.85, fired: false };
      } else if (m.kind === 'boss') {
        if (dist > 3.6) { m.pos.x += (dx / dist) * m.def.speed * dt; m.pos.z += (dz / dist) * m.def.speed * dt; moved = m.def.speed; }
        if (m.atkCd <= 0 && dist < 12 && dist > 1.2) {
          if (m.combo) m.atk = { type: 'slam', t: 0, wind: 0.85, dur: 1.75, fired: false };
          else m.atk = { type: 'charge', t: 0, wind: 0.6, dur: 1.15, fired: false, dir: new THREE.Vector3(dx / dist, 0, dz / dist), cHit: false };
        }
      } else {
        if (dist > m.def.range * 0.82) { m.pos.x += (dx / dist) * m.def.speed * dt; m.pos.z += (dz / dist) * m.def.speed * dt; moved = m.def.speed; }
        else if (m.atkCd <= 0) m.atk = { type: 'melee', t: 0, wind: m.def.wind, dur: m.def.wind + 0.45, fired: false };
      }
    } else {
      // 巡逻
      m.idT -= dt;
      if (m.idT <= 0) {
        m.idT = 3 + Math.random() * 4;
        const a = Math.random() * 6.28, r = Math.random() * 6;
        m.wander.set(m.home.x + Math.cos(a) * r, 0, m.home.z + Math.sin(a) * r);
      }
      const wx = m.wander.x - m.pos.x, wz = m.wander.z - m.pos.z;
      const wd = Math.hypot(wx, wz);
      if (wd > 0.5) {
        m.pos.x += (wx / wd) * m.def.speed * 0.35 * dt;
        m.pos.z += (wz / wd) * m.def.speed * 0.35 * dt;
        moved = m.def.speed * 0.35;
        const ty = Math.atan2(wx, wz);
        let d = ty - m.yaw; d = Math.atan2(Math.sin(d), Math.cos(d));
        m.yaw += d * Math.min(1, dt * 4);
      }
    }

    resolveColliders(m.pos, m.def.radius);
    m.pos.y = heightAt(m.pos.x, m.pos.z);
    m.moveAmt += ((moved > 0.1 ? 1 : 0) - m.moveAmt) * Math.min(1, dt * 8);
    if (moved > 0.1) m.walkPhase += dt * (3.6 + moved * 1.2);
    g.position.set(m.pos.x, m.pos.y, m.pos.z);
    g.rotation.y = m.yaw;
    // 血条
    const shown = m.hp < m.maxHp || m.aggro;
    m.hb.bg.visible = shown && !m.dead;
    m.hb.bg.quaternion.copy(camera.quaternion);
    const r = Math.max(0, m.hp / m.maxHp);
    m.hb.fill.scale.x = Math.max(0.001, r);
    m.hb.fill.position.x = -(1 - r) * 0.42;
    m.hb.fill.material.color.setHex(r > 0.55 ? 0x8ce07a : r > 0.25 ? 0xe8c25a : 0xe05555);
    m.hb.bg.position.y = m.barY;
  }
}

function stepMonsterAnim(dt) {
  for (const m of G.monsters) {
    if (m.dead) continue;
    const r = m.rig;
    if (m.kind === 'slime') {
      const t = G.t * 6.5 + m.walkPhase;
      const squish = m.moveAmt > 0.3 ? Math.abs(Math.sin(t)) : 0.12 + Math.sin(G.t * 2.2) * 0.06;
      m.model.body.scale.set(1 + squish * 0.16, 1 - squish * 0.2, 1 + squish * 0.16);
      m.model.body.position.y = squish * 0.16;
      if (m.atk) {
        const p = Math.min(1, m.atk.t / m.atk.wind);
        m.model.body.position.y = Math.sin(p * Math.PI) * 0.55;
      }
    } else if (m.kind === 'boss') {
      const sw = Math.sin(m.walkPhase);
      r.body.position.y = Math.abs(Math.cos(m.walkPhase)) * 0.06 * m.moveAmt;
      if (r.legL) r.legL.rotation.x = sw * 0.4 * m.moveAmt;
      if (r.legR) r.legR.rotation.x = -sw * 0.4 * m.moveAmt;
      let armX = -sw * 0.3 * m.moveAmt;
      if (m.atk) {
        const p = Math.min(1, m.atk.t / (m.atk.wind + 0.4));
        if (m.atk.type === 'slam') armX = -2.4 * Math.sin(Math.min(1, m.atk.t / m.atk.wind) * Math.PI * 0.5) + (m.atk.t > m.atk.wind ? 2.4 * Math.min(1, (m.atk.t - m.atk.wind) / 0.25) : 0);
        else armX = 0.9;
      }
      r.L.sh.rotation.x = armX; r.R.sh.rotation.x = armX;
      r.L.el.rotation.x = Math.max(0, -armX) * 0.6; r.R.el.rotation.x = Math.max(0, -armX) * 0.6;
      if (m.hitT > 0) r.body.rotation.z = Math.sin(m.hitT * 60) * 0.04;
      else r.body.rotation.z = 0;
    } else {
      const sw = Math.sin(m.walkPhase);
      r.legL.rotation.x = sw * 0.7 * m.moveAmt;
      r.legR.rotation.x = -sw * 0.7 * m.moveAmt;
      r.kneeL.rotation.x = Math.max(0, -sw) * 0.7 * m.moveAmt;
      r.kneeR.rotation.x = Math.max(0, sw) * 0.7 * m.moveAmt;
      let armX = -sw * 0.5 * m.moveAmt;
      let armZ = 0.14;
      if (m.atk) {
        const p = Math.min(1, m.atk.t / (m.atk.wind + 0.3));
        armX = -2.0 * Math.sin(Math.min(1, m.atk.t / m.atk.wind) * Math.PI * 0.5);
        if (m.atk.t > m.atk.wind) armX = -2.0 + Math.min(1, (m.atk.t - m.atk.wind) / 0.3) * 2.6;
      }
      r.armR.rotation.x = armX;
      r.armR.rotation.z = -armZ;
      r.armL.rotation.x = -armX * 0.4;
      r.armL.rotation.z = armZ;
      if (m.kind === 'skeleton' && m.atk && m.atk.type === 'shoot') {
        r.armL.rotation.x = -1.35;
        r.armR.rotation.x = -1.15;
        r.armR.rotation.z = 0.5;
      }
      r.body.position.y = Math.abs(Math.cos(m.walkPhase)) * 0.035 * m.moveAmt;
      if (m.hitT > 0) r.body.rotation.z = Math.sin(m.hitT * 70) * 0.09;
      else r.body.rotation.z = 0;
    }
  }
}

function shootArrow(m) {
  const from = new THREE.Vector3(m.pos.x, m.pos.y + 1.15, m.pos.z);
  const dx = hero.pos.x - from.x, dz = hero.pos.z - from.z;
  const d = Math.hypot(dx, dz) || 1;
  const g = new THREE.Group();
  const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, 0.9, 5), new THREE.MeshStandardMaterial({ color: 0x6b4d2e }));
  shaft.rotation.x = Math.PI / 2;
  g.add(shaft);
  const tip = new THREE.Mesh(new THREE.ConeGeometry(0.055, 0.16, 5), new THREE.MeshStandardMaterial({ color: 0x9aa4ad, metalness: 0.7, roughness: 0.4 }));
  tip.rotation.x = Math.PI / 2; tip.position.z = 0.5;
  g.add(tip);
  g.position.copy(from);
  g.lookAt(hero.pos.x, from.y, hero.pos.z);
  scene.add(g);
  G.arrows.push({ mesh: g, pos: from.clone(), vel: new THREE.Vector3(dx / d * 19, 0, dz / d * 19), life: 2.2, dmg: m.def.dmg });
  fxSparks(from, 2, 0xd8e6ff);
}

function stepArrows(dt) {
  for (let i = G.arrows.length - 1; i >= 0; i--) {
    const a = G.arrows[i];
    a.life -= dt;
    a.pos.addScaledVector(a.vel, dt);
    a.mesh.position.copy(a.pos);
    const dh = Math.hypot(hero.pos.x - a.pos.x, hero.pos.z - a.pos.z);
    if (dh < 0.75 && Math.abs(hero.pos.y + 1.0 - a.pos.y) < 1.4) {
      hurtHero(a.dmg, a.pos);
      a.life = 0;
    }
    if (a.life <= 0) { scene.remove(a.mesh); disposeGroup(a.mesh); G.arrows.splice(i, 1); }
  }
}

function stepOrbs(dt) {
  for (let i = G.orbs.length - 1; i >= 0; i--) {
    const o = G.orbs[i];
    o.t += dt;
    const dx = hero.pos.x - o.pos.x, dy = hero.pos.y + 0.9 - o.pos.y, dz = hero.pos.z - o.pos.z;
    const d = Math.hypot(dx, dz);
    if (o.t > 0.35 && d < 6.5) {
      o.pos.x += (dx / d) * 14 * dt;
      o.pos.z += (dz / d) * 14 * dt;
      o.pos.y += dy * Math.min(1, dt * 8);
      if (d < 0.8) {
        G.gold += o.value;
        floatText(hero.pos.x, hero.pos.y + 1.6, hero.pos.z, '+' + o.value, 'gain');
        scene.remove(o.mesh); o.mesh.geometry.dispose(); o.mesh.material.dispose();
        G.orbs.splice(i, 1);
        continue;
      }
    } else {
      o.pos.addScaledVector(o.vel, dt);
      o.vel.y -= 13 * dt;
      const gh = heightAt(o.pos.x, o.pos.z) + 0.14;
      if (o.pos.y < gh) { o.pos.y = gh; o.vel.set(o.vel.x * 0.6, Math.abs(o.vel.y) * 0.32, o.vel.z * 0.6); }
      o.vel.x *= 0.99; o.vel.z *= 0.99;
    }
    if (o.t > 24) { scene.remove(o.mesh); G.orbs.splice(i, 1); }
    o.mesh.position.copy(o.pos);
  }
}

/* 英雄动画 */
function heroAnim(dt) {
  if (!heroModel) return;
  const rig = heroModel.rig, body = heroModel.body;
  const sw = Math.sin(hero.walkPhase);
  if (hero.moveAmt > 0.02 && hero.roll <= 0) hero.walkPhase += dt * (6.2 + hero.moveAmt * 3.4);

  let armRX = -0.16, armRZ = -0.24, armLX = 0, armLZ = 0.18, torsoY = 0;
  if (hero.roll > 0) {
    const p = 1 - hero.roll / P.rollTime;
    body.rotation.x = -p * Math.PI * 2;
    body.position.y = Math.sin(p * Math.PI) * 0.45;
    rig.legL.rotation.x = 1.1; rig.legR.rotation.x = 0.6;
    rig.kneeL.rotation.x = 1.4; rig.kneeR.rotation.x = 1.5;
    rig.armL.rotation.x = 1.2; rig.armR.rotation.x = 1.1;
    return;
  }
  body.rotation.x = 0;
  body.rotation.z = sw * 0.03 * hero.moveAmt;

  if (hero.atk) {
    const p = hero.atk.t / hero.atk.dur;
    let a;
    if (p < 0.30) a = (p / 0.30) * 1.55;
    else if (p < 0.56) a = 1.55 - ((p - 0.30) / 0.26) * 3.3;
    else a = -1.75 * (1 - (p - 0.56) / 0.44);
    armRX = a;
    armRZ = -0.5;
    torsoY = -a * 0.26;
    rig.armL.rotation.x = -0.5 - a * 0.18;
    rig.torso.rotation.y = torsoY;
    rig.head.rotation.y = torsoY * -0.35;
    body.position.y = Math.abs(Math.sin(p * Math.PI)) * 0.05;
  } else {
    armRX = -0.16 + sw * 0.55 * hero.moveAmt;
    armLX = -sw * 0.62 * hero.moveAmt;
    rig.torso.rotation.y = 0;
    rig.head.rotation.y = 0;
    body.position.y = Math.abs(Math.cos(hero.walkPhase)) * 0.035 * hero.moveAmt + Math.sin(G.t * 1.9) * 0.008;
    rig.legL.rotation.x = sw * 0.68 * hero.moveAmt;
    rig.legR.rotation.x = -sw * 0.68 * hero.moveAmt;
    rig.kneeL.rotation.x = Math.max(0, -sw) * 0.8 * hero.moveAmt;
    rig.kneeR.rotation.x = Math.max(0, sw) * 0.8 * hero.moveAmt;
  }
  if (hero.hurtT > 0) { body.rotation.z = Math.sin(hero.hurtT * 60) * 0.07; body.position.y -= 0.03; }
  rig.armR.rotation.x += (armRX - rig.armR.rotation.x) * Math.min(1, dt * 26);
  rig.armR.rotation.z = armRZ;
  rig.armL.rotation.x += (armLX - rig.armL.rotation.x) * Math.min(1, dt * 20);
  rig.armL.rotation.z = armLZ;
  rig.armR.rotation.y = 0;
  const elR = hero.atk ? -0.62 : -0.34, elL = hero.atk ? -0.18 : -0.12;
  if (rig.elbowR) rig.elbowR.rotation.x += (elR - rig.elbowR.rotation.x) * Math.min(1, dt * 18);
  if (rig.elbowL) rig.elbowL.rotation.x += (elL - rig.elbowL.rotation.x) * Math.min(1, dt * 18);
  if (!hero.atk) { rig.legL.rotation.x = sw * 0.68 * hero.moveAmt; rig.legR.rotation.x = -sw * 0.68 * hero.moveAmt; }

  if (hero.dead) {
    const p = Math.min(1, (2.6 - G.deadT) * 2.2);
    body.rotation.z = p * (Math.PI / 2) * 0.9;
    body.position.y = 0;
  }
}

/* 场景动态 */
function stepWorldFx(dt) {
  for (const f of FIRELIGHTS) {
    const t = G.t * 9 + f.light.id;
    f.light.intensity = 18 + Math.sin(t) * 3 + Math.random() * 2;
    f.mesh.scale.y = 0.9 + Math.sin(t * 1.3) * 0.12;
    if (f.mesh2) f.mesh2.scale.y = 0.9 + Math.sin(t * 1.7 + 1) * 0.14;
  }
  if (G.portalRing) {
    G.portalRing.rotation.z += dt * 0.4;
    G.portalRing.material.opacity = 0.55 + Math.sin(G.t * 2.2) * 0.18;
  }
  if (G.dungeonRing) {
    G.dungeonRing.rotation.z -= dt * 0.4;
    G.dungeonRing.material.opacity = 0.55 + Math.sin(G.t * 2.0) * 0.18;
  }
  if (G.dungeonRune) { G.dungeonRune.rotation.z += dt * 0.22; }
  for (let i = G.fx.length - 1; i >= 0; i--) {
    const f = G.fx[i];
    f.t += dt;
    const p = Math.min(1, f.t / f.life);
    if (f.update) f.update(f.mesh, p, dt);
    if (p >= 1) { scene.remove(f.mesh); disposeGroup(f.mesh); G.fx.splice(i, 1); }
  }
}

/* ============================== 相机 ============================== */
const camPos = new THREE.Vector3(0, 8, 40);
const camLook = new THREE.Vector3();

// 相机别穿墙/穿树/钻地：沿 target->camera 线段找最近的遮挡，把相机拉近
function clampCamSegment(tx, ty, tz, des, target) {
  const dx = des.x - tx, dz = des.z - tz;
  const segLen2 = dx * dx + dz * dz;
  let tBest = 1;
  if (segLen2 > 1e-6) {
    for (const c of colliders) {
      const fx = tx - c.x, fz = tz - c.z;
      const rad = c.r + 0.42;
      const b = 2 * (fx * dx + fz * dz);
      const cc = fx * fx + fz * fz - rad * rad;
      const disc = b * b - 4 * segLen2 * cc;
      if (disc <= 0) continue;
      const t1 = (-b - Math.sqrt(disc)) / (2 * segLen2);
      if (t1 > 0.05 && t1 < tBest) tBest = t1;
    }
  }
  for (let i = 1; i <= 7; i++) {
    const t = i / 7;
    const px = tx + dx * t, pz = tz + dz * t, py = ty + (des.y - ty) * t;
    if (py < heightAt(px, pz) + 0.55) { tBest = Math.min(tBest, Math.max(0.2, t - 0.1)); break; }
  }
  if (tBest < 1) {
    const t = tBest * 0.94;
    des.set(tx + dx * t, ty + (des.y - ty) * t, tz + dz * t);
  }
  const gh = heightAt(des.x, des.z);
  if (des.y < gh + 0.5) des.y = gh + 0.5;
}

// 创建/换装时相机绕着角色转，只要保证相机点本身不在树里、不在地下
function unstickCam(des, tx, ty, tz) {
  for (let k = 0; k < 3; k++) {
    let bad = false;
    for (const c of colliders) {
      if (Math.hypot(des.x - c.x, des.z - c.z) < c.r + 0.45) { bad = true; break; }
    }
    const gh = heightAt(des.x, des.z);
    if (des.y < gh + 0.7) bad = true;
    if (!bad) break;
    des.lerp(new THREE.Vector3(tx, ty, tz), 0.34);
    des.y = Math.max(des.y, heightAt(des.x, des.z) + 0.7);
  }
}

function updateCamera(dt) {
  const c = G.cam;
  let dist = c.dist, pitch = c.pitch, targetY = 1.35, yaw = c.yaw;
  if (G.mode === 'creation') {
    yaw += G.t * 0.22;
    dist = 5.2; pitch = 0.45; targetY = -0.55;
  } else if (G.mode === 'gear') {
    yaw += G.t * 0.14;
    dist = 4.9; pitch = 0.42; targetY = -0.50;
  } else if (G.mode === 'dead') {
    dist = 5.6; pitch = 0.35;
  }
  const tx = hero.pos.x, ty = hero.pos.y + targetY, tz = hero.pos.z;
  const vx = Math.sin(yaw), vz = Math.cos(yaw);
  const des = new THREE.Vector3(tx - vx * dist * Math.cos(pitch), ty + Math.sin(pitch) * dist, tz - vz * dist * Math.cos(pitch));
  if (G.mode === 'play' || G.mode === 'dead') clampCamSegment(tx, ty, tz, des);
  else unstickCam(des, tx, ty, tz);
  const k = 1 - Math.exp(-dt * (G.mode === 'creation' || G.mode === 'gear' ? 6 : 9));
  camPos.lerp(des, k);
  const lookDes = new THREE.Vector3(tx, ty, tz);
  camLook.lerp(lookDes, 1 - Math.exp(-dt * 12));
  camera.position.copy(camPos);
  if (G.shake > 0.001) {
    camera.position.x += (Math.random() - 0.5) * G.shake;
    camera.position.y += (Math.random() - 0.5) * G.shake;
    G.shake *= Math.pow(0.02, dt);
  }
  camera.lookAt(camLook);
  const fov = innerWidth < innerHeight ? 66 : 58;
  if (Math.abs(camera.fov - fov) > 0.1) { camera.fov = fov; camera.updateProjectionMatrix(); }
}
camLook.set(hero.pos.x, hero.pos.y + 1.3, hero.pos.z);

/* ============================== 模拟主步 ============================== */
function simulate(dt) {
  if (hitstop > 0) { hitstop -= dt; }
  else {
    G.t += dt;
    if (G.mode === 'play') {
      updateKeyMove();
      stepHero(dt);
      stepMonsters(dt);
      stepArrows(dt);
      stepOrbs(dt);
    } else if (G.mode === 'dead') {
      hero.invuln = Math.max(0, hero.invuln - dt);
      G.deadT -= dt;
      stepMonsters(dt);
      stepArrows(dt);
      if (G.deadT <= 0) respawnHero();
    } else {
      // creation / gear：只做呼吸
      hero.moveAmt = 0;
      if (heroModel) {
        heroModel.group.position.set(hero.pos.x, hero.pos.y, hero.pos.z);
        heroModel.group.rotation.y = hero.yaw;
      }
    }
    heroAnim(dt);
    stepMonsterAnim(dt);
    stepWorldFx(dt);
    if (G.mode === 'creation' || G.mode === 'gear' || G.mode === 'play') stepOrbs(dt);
  }
  // 文字
  for (let i = G.texts.length - 1; i >= 0; i--) {
    const t = G.texts[i];
    t.t += dt;
    if (t.t > t.life) { t.el.remove(); G.texts.splice(i, 1); }
  }
}


/* ============================== 地图切换 / 传送门 ============================== */
const useBtn = document.getElementById('btnUse');
const useLabel = document.getElementById('useLabel');
const fadeEl = document.getElementById('fade');
let nearPortal = null;
let switching = false;

function enterMap(id, silent) {
  const m = MAPS[id];
  if (!m || switching) return;
  switching = true;
  activeMap = m; activeId = id; HF = m.h; BOUND = m.bound;
  mapGroups.overworld.visible = id === 'overworld';
  mapGroups.dungeon.visible = id === 'dungeon';
  if (skyMesh) skyMesh.visible = m.sky;
  colliders.length = 0;
  for (const c of m.solids) colliders.push(c);
  G.monsters = ALL_MONSTERS.filter(x => x.mapId === id);
  for (const a of G.arrows) { scene.remove(a.mesh); disposeGroup(a.mesh); }
  G.arrows.length = 0;
  for (const o of G.orbs) { scene.remove(o.mesh); }
  G.orbs.length = 0;
  for (const f of G.fx) { scene.remove(f.mesh); disposeGroup(f.mesh); }
  G.fx.length = 0;
  for (const t of G.texts) t.el.remove();
  G.texts.length = 0;
  hero.pos.set(m.spawn.x, m.h(m.spawn.x, m.spawn.z) + 0.05, m.spawn.z);
  hero.yaw = m.face; hero.atk = null; hero.roll = 0; hero.invuln = 0.8;
  hero.vel.set(0, 0, 0); hero.moveAmt = 0;
  if (heroModel) {
    heroModel.group.position.copy(hero.pos);
    heroModel.group.rotation.y = hero.yaw;
    heroModel.group.visible = !hero.dead;
  }
  scene.fog.color.setHex(m.fog.c);
  scene.fog.near = m.fog.n; scene.fog.far = m.fog.f;
  sun.intensity = m.sun; hemi.intensity = m.hemi;
  if (typeof ambient !== 'undefined' && ambient) ambient.intensity = m.amb;
  G.cam.yaw = hero.yaw;
  camPos.set(m.spawn.x + Math.sin(G.cam.yaw + Math.PI) * 6.4, m.spawn.y + 3.2, m.spawn.z + Math.cos(G.cam.yaw + Math.PI) * 6.4);
  updateCamera(1.2); updateCamera(1.2);
  nearPortal = null;
  useBtn.classList.add('hidden');
  if (!silent) banner(m.label, id === 'dungeon' ? '深入废墟 · 石像守卫在等你' : '回到灰烬原野');
  updateHUD();
  setTimeout(() => { switching = false; }, 140);
}

function updatePortalPrompt() {
  let p = null;
  if (G.mode === 'play' && !switching && activeMap && activeMap.portal) {
    const q = activeMap.portal;
    if (Math.hypot(hero.pos.x - q.x, hero.pos.z - q.z) < q.r) p = q;
  }
  if (p !== nearPortal) {
    nearPortal = p;
    if (p) { useLabel.textContent = p.text; useBtn.classList.remove('hidden'); }
    else useBtn.classList.add('hidden');
  }
}

function usePortal() {
  if (G.mode !== 'play' || switching) return;
  updatePortalPrompt();
  if (!nearPortal) return;
  const to = nearPortal.to;
  fadeEl.style.opacity = '1';
  setTimeout(() => { enterMap(to); fadeEl.style.opacity = '0'; }, 360);
}

/* ============================== HUD ============================== */
const $ = id => document.getElementById(id);
const elHpFill = $('hpFill'), elHpTxt = $('hpTxt'), elStFill = $('stFill'),
  elGold = $('goldTxt'), elLvl = $('lvlTxt'), elLvlBadge = $('lvlBadge'),
  elBossBar = $('bossBar'), elBossFill = $('bossHpFill'), elBossTxt = $('bossHpTxt'),
  elQuest = $('quest'), elQuestName = $('questName'), elQuestSub = $('questSub'), elDiag = $('diag');

const elControls = document.getElementById('controls');
function updateHUD() {
  elControls.style.display = (G.mode === 'play' || G.mode === 'dead') ? '' : 'none';
  const hpR = Math.max(0, hero.hp / maxHp());
  elHpFill.style.transform = `scaleX(${hpR})`;
  elHpTxt.textContent = Math.ceil(Math.max(0, hero.hp)) + ' / ' + maxHp();
  elStFill.style.transform = `scaleX(${Math.max(0, hero.stam) / 100})`;
  elGold.textContent = G.gold;
  elLvl.textContent = G.level;
  elLvlBadge.textContent = G.level;
  const boss = ALL_MONSTERS.find(m => m.kind === 'boss');
  if (boss && !boss.dead && G.bossAggro && activeId === 'dungeon') {
    elBossBar.classList.remove('hidden');
    elBossFill.style.transform = `scaleX(${Math.max(0, boss.hp / boss.maxHp)})`;
    elBossTxt.textContent = Math.ceil(boss.hp) + ' / ' + boss.maxHp;
  } else elBossBar.classList.add('hidden');
  if (G.mode === 'play' || G.mode === 'dead') {
    elQuest.classList.remove('hidden');
    if (G.bossDead) { elQuestName.textContent = '废墟已清除'; elQuestSub.textContent = '守卫倒下 · 铁门后的深处仍待探索'; }
    else if (activeId === 'dungeon') { elQuestName.textContent = '击败石像守卫'; elQuestSub.textContent = G.bossAggro ? '它苏醒了 · 翻滚躲开砸地' : '沿符文圈向前'; }
    else { elQuestName.textContent = '进入废墟副本'; elQuestSub.textContent = '沿营火北面的石阶走进拱门'; }
  } else elQuest.classList.add('hidden');
  updatePortalPrompt();
}

let fpsT = 0, fpsN = 0, fpsVal = 60, diagT = 0, miniT = 0;
const mini = $('mini'), mctx = mini.getContext('2d');

function drawMini() {
  const W = mini.width, H = mini.height, cx = W / 2, cy = H / 2;
  if (activeId === 'dungeon') {
    const s2 = (W * 0.44) / 24;
    mctx.clearRect(0, 0, W, H);
    mctx.fillStyle = '#101418'; mctx.fillRect(0, 0, W, H);
    mctx.save();
    mctx.beginPath(); mctx.arc(cx, cy, W * 0.47, 0, 7); mctx.clip();
    mctx.fillStyle = '#2a2a26';
    mctx.fillRect(cx - 22 * s2, cy - 27 * s2, 44 * s2, 54 * s2);
    mctx.strokeStyle = '#6e6a60'; mctx.lineWidth = 3;
    mctx.strokeRect(cx - 22 * s2, cy - 27 * s2, 44 * s2, 54 * s2);
    mctx.beginPath(); mctx.arc(cx, cy - 18.5 * s2, 7.4 * s2, 0, 7);
    mctx.fillStyle = '#3a3630'; mctx.fill();
    mctx.beginPath(); mctx.arc(cx, cy + 24.6 * s2, 4.5, 0, 7);
    mctx.fillStyle = '#6fd0ff'; mctx.fill();
    for (const mo of G.monsters) {
      if (mo.dead) continue;
      mctx.beginPath();
      mctx.arc(cx + mo.pos.x * s2, cy + mo.pos.z * s2, mo.kind === 'boss' ? 6 : 3.2, 0, 7);
      mctx.fillStyle = mo.kind === 'boss' ? '#ff7a45' : (mo.aggro ? '#ff5b5b' : '#c98f5a');
      mctx.fill();
    }
    const px2 = cx + hero.pos.x * s2, py2 = cy + hero.pos.z * s2;
    const va = Math.atan2(Math.cos(G.cam.yaw), Math.sin(G.cam.yaw));
    mctx.save(); mctx.translate(px2, py2); mctx.rotate(va);
    mctx.beginPath(); mctx.moveTo(0, 0); mctx.arc(0, 0, 22, -0.55, 0.55); mctx.closePath();
    mctx.fillStyle = 'rgba(120,220,255,.18)'; mctx.fill();
    mctx.restore();
    mctx.beginPath(); mctx.arc(px2, py2, 4.6, 0, 7); mctx.fillStyle = '#8ce07a'; mctx.fill();
    mctx.lineWidth = 1.5; mctx.strokeStyle = '#0b1016'; mctx.stroke();
    mctx.beginPath(); mctx.arc(cx, cy, W * 0.47, 0, 7);
    mctx.strokeStyle = 'rgba(231,194,125,.35)'; mctx.lineWidth = 2; mctx.stroke();
    mctx.restore();
    return;
  }
  const sc = (W * 0.44) / BOUND;
  mctx.clearRect(0, 0, W, H);
  mctx.save();
  mctx.beginPath(); mctx.arc(cx, cy, W * 0.47, 0, 7); mctx.clip();
  mctx.fillStyle = '#121a12'; mctx.fillRect(0, 0, W, H);
  // 水
  mctx.beginPath();
  mctx.arc(cx + POND.x * sc, cy + POND.z * sc, POND.r * sc, 0, 7);
  mctx.fillStyle = '#26566b'; mctx.fill();
  // 废墟
  mctx.fillStyle = '#4a4a42';
  mctx.fillRect(cx - 16.5 * sc, cy - 59 * sc, 33 * sc, 26 * sc);
  mctx.fillStyle = '#5c5c52';
  mctx.fillRect(cx - 2.1 * sc, cy - 59 * sc, 4.2 * sc, 2.5 * sc);
  // 怪
  for (const m of G.monsters) {
    if (m.dead) continue;
    mctx.beginPath();
    mctx.arc(cx + m.pos.x * sc, cy + m.pos.z * sc, m.kind === 'boss' ? 6 : 3.2, 0, 7);
    mctx.fillStyle = m.kind === 'boss' ? '#ff7a45' : (m.aggro ? '#ff5b5b' : '#c98f5a');
    mctx.fill();
    if (m.kind === 'boss') { mctx.strokeStyle = '#ffd6a0'; mctx.lineWidth = 2; mctx.stroke(); }
  }
  // 玩家 + 视野扇形
  const px = cx + hero.pos.x * sc, py = cy + hero.pos.z * sc;
  const viewAng = Math.atan2(Math.cos(G.cam.yaw), Math.sin(G.cam.yaw));
  mctx.save();
  mctx.translate(px, py); mctx.rotate(viewAng);
  mctx.beginPath(); mctx.moveTo(0, 0); mctx.arc(0, 0, 26, -0.55, 0.55); mctx.closePath();
  mctx.fillStyle = 'rgba(120,220,255,.18)'; mctx.fill();
  mctx.restore();
  mctx.beginPath(); mctx.arc(px, py, 4.6, 0, 7); mctx.fillStyle = '#8ce07a'; mctx.fill();
  mctx.lineWidth = 1.5; mctx.strokeStyle = '#0b1016'; mctx.stroke();
  mctx.beginPath(); mctx.arc(cx, cy, W * 0.47, 0, 7); mctx.strokeStyle = 'rgba(231,194,125,.35)'; mctx.lineWidth = 2; mctx.stroke();
  mctx.restore();
}

function hudTick(dt) {
  updateHUD();
  fpsT += dt; fpsN++; diagT += dt;
  if (fpsT >= 0.5) { fpsVal = Math.round(fpsN / fpsT); fpsT = 0; fpsN = 0; }
  if (diagT > 0.25) {
    diagT = 0;
    const alive = G.monsters.filter(m => !m.dead).length;
    const near = G.monsters.filter(m => !m.dead).reduce((a, m) => Math.min(a, Math.hypot(m.pos.x - hero.pos.x, m.pos.z - hero.pos.z)), 999);
    elDiag.textContent = `v:${BUILD} · ${fpsVal}fps · 怪 ${alive}/${G.monsters.length} · 最近 ${near > 900 ? '—' : near.toFixed(1) + 'm'} · HP ${Math.ceil(hero.hp)} · ${hero.pos.x.toFixed(0)},${hero.pos.z.toFixed(0)}`;
  }
  miniT += dt;
  if (miniT > 0.1) { miniT = 0; drawMini(); }

  // 浮动文字投影
  for (const t of G.texts) {
    const p = new THREE.Vector3(t.x, t.y + t.t * t.vy, t.z);
    p.project(camera);
    const sx = (p.x * 0.5 + 0.5) * innerWidth, sy = (-p.y * 0.5 + 0.5) * innerHeight;
    const k = 1 - t.t / t.life;
    t.el.style.transform = `translate(-50%,-50%) translate(${sx + t.dx * 40 * t.t}px,${sy}px) scale(${0.85 + (1 - k) * 0.3})`;
    t.el.style.opacity = String(Math.min(1, k * 2.2));
    if (p.z > 1) t.el.style.opacity = '0';
  }
}

/* ============================== 面板 / 按钮 ============================== */
let bannerT = null;
function banner(big, sub = '') {
  const el = $('banner');
  el.querySelector('.big').textContent = big;
  el.querySelector('.sub').textContent = sub;
  el.classList.remove('hidden');
  el.style.animation = 'none';
  void el.offsetWidth;
  el.style.animation = 'sheetIn .3s ease-out';
  clearTimeout(bannerT);
  bannerT = setTimeout(() => el.classList.add('hidden'), 2200);
}
let toastT = null;
function showToast(txt) {
  const el = $('toast');
  el.textContent = txt;
  el.classList.remove('hidden');
  clearTimeout(toastT);
  toastT = setTimeout(() => el.classList.add('hidden'), 2400);
}

/* 角色创建 */
function buildCreateUI() {
  const A = G.appearance;
  const swSkin = $('swSkin');
  swSkin.innerHTML = '';
  SKINS.forEach((c, i) => {
    const d = document.createElement('div');
    d.className = 'sw' + (A.skin === i ? ' on' : '');
    d.style.background = c;
    d.onclick = () => { A.skin = i; rebuildHero(); buildCreateUI(); };
    swSkin.appendChild(d);
  });
  const swHair = $('swHair');
  swHair.innerHTML = '';
  HAIRCOLORS.forEach((c, i) => {
    const d = document.createElement('div');
    d.className = 'sw' + (A.hairColor === i ? ' on' : '');
    d.style.background = c;
    d.onclick = () => { A.hairColor = i; rebuildHero(); buildCreateUI(); };
    swHair.appendChild(d);
  });
  const chHair = $('chHair');
  chHair.innerHTML = '';
  HAIRSTYLES.forEach((h, i) => {
    const d = document.createElement('div');
    d.className = 'chip' + (A.hair === i ? ' on' : '');
    d.textContent = h.n;
    d.onclick = () => { A.hair = i; rebuildHero(); buildCreateUI(); };
    chHair.appendChild(d);
  });
  const chBuild = $('chBuild');
  chBuild.innerHTML = '';
  BUILDS.forEach((b, i) => {
    const d = document.createElement('div');
    d.className = 'chip' + (A.build === i ? ' on' : '');
    d.textContent = b.n;
    d.onclick = () => { A.build = i; rebuildHero(); buildCreateUI(); };
    chBuild.appendChild(d);
  });
  const chW = $('chWeapon');
  chW.innerHTML = '';
  ['sword', 'greatsword', 'spear'].forEach(id => {
    const W = WEAPONS[id];
    const d = document.createElement('div');
    d.className = 'card' + (G.gear.weapon === id ? ' on' : '');
    d.innerHTML = `<div class="ci"><svg class="ic"><use href="#${W.icon}"/></svg></div>
      <div><div class="cn">${W.name}</div><div class="cs">伤害 ${W.dmg} · 范围 ${W.range}${W.desc ? '<br>' + W.desc : ''}</div></div>`;
    d.onclick = () => { G.gear.weapon = id; rebuildHero(); buildCreateUI(); };
    chW.appendChild(d);
  });
  $('cAtk').textContent = Math.round(WEAPONS[G.gear.weapon].dmg);
  $('cDef').textContent = Math.round(ARMOR[G.gear.armor].def * 100) + '%';
  $('cHp').textContent = maxHp();
}

function armorModelId() { return G.gear.armor; }

/* 装备面板 */
let panelTab = 'gear';
function renderPanel() {
  const body = $('panelBody');
  const A = G.appearance;
  if (panelTab === 'gear') {
    const wCards = Object.entries(WEAPONS).map(([id, W]) => {
      const on = G.gear.weapon === id;
      const lock = W.locked;
      return `<div class="card${on ? ' on' : ''}${lock ? ' lock' : ''}" data-w="${id}">
        <div class="ci"><svg class="ic"><use href="#${lock ? 'i-x' : W.icon}"/></svg></div>
        <div><div class="cn">${W.name}${on ? ' <span class="tag">已装备</span>' : ''}</div>
        <div class="cs">伤害 ${W.dmg} · 范围 ${W.range.toFixed(1)}${lock ? '<br>击败石像守卫解锁' : ''}</div></div></div>`;
    }).join('');
    const aCards = Object.entries(ARMOR).map(([id, A2]) => {
      const on = G.gear.armor === id;
      return `<div class="card${on ? ' on' : ''}" data-a="${id}">
        <div class="ci"><svg class="ic"><use href="#i-shield"/></svg></div>
        <div><div class="cn">${A2.name}${on ? ' <span class="tag">已装备</span>' : ''}</div>
        <div class="cs">${A2.desc}</div></div></div>`;
    }).join('');
    body.innerHTML = `
      <div class="statRow">
        <div class="stat"><div class="k">攻击</div><div class="v">${Math.round(WEAPONS[G.gear.weapon].dmg * atkPower())}</div></div>
        <div class="stat"><div class="k">减伤</div><div class="v">${Math.round(ARMOR[G.gear.armor].def * 100)}%</div></div>
        <div class="stat"><div class="k">生命</div><div class="v">${maxHp()}</div></div>
      </div>
      <div class="secTitle">武器</div><div class="grid">${wCards}</div>
      <div class="secTitle">护甲</div><div class="grid">${aCards}</div>
      <div class="secTitle">体魄强化</div>
      <div class="card" id="btnUpgrade" style="justify-content:center;text-align:center">
        <div><div class="cn" style="justify-content:center">锻炼体魄 · 生命上限 +15</div>
        <div class="cs">消耗 60 金币 · 当前金币 ${G.gold}</div></div>
      </div>`;
    body.querySelectorAll('[data-w]').forEach(el => {
      el.onclick = () => {
        const id = el.getAttribute('data-w');
        if (WEAPONS[id].locked) { showToast('裂石战斧由石像守卫把守'); return; }
        G.gear.weapon = id; rebuildHero(); renderPanel();
      };
    });
    body.querySelectorAll('[data-a]').forEach(el => {
      el.onclick = () => { G.gear.armor = el.getAttribute('data-a'); rebuildHero(); renderPanel(); };
    });
    const up = body.querySelector('#btnUpgrade');
    if (up) up.onclick = () => {
      if (G.hpBoost >= 150) { showToast('体魄已达上限'); return; }
      if (G.gold < 60) { showToast('金币不足（需要 60）'); return; }
      G.gold -= 60; G.hpBoost += 15; hero.hp = Math.min(maxHp(), hero.hp + 15);
      showToast('生命上限 +15'); renderPanel();
    };
  } else {
    body.innerHTML = `
      <div class="secTitle">肤色</div><div class="swatches" id="pSkin"></div>
      <div class="secTitle">发型</div><div class="chipRow" id="pHair"></div>
      <div class="secTitle">发色</div><div class="swatches" id="pHairC"></div>
      <div class="secTitle">体型</div><div class="chipRow" id="pBuild"></div>
      <div class="hintLine">外观改动会立即反映到角色模型上，关闭面板即可继续冒险。</div>`;
    const box = body.querySelector('#pSkin');
    SKINS.forEach((c, i) => {
      const d = document.createElement('div');
      d.className = 'sw' + (A.skin === i ? ' on' : ''); d.style.background = c;
      d.onclick = () => { A.skin = i; rebuildHero(); renderPanel(); };
      box.appendChild(d);
    });
    const hb = body.querySelector('#pHair');
    HAIRSTYLES.forEach((h, i) => {
      const d = document.createElement('div');
      d.className = 'chip' + (A.hair === i ? ' on' : ''); d.textContent = h.n;
      d.onclick = () => { A.hair = i; rebuildHero(); renderPanel(); };
      hb.appendChild(d);
    });
    const hc = body.querySelector('#pHairC');
    HAIRCOLORS.forEach((c, i) => {
      const d = document.createElement('div');
      d.className = 'sw' + (A.hairColor === i ? ' on' : ''); d.style.background = c;
      d.onclick = () => { A.hairColor = i; rebuildHero(); renderPanel(); };
      hc.appendChild(d);
    });
    const bb = body.querySelector('#pBuild');
    BUILDS.forEach((b, i) => {
      const d = document.createElement('div');
      d.className = 'chip' + (A.build === i ? ' on' : ''); d.textContent = b.n;
      d.onclick = () => { A.build = i; rebuildHero(); renderPanel(); };
      bb.appendChild(d);
    });
  }
}

function openPanel(tab = 'gear') {
  if (G.mode === 'creation' || G.mode === 'dead') return;
  panelTab = tab;
  G.mode = 'gear';
  G.cam.yaw = hero.yaw + Math.PI;
  $('panelWrap').classList.remove('hidden');
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('on', t.getAttribute('data-tab') === tab));
  $('pTitle').textContent = tab === 'gear' ? '装备' : '外观';
  $('pSub').textContent = tab === 'gear' ? '在营火旁整理你的行装' : '随时可以重新塑造自己';
  renderPanel();
  updateHUD();
}
function closePanel() {
  if (G.mode !== 'gear') return;
  $('panelWrap').classList.add('hidden');
  G.mode = 'play';
  G.cam.yaw = hero.yaw + Math.PI;
}
function toggleGear() {
  if (G.mode === 'gear') closePanel();
  else if (G.mode === 'play') openPanel('gear');
}

$('btnGear').onclick = () => toggleGear();
$('btnPanelClose').onclick = closePanel;
$('btnResume').onclick = closePanel;
$('panelWrap').addEventListener('click', e => { if (e.target.id === 'panelWrap') closePanel(); });
document.querySelectorAll('.tab').forEach(t => t.onclick = () => { panelTab = t.getAttribute('data-tab'); openPanel(panelTab); });
$('btnHelp').onclick = () => showToast(innerWidth < 760 ? '左摇杆移动 · 右半屏拖拽转视角' : 'WASD 移动 · 拖拽转视角 · J 攻击 · Shift 翻滚 · Tab 装备');
$('btnAtk').onclick = () => doAttack();
$('btnRoll').onclick = () => doRoll();
$('btnUse').onclick = () => usePortal();
$('btnUse').addEventListener('pointerdown', e => { e.preventDefault(); e.stopPropagation(); usePortal(); });

// 按钮触摸响应更快
for (const [id, fn] of [['btnAtk', doAttack], ['btnRoll', doRoll]]) {
  const el = $(id);
  el.addEventListener('pointerdown', e => { e.preventDefault(); e.stopPropagation(); fn(); });
}

function startGame() {
  G.mode = 'play';
  $('createWrap').classList.add('hidden');
  G.cam.yaw = Math.PI;
  G.cam.pitch = 0.30;
  G.cam.dist = 7;
  G.t = 0;
  hero.hp = maxHp();
  hero.stam = 100;
  banner('灰烬遗迹', '向北 · 穿过石阶');
  setTimeout(() => { if (G.mode === 'play') showToast('营火旁是安全的 · 冒烟的废墟在北面'); }, 1800);
  updateHUD();
}
$('btnStart').onclick = startGame;

/* ============================== 循环 ============================== */
const perf = { frames: 0, sim: 0, render: 0, lastSim: 0, lastRender: 0 };
let lastT = performance.now(), acc = 0;
function loop(now) {
  requestAnimationFrame(loop);
  const raw = Math.max(0, (now - lastT) / 1000);
  lastT = now;
  const dt = Math.min(0.08, raw);
  acc += dt;
  let n = 0;
  const t0 = performance.now();
  while (acc >= 1 / 60 && n < 4) { simulate(1 / 60); acc -= 1 / 60; n++; }
  if (n >= 4) acc = 0;
  updateCamera(dt);
  hudTick(dt);
  perf.lastSim = performance.now() - t0;
  perf.sim += perf.lastSim;
  const t1 = performance.now();
  renderer.render(scene, camera);
  perf.lastRender = performance.now() - t1;
  perf.render += perf.lastRender;
  perf.frames++;
}
requestAnimationFrame(loop);
addEventListener('resize', () => {
  renderer.setSize(innerWidth, innerHeight);
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
});
document.addEventListener('visibilitychange', () => { if (!document.hidden) lastT = performance.now(); });

buildCreateUI();
updateHUD();
drawMini();
G.mode = 'creation';


/* ============================== 页面自检（?test=1） ============================== */
function post(name, obj) {
  return fetch('http://127.0.0.1:8831/report/' + name, { method: 'POST', body: JSON.stringify(obj) })
    .then(r => r.text()).catch(e => 'postfail:' + e.message);
}
function rect(id) {
  const el = document.getElementById(id);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), vis: r.width > 0 && r.height > 0 && getComputedStyle(el).display !== 'none' };
}
// 暗色像素诊断：找出屏幕上"渲染出来但射线打不到"的黑色区域，并识别它是什么
function darkDiag() {
  const src = renderer.domElement;
  const W = 160, H = Math.round(160 * src.height / src.width);
  const c2 = document.createElement('canvas'); c2.width = W; c2.height = H;
  const ctx = c2.getContext('2d');
  ctx.drawImage(src, 0, 0, W, H);
  const d = ctx.getImageData(0, 0, W, H).data;
  let dark = 0, sx = 0, sy = 0, minX = 1e9, maxX = -1e9, minY = 1e9, maxY = -1e9;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = (y * W + x) * 4;
    if (d[i] + d[i + 1] + d[i + 2] < 34) {
      dark++; sx += x; sy += y;
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
    }
  }
  const total = W * H;
  if (!dark) return { darkPct: 0 };
  const nx = (sx / dark) / W * 2 - 1, ny = -((sy / dark) / H * 2 - 1);
  const T = THREE;
  const saved = [];
  scene.traverse(o => { if (o.isMesh && o.material) { saved.push([o.material, o.material.side]); o.material.side = T.DoubleSide; o.material.needsUpdate = true; } });
  const hit = DG.pick(nx, ny);
  for (const [m, s] of saved) { m.side = s; m.needsUpdate = true; }
  return {
    darkPct: +(dark / total * 100).toFixed(1), ndc: [+nx.toFixed(2), +ny.toFixed(2)],
    bbox: { x: minX / W, y: minY / H, w: (maxX - minX) / W, h: (maxY - minY) / H }, hit,
  };
}

function rasterDark() {
  renderer.render(scene, camera);
  const src = renderer.domElement;
  const W = 120, H = Math.max(1, Math.round(120 * src.height / src.width));
  const c2 = document.createElement('canvas'); c2.width = W; c2.height = H;
  const ctx = c2.getContext('2d');
  ctx.drawImage(src, 0, 0, W, H);
  const d = ctx.getImageData(0, 0, W, H).data;
  let dark = 0;
  for (let i = 0; i < d.length; i += 4) if (d[i] + d[i + 1] + d[i + 2] < 30) dark++;
  return +(dark / (W * H) * 100).toFixed(1);
}

async function blackScan() {
  updateCamera(1.2); updateCamera(1.2);
  const scan = (objs) => {
    const base = rasterDark();
    const rows = [];
    for (let i = 0; i < objs.length; i++) {
      const o = objs[i];
      if (o.isLight || !o.visible) continue;
      o.visible = false;
      const p = rasterDark();
      o.visible = true;
      if (p < base - 1.5) rows.push({ i, type: o.type, kids: o.children.length, pct: p, geo: o.geometry ? o.geometry.type : '', col: (o.material && o.material.color) ? '#' + o.material.color.getHexString() : '', mass: o.material ? o.material.type : '', pos: o.position.toArray().map(v => +v.toFixed(1)) });
    }
    return { base, rows };
  };
  const top = scan(scene.children.slice());
  let deep = null;
  if (top.rows.length) {
    const idx = top.rows[0].i;
    const target = scene.children[idx];
    if (target.children.length) deep = { of: idx, ...scan(target.children.slice()) };
  }
  return { top, deep };
}

async function selfTest() {
  const out = {};
  out.build = BUILD; out.viewport = [innerWidth, innerHeight];
  out.blackScan = await blackScan();
  await post('00_black', out);
  out.canvas = [renderer.domElement.width, renderer.domElement.height];
  // 1) 创建界面布局
  out.creation = { panel: rect('create'), startBtn: rect('btnStart'), controls: rect('controls') };
  updateCamera(1.2); updateCamera(1.2); renderer.render(scene, camera);
  out.creationDark = darkDiag();
  await DG.shot('t_creation');
  await post('01_creation', out);

  // 2) 进游戏
  startGame();
  hero.pos.set(2.4, heightAt(2.4, 30.6) + 0.05, 30.6);
  updateCamera(1.2); updateCamera(1.2); renderer.render(scene, camera);
  out.play = { probe: DG.probe(), hud: rect('quest'), diag: document.getElementById('diag').textContent };
  out.playDark = darkDiag();
  await DG.shot('t_play');
  await post('02_play', out);

  // 3) 打小怪：哥布林
  const gob = G.monsters.find(m => m.kind === 'goblin');
  const g0 = gob.hp;
  hero.pos.set(gob.pos.x, heightAt(gob.pos.x, gob.pos.z + 1.9), gob.pos.z + 1.9);
  hero.stam = 100;
  doAttack(); simulate(1 / 60); simulate(1 / 60); simulate(1 / 60);
  for (let i = 0; i < 40; i++) simulate(1 / 60);
  const g1 = gob.hp;
  // 打死它
  for (let i = 0; i < 8 && !gob.dead; i++) { hero.stam = 100; hero.atk = null; doAttack(); for (let k = 0; k < 40; k++) simulate(1 / 60); }
  out.goblin = { hp0: g0, hp1: +g1.toFixed(1), dmg: +(g0 - g1).toFixed(1), dead: gob.dead, gold: G.gold, xp: G.xp, kills: G.stats.kills, dmgTexts: document.querySelectorAll('.dmg').length };
  for (let i = 0; i < 120; i++) simulate(1 / 60);
  out.goblin.goldAfterOrbs = G.gold;
  await post('03_goblin', out);

  // 4) 进副本打 boss
  enterMap('dungeon', true);
  out.dungeonEnter = { map: activeId, monsters: G.monsters.length, solids: colliders.length, sky: skyMesh ? skyMesh.visible : null, fog: +scene.fog.near.toFixed(0) };
  const boss = G.monsters.find(m => m.kind === 'boss');
  const b0 = boss.hp;
  let swings = 0;
  for (let i = 0; i < 60 && !boss.dead; i++) {
    hero.hp = maxHp(); hero.stam = 100; hero.atk = null; hero.roll = 0;
    hero.pos.set(boss.pos.x, heightAt(boss.pos.x, boss.pos.z + 2.6), boss.pos.z + 2.6);
    hero.yaw = Math.atan2(boss.pos.x - hero.pos.x, boss.pos.z - hero.pos.z);
    doAttack(); swings++;
    for (let k = 0; k < 34; k++) simulate(1 / 60);
  }
  out.boss = { hp0: b0, hp1: +Math.max(0, boss.hp).toFixed(1), swings, dead: boss.dead, bossDead: G.bossDead, axe: !WEAPONS.axe.locked, gold: G.gold, level: G.level, banner: document.getElementById('banner').innerText.replace(/\n/g, ' | ') };
  await post('04_boss', out);

  // 5) 装备面板：换铁甲 + 巨剑
  openPanel('gear');
  out.panel = { mode: G.mode, panel: rect('panel'), body: rect('panelBody') };
  const atkBefore = WEAPONS[G.gear.weapon].dmg * atkPower();
  G.gear.armor = 'iron'; G.gear.weapon = 'greatsword'; rebuildHero(); renderPanel();
  const atkAfter = WEAPONS[G.gear.weapon].dmg * atkPower();
  out.equip = { atkBefore: +atkBefore.toFixed(1), atkAfter: +atkAfter.toFixed(1), def: ARMOR[G.gear.armor].def, heroBox: DG.heroBox(), cards: document.querySelectorAll('#panelBody .card').length };
  updateCamera(1.2); updateCamera(1.2); renderer.render(scene, camera);
  await DG.shot('t_gear');
  await post('05_gear', out);
  closePanel();

  // 6) 死亡 → 复活
  hero.hp = 30;
  hurtHero(999);
  const diedMode = G.mode;
  for (let i = 0; i < 60 * 4; i++) simulate(1 / 60);
  out.death = { diedMode, afterMode: G.mode, hp: +hero.hp.toFixed(0), pos: [+hero.pos.x.toFixed(1), +hero.pos.z.toFixed(1)], respawnAt: [heroStart.x, +heroStart.z.toFixed(1)] };
  await post('06_death', out);

  // 7) 副本内视角
  hero.pos.set(0, heightAt(0, -8), -8);
  G.cam.yaw = Math.PI; G.cam.pitch = 0.30;
  updateCamera(1.2); updateCamera(1.2); renderer.render(scene, camera);
  await DG.shot('t_ruins');
  out.ruins = { probe: DG.probe(), dark: darkDiag() };
  await post('07_ruins', out);
  return 'done';
}

async function mapTest() {
  const out = { viewport: [innerWidth, innerHeight] };
  startGame();
  out.overworld = DG.probe();
  const p1 = MAPS.overworld.portal;
  hero.pos.set(p1.x, heightAt(p1.x, p1.z + 2.5), p1.z + 2.5);
  updatePortalPrompt();
  out.prompt1 = nearPortal ? nearPortal.to : null;
  out.btnUseVisible = !document.getElementById('btnUse').classList.contains('hidden');
  enterMap('dungeon', true);
  await new Promise(r => setTimeout(r, 260));
  out.dungeon = DG.probe();
  out.dungeonQuest = document.getElementById('questName').textContent;
  out.spawnDist = +Math.hypot(hero.pos.x - MAPS.dungeon.spawn.x, hero.pos.z - MAPS.dungeon.spawn.z).toFixed(2);
  out.overworldHidden = !mapGroups.overworld.visible;
  out.bounds = { overworld: MAPS.overworld.bound, dungeon: MAPS.dungeon.bound, active: BOUND };
  out.solids = { overworld: MAPS.overworld.solids.length, dungeon: MAPS.dungeon.solids.length, active: colliders.length };
  hero.pos.set(0, heightAt(0, 6), 6); hero.yaw = Math.PI; G.cam.yaw = Math.PI;
  simulate(1 / 60);
  updateCamera(1.2); updateCamera(1.2); renderer.render(scene, camera);
  await DG.shot('t_dungeon');
  const p2 = MAPS.dungeon.portal;
  hero.pos.set(p2.x, heightAt(p2.x, p2.z - 2), p2.z - 2);
  updatePortalPrompt();
  out.prompt2 = nearPortal ? nearPortal.to : null;
  enterMap('overworld', true);
  await new Promise(r => setTimeout(r, 260));
  out.back = DG.probe();
  out.backPrompt = (() => { updatePortalPrompt(); return nearPortal ? nearPortal.to : null; })();
  enterMap('dungeon', true);
  await new Promise(r => setTimeout(r, 200));
  const boss = ALL_MONSTERS.find(m => m.kind === 'boss');
  let swings = 0;
  for (let i = 0; i < 70 && !boss.dead; i++) {
    hero.hp = maxHp(); hero.stam = 100; hero.atk = null; hero.roll = 0;
    hero.pos.set(boss.pos.x, heightAt(boss.pos.x, boss.pos.z + 2.6), boss.pos.z + 2.6);
    hero.yaw = Math.atan2(boss.pos.x - hero.pos.x, boss.pos.z - hero.pos.z);
    doAttack(); swings++;
    for (let k = 0; k < 34; k++) simulate(1 / 60);
  }
  out.boss = { swings, dead: boss.dead, bossDead: G.bossDead, axe: !WEAPONS.axe.locked, quest: document.getElementById('questName').textContent, banner: document.getElementById('banner').innerText.replace(/\n/g, ' | ') };
  hero.pos.set(0, heightAt(0, -10), -10); hero.yaw = Math.PI; G.cam.yaw = Math.PI;
  simulate(1 / 60);
  updateCamera(1.2); updateCamera(1.2); renderer.render(scene, camera);
  await DG.shot('t_dungeon_boss');
  await post('map', out);
  return out;
}

async function bossTest() {
  const out = { viewport: [innerWidth, innerHeight] };
  startGame();
  const boss = G.monsters.find(m => m.kind === 'boss');
  hero.pos.set(0, heightAt(0, -41), -41);
  hero.yaw = Math.PI;
  G.cam.yaw = Math.PI; G.cam.pitch = 0.26;
  simulate(1 / 60); simulate(1 / 60);
  updateCamera(1.2); updateCamera(1.2); renderer.render(scene, camera);
  await DG.shot('t_boss');
  out.before = { bossHp: boss.hp, bossFlag: !!boss.boss, quest: document.getElementById('questName').textContent, bossBarHidden: document.getElementById('bossBar').classList.contains('hidden') };
  let swings = 0;
  for (let i = 0; i < 70 && !boss.dead; i++) {
    hero.hp = maxHp(); hero.stam = 100; hero.atk = null; hero.roll = 0;
    hero.pos.set(boss.pos.x, heightAt(boss.pos.x, boss.pos.z + 2.6), boss.pos.z + 2.6);
    hero.yaw = Math.atan2(boss.pos.x - hero.pos.x, boss.pos.z - hero.pos.z);
    doAttack(); swings++;
    for (let k = 0; k < 34; k++) simulate(1 / 60);
  }
  out.afterKill = {
    swings, dead: boss.dead, bossDead: G.bossDead, axe: !WEAPONS.axe.locked, gold: G.gold, bossBarHidden: document.getElementById('bossBar').classList.contains('hidden'),
    banner: document.getElementById('banner').innerText.replace(/\n/g, ' | '), quest: document.getElementById('questName').textContent, respawn: boss.respawn,
  };
  for (let i = 0; i < 60; i++) simulate(1 / 60);
  out.questAfter = document.getElementById('questName').textContent;
  hero.pos.set(0, heightAt(0, -40), -40); hero.yaw = Math.PI;
  simulate(1 / 60);
  updateCamera(1.2); updateCamera(1.2); renderer.render(scene, camera);
  await DG.shot('t_boss_dead');
  await post('boss', out);
  return out;
}
window.__selfTest = selfTest;
window.__bossTest = bossTest;
if (location.search.indexOf('test=map') >= 0) {
  setTimeout(() => { mapTest().catch(e => post('99_error', { err: e.message, stack: (e.stack || '').slice(0, 300) })); }, 500);
} else if (location.search.indexOf('test=boss') >= 0) {
  setTimeout(() => { bossTest().catch(e => post('99_error', { err: e.message, stack: (e.stack || '').slice(0, 300) })); }, 500);
} else if (location.search.indexOf('test=black') >= 0) {
  setTimeout(() => { blackScan().then(r => post('00_black', { viewport: [innerWidth, innerHeight], ...r })).catch(e => post('99_error', { err: e.message, stack: (e.stack || '').slice(0, 300) })); }, 400);
} else if (location.search.indexOf('test=1') >= 0) {
  setTimeout(() => { selfTest().catch(e => post('99_error', { err: e.message, stack: (e.stack || '').slice(0, 400) })); }, 500);
}

/* ============================== 调试探针 ============================== */
window.DG = {
  G, THREE, scene, camera, hero, WEAPONS, ARMOR, heightAt, renderer,
  get heroModel() { return heroModel; },
  pick(nx, ny) {
    const rc = new THREE.Raycaster();
    rc.setFromCamera(new THREE.Vector2(nx, ny), camera);
    const hits = rc.intersectObjects(scene.children, true).filter(h => h.object.visible);
    if (!hits.length) return null;
    const o = hits[0].object;
    return { dist: +hits[0].distance.toFixed(2), type: o.geometry ? o.geometry.type : '?', col: o.material && o.material.color ? '#' + o.material.color.getHexString() : '?', pos: o.getWorldPosition(new THREE.Vector3()).toArray().map(v => +v.toFixed(2)) };
  },
  heroBox() { const b = new THREE.Box3().setFromObject(heroModel.group); return { min: b.min.toArray().map(v => +v.toFixed(2)), max: b.max.toArray().map(v => +v.toFixed(2)), vis: heroModel.group.visible, pos: heroModel.group.position.toArray().map(v => +v.toFixed(2)), kids: heroModel.group.children.length }; },
  renderNow(dt = 1 / 60) { updateCamera(dt); hudTick(dt); renderer.render(scene, camera); return this.probe(); },
  frames() { return perf.frames; },
  snap() { updateCamera(1.2); updateCamera(1.2); hudTick(1 / 60); renderer.render(scene, camera); return this.probe(); },
  shot(name = 'dg_shot') {
    updateCamera(1.2); updateCamera(1.2); hudTick(1 / 60);
    renderer.render(scene, camera);
    const url = renderer.domElement.toDataURL('image/jpeg', 0.82);
    return fetch('http://127.0.0.1:8831/' + name, { method: 'POST', body: url })
      .then(r => r.text()).then(t => 'shot ' + t).catch(e => 'shotfail ' + e.message);
  },
  poseCam(px, py, pz, tx, ty, tz) {
    camPos.set(px, py, pz); camLook.set(tx, ty, tz);
    camera.position.set(px, py, pz); camera.lookAt(tx, ty, tz);
    renderer.render(scene, camera); return this.probe();
  },
  probe() {
    const boss = ALL_MONSTERS.find(m => m.kind === 'boss');
    return {
      build: BUILD, mode: G.mode, t: +G.t.toFixed(2),
      hp: +hero.hp.toFixed(1), maxHp: maxHp(), stam: +hero.stam.toFixed(1),
      level: G.level, xp: G.xp, gold: G.gold, kills: G.stats.kills,
      alive: G.monsters.filter(m => !m.dead).length, total: G.monsters.length,
      bossHp: boss ? +boss.hp.toFixed(1) : -1, bossDead: G.bossDead,
      pos: [+hero.pos.x.toFixed(2), +hero.pos.y.toFixed(2), +hero.pos.z.toFixed(2)],
      nearest: +(G.monsters.filter(m => !m.dead).reduce((a, m) => Math.min(a, Math.hypot(m.pos.x - hero.pos.x, m.pos.z - hero.pos.z)), 999)).toFixed(2),
      camera: [+camera.position.x.toFixed(1), +camera.position.y.toFixed(1), +camera.position.z.toFixed(1)],
      meshes: (() => { let c = 0; scene.traverse(o => { if (o.isMesh) c++; }); return c; })(),
      atk: !!hero.atk, roll: +hero.roll.toFixed(2),
      map: activeId, solids: colliders.length, sky: skyMesh ? skyMesh.visible : null,
      fogNear: +scene.fog.near.toFixed(0), sunInt: +sun.intensity.toFixed(2),
      nearPortal: nearPortal ? nearPortal.to : null,
      perf: { frames: perf.frames, sim: +(perf.sim / Math.max(1, perf.frames)).toFixed(2), render: +(perf.render / Math.max(1, perf.frames)).toFixed(2), lastSim: +perf.lastSim.toFixed(2), lastRender: +perf.lastRender.toFixed(2) },
    };
  },
  tp(x, z) { hero.pos.set(x, heightAt(x, z), z); heroModel.group.position.copy(hero.pos); },
  face(y) { hero.yaw = y; },
  attack() { doAttack(); },
  roll() { doRoll(); },
  advance(sec) {
    const n = Math.min(1200, Math.round(sec * 60));
    for (let i = 0; i < n; i++) simulate(1 / 60);
    return this.probe();
  },
  hurt(n) { hurtHero(n); return this.probe(); },
  heal() { hero.hp = maxHp(); hero.stam = 100; return this.probe(); },
  killAll() { for (const m of [...G.monsters]) if (!m.dead) hurtMonster(m, 99999, 0, hero.pos, false); return this.probe(); },
  killNearest() {
    let best = null, bd = 999;
    for (const m of G.monsters) { if (m.dead) continue; const d = Math.hypot(m.pos.x - hero.pos.x, m.pos.z - hero.pos.z); if (d < bd) { bd = d; best = m; } }
    if (best) hurtMonster(best, 99999, 0, hero.pos, false);
    return this.probe();
  },
  giveGold(n) { G.gold += n; return G.gold; },
  unlockAxe() { G.axeUnlocked = true; WEAPONS.axe.locked = false; },
  start() { startGame(); return this.probe(); },
  openGear() { openPanel('gear'); },
  closePanel,
  setCam(yaw, pitch, dist) { if (yaw != null) G.cam.yaw = yaw; if (pitch != null) G.cam.pitch = pitch; if (dist != null) G.cam.dist = dist; },
  setMode(m) { G.mode = m; },
};
