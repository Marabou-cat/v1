// models.js — 全部程序化 3D 模型（不依赖任何外部贴图/模型文件）
import * as THREE from 'three';

const matCache = new Map();
export function mat(color, o = {}) {
  const key = [color, o.roughness ?? 0.86, o.metalness ?? 0, o.emissive ?? '', o.emissiveIntensity ?? 1,
    o.opacity ?? 1, o.flat ? 1 : 0, o.side ?? 0].join('|');
  if (matCache.has(key)) return matCache.get(key);
  const m = new THREE.MeshStandardMaterial({
    color, roughness: o.roughness ?? 0.86, metalness: o.metalness ?? 0, flatShading: !!o.flat,
    transparent: (o.opacity ?? 1) < 1, opacity: o.opacity ?? 1,
  });
  if (o.emissive) { m.emissive = new THREE.Color(o.emissive); m.emissiveIntensity = o.emissiveIntensity ?? 1; }
  if (o.side) m.side = o.side;
  matCache.set(key, m);
  return m;
}
const geoBox = (w, h, d) => new THREE.BoxGeometry(w, h, d);
const geoCyl = (rt, rb, h, s = 10) => new THREE.CylinderGeometry(rt, rb, h, s);
const geoSph = (r, s = 12) => new THREE.SphereGeometry(r, s, Math.max(6, s - 2));
const geoCone = (r, h, s = 10) => new THREE.ConeGeometry(r, h, s);

function mk(geo, material, x = 0, y = 0, z = 0) {
  const m = new THREE.Mesh(geo, material);
  m.position.set(x, y, z);
  m.castShadow = true;
  m.receiveShadow = true;
  return m;
}

export function disposeGroup(g) {
  if (!g) return;
  g.traverse(o => {
    if (o.isMesh && o.geometry) o.geometry.dispose();
  });
}

/* ---------------- weapons ---------------- */
// 握把在原点，刃朝 +Y
export function buildWeapon(id) {
  const g = new THREE.Group();
  const steel = mat('#cfd8e3', { metalness: 0.85, roughness: 0.3 });
  const dark = mat('#7f8b99', { metalness: 0.8, roughness: 0.42 });
  const leather = mat('#4a3324', { roughness: 0.95 });
  const gold = mat('#d9b168', { metalness: 0.9, roughness: 0.32, emissive: '#3a2a10', emissiveIntensity: 0.5 });

  if (id === 'greatsword') {
    g.add(mk(geoCyl(0.032, 0.032, 0.30), leather, 0, 0.03, 0));
    g.add(mk(geoSph(0.038, 8), gold, 0, -0.13, 0));
    g.add(mk(geoBox(0.34, 0.05, 0.07), dark, 0, 0.19, 0));
    g.add(mk(geoBox(0.15, 0.92, 0.035), steel, 0, 0.66, 0));
    g.add(mk(geoBox(0.035, 0.86, 0.045), mat('#eaf3ff', { emissive: '#8fb6d8', emissiveIntensity: 0.35, metalness: 0.9, roughness: 0.18 }), 0, 0.66, 0));
    const tip = mk(geoCone(0.106, 0.24, 4), steel, 0, 1.235, 0);
    tip.rotation.y = Math.PI / 4; tip.scale.z = 0.36;
    g.add(tip);
  } else if (id === 'spear') {
    g.add(mk(geoCyl(0.028, 0.028, 1.72, 8), mat('#5c4326', { roughness: 0.92 }), 0, 0.42, 0));
    g.add(mk(geoCyl(0.036, 0.036, 0.16, 8), gold, 0, 1.30, 0));
    g.add(mk(geoCone(0.075, 0.30, 6), steel, 0, 1.52, 0));
    g.add(mk(geoBox(0.012, 0.22, 0.075), dark, 0, 1.36, 0));
    g.add(mk(geoCyl(0.031, 0.031, 0.20, 8), leather, 0, 0.60, 0));
  } else if (id === 'axe') {
    g.add(mk(geoCyl(0.034, 0.034, 0.92, 8), mat('#5c4326', { roughness: 0.92 }), 0, 0.26, 0));
    g.add(mk(geoBox(0.075, 0.075, 0.075), gold, 0, 0.70, 0));
    const blade = mk(geoCone(0.30, 0.42, 4), steel, 0, 0.72, 0.09);
    blade.rotation.z = Math.PI / 2; blade.rotation.y = Math.PI / 4; blade.scale.z = 0.22;
    g.add(blade);
    g.add(mk(geoCyl(0.033, 0.033, 0.16, 8), leather, 0, 0.06, 0));
  } else {
    g.add(mk(geoCyl(0.026, 0.026, 0.22, 8), leather, 0, 0.02, 0));
    g.add(mk(geoSph(0.032, 8), gold, 0, -0.11, 0));
    g.add(mk(geoBox(0.22, 0.038, 0.055), dark, 0, 0.15, 0));
    g.add(mk(geoBox(0.075, 0.60, 0.028), steel, 0, 0.47, 0));
    g.add(mk(geoBox(0.022, 0.56, 0.035), mat('#eaf3ff', { emissive: '#9cc4e6', emissiveIntensity: 0.3, metalness: 0.9, roughness: 0.2 }), 0, 0.47, 0));
    const tip = mk(geoCone(0.054, 0.16, 4), steel, 0, 0.85, 0);
    tip.rotation.y = Math.PI / 4; tip.scale.z = 0.38;
    g.add(tip);
  }
  return g;
}

/* ---------------- humanoid ---------------- */
// cfg: {height, skin, shirt, pants, hairStyle, hairColor, bulk, armor, weapon,
//       eyes, ears, bones, headScale, helmet, cape, bootColor}
export function buildHumanoid(cfg) {
  const C = Object.assign({
    height: 1.78, skin: '#e3b391', shirt: '#3d5a86', pants: '#2b3543', hairStyle: 1,
    hairColor: '#2b1d15', bulk: 1, armor: 'cloth', weapon: 'sword', eyes: '#20242c',
    ears: false, bones: false, headScale: 1, helmet: false, cape: false,
    bootColor: '#3a2e22',
  }, cfg);

  const root = new THREE.Group();
  const body = new THREE.Group();
  root.add(body);
  const rig = {};
  rig.body = body;

  const skinM = mat(C.skin, { roughness: 0.82 });
  const pantsM = mat(C.pants, { roughness: 0.94 });
  const bootM = mat(C.bootColor, { roughness: 0.95 });
  const thin = C.bones ? 0.55 : 1;

  // --- 腿 ---
  for (const side of [-1, 1]) {
    const key = side < 0 ? 'L' : 'R';
    const hip = new THREE.Group();
    hip.position.set(0.105 * side, 0.90, 0);
    body.add(hip);
    hip.add(mk(geoCyl(0.078 * thin, 0.066 * thin, 0.44), pantsM, 0, -0.22, 0));
    const knee = new THREE.Group();
    knee.position.y = -0.44;
    hip.add(knee);
    knee.add(mk(geoCyl(0.064 * thin, 0.076 * thin, 0.06), C.bones ? skinM : pantsM, 0, 0, 0));
    knee.add(mk(geoCyl(0.060 * thin, 0.050 * thin, 0.42), pantsM, 0, -0.22, 0));
    knee.add(mk(geoBox(0.125, 0.075, 0.225), bootM, 0, -0.455, 0.045));
    if (C.armor === 'iron' || C.armor === 'knight') {
      knee.add(mk(geoCyl(0.070, 0.062, 0.20, 8), mat('#98a4b3', { metalness: 0.8, roughness: 0.36 }), 0, -0.20, 0));
    }
    rig['leg' + key] = hip;
    rig['knee' + key] = knee;
  }

  // --- 躯干 ---
  const torsoW = (0.300 + (C.bulk - 1) * 0.30) * (C.bones ? 0.8 : 1);
  const torso = mk(geoBox(torsoW, 0.52, 0.215), mat(C.shirt, { roughness: 0.9 }), 0, 1.19, 0);
  body.add(torso);
  rig.torso = torso;
  body.add(mk(geoBox(torsoW * 0.92, 0.16, 0.20), pantsM, 0, 0.94, 0));
  body.add(mk(geoCyl(0.048, 0.054, 0.09, 8), skinM, 0, 1.455, 0));

  // 护甲外观
  if (C.armor === 'cloth') {
    body.add(mk(geoBox(torsoW + 0.012, 0.075, 0.225), mat('#6b4a2c', { roughness: 0.9 }), 0, 0.99, 0));
    body.add(mk(geoSph(0.032, 8), mat('#d9b168', { metalness: 0.8, roughness: 0.35 }), 0, 0.99, 0.115));
    body.add(mk(geoBox(torsoW * 0.62, 0.16, 0.03), mat('#2c4468'), 0, 1.30, 0.112));
  } else if (C.armor === 'leather') {
    const lth = mat('#6d4b2f', { roughness: 0.9 });
    body.add(mk(geoBox(torsoW + 0.035, 0.40, 0.245), lth, 0, 1.21, 0));
    body.add(mk(geoBox(torsoW + 0.02, 0.06, 0.245), mat('#493021'), 0, 1.00, 0));
    body.add(mk(geoBox(0.055, 0.36, 0.06), mat('#8a6338'), 0, 1.21, 0.125));
    for (const s of [-1, 1]) {
      body.add(mk(geoSph(0.098, 10), lth, 0.258 * s * (torsoW / 0.300), 1.39, 0));
    }
  } else if (C.armor === 'iron' || C.armor === 'knight') {
    const plate = mat('#a9b5c4', { metalness: 0.82, roughness: 0.34 });
    const plate2 = mat('#8d99a8', { metalness: 0.8, roughness: 0.4 });
    body.add(mk(geoBox(torsoW + 0.05, 0.44, 0.26), plate, 0, 1.22, 0));
    body.add(mk(geoBox(torsoW + 0.03, 0.08, 0.265), plate2, 0, 1.01, 0));
    body.add(mk(geoSph(0.05, 8), mat('#d9b168', { metalness: 0.9, roughness: 0.3, emissive: '#3b2a0d', emissiveIntensity: 0.6 }), 0, 1.30, 0.135));
    for (const s of [-1, 1]) {
      const pd = mk(geoSph(0.125, 12), plate, 0.262 * s * (torsoW / 0.300), 1.40, 0);
      pd.scale.set(1.15, 0.72, 1.05);
      body.add(pd);
      body.add(mk(geoBox(0.12, 0.05, 0.20), plate2, 0.262 * s * (torsoW / 0.300), 1.34, 0));
    }
    if (C.cape) {
      const cape = mk(geoBox(torsoW * 1.18, 0.86, 0.03), mat('#7a2626', { roughness: 0.92 }), 0, 1.02, -0.16);
      cape.rotation.x = -0.09;
      body.add(cape);
      rig.cape = cape;
    }
  }

  // --- 手臂 ---
  for (const side of [-1, 1]) {
    const key = side < 0 ? 'L' : 'R';
    const sh = new THREE.Group();
    sh.position.set(0.252 * side * (torsoW / 0.300), 1.372, 0);
    body.add(sh);
    sh.add(mk(geoCyl(0.066 * thin, 0.056 * thin, 0.32), C.bones ? skinM : (C.armor === 'iron' || C.armor === 'knight' ? mat('#a9b5c4', { metalness: 0.82, roughness: 0.34 }) : skinM), 0, -0.16, 0));
    const el = new THREE.Group();
    el.position.y = -0.32;
    sh.add(el);
    el.add(mk(geoCyl(0.055 * thin, 0.046 * thin, 0.30), skinM, 0, -0.15, 0));
    if (C.armor === 'leather') el.add(mk(geoCyl(0.062, 0.058, 0.13, 8), mat('#6d4b2f'), 0, -0.13, 0));
    if (C.armor === 'iron' || C.armor === 'knight') el.add(mk(geoCyl(0.062, 0.055, 0.15, 8), mat('#8d99a8', { metalness: 0.8, roughness: 0.4 }), 0, -0.14, 0));
    const hand = new THREE.Group();
    hand.position.y = -0.30;
    el.add(hand);
    hand.add(mk(geoSph(0.056 * (C.bones ? 0.9 : 1), 8), skinM, 0, 0, 0));
    rig['arm' + key] = sh;
    rig['elbow' + key] = el;
    rig['hand' + key] = hand;
    if (key === 'R') rig.mount = hand;
  }

  // --- 头 ---
  const head = new THREE.Group();
  head.position.set(0, 1.575, 0);
  body.add(head);
  rig.head = head;
  const hs = C.headScale;
  head.add(mk(geoSph(0.124 * hs, 16), skinM, 0, 0, 0));
  if (C.headStyle === 'skull' || C.bones) {
    head.add(mk(geoSph(0.085 * hs, 10), mat('#20232a'), 0, 0.035, 0.06));
    for (const s of [-1, 1]) head.add(mk(geoSph(0.03, 8), mat('#101318'), 0.044 * s, 0.012, 0.108));
    head.add(mk(geoBox(0.08, 0.028, 0.03), mat('#e6e2d4'), 0, -0.07, 0.102));
  } else {
    for (const s of [-1, 1]) {
      head.add(mk(geoSph(0.023, 8), mat('#f7f4ee'), 0.045 * s * hs, 0.012, 0.108 * hs));
      head.add(mk(geoSph(0.012, 6), mat(C.eyes), 0.047 * s * hs, 0.012, 0.122 * hs));
    }
    head.add(mk(geoBox(0.05, 0.009, 0.012), mat('#8c6a52'), 0, -0.055, 0.117));
  }
  if (C.ears) {
    for (const s of [-1, 1]) {
      const ear = mk(geoCone(0.035, 0.14, 5), skinM, 0.126 * s * hs, 0.03, -0.01);
      ear.rotation.z = -1.25 * s;
      ear.rotation.x = -0.25;
      head.add(ear);
    }
  }

  // 头发
  if (!C.bones && C.hairStyle >= 0) {
    const hm = mat(C.hairColor, { roughness: 0.72 });
    const cap = new THREE.Mesh(new THREE.SphereGeometry(0.132 * hs, 16, 10, 0, Math.PI * 2, 0, Math.PI * 0.56), hm);
    cap.castShadow = true; cap.position.y = 0.008; cap.scale.set(1, 1.02, 1.04);
    head.add(cap);
    if (C.hairStyle === 1) {
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * Math.PI * 2;
        const sp = mk(geoCone(0.038, 0.14, 5), hm, Math.cos(a) * 0.058 * hs, 0.105, Math.sin(a) * 0.058 * hs - 0.012);
        sp.rotation.set(Math.sin(a) * 0.55, 0, -Math.cos(a) * 0.55);
        head.add(sp);
      }
    } else if (C.hairStyle === 2) {
      head.add(mk(geoBox(0.20 * hs, 0.30, 0.105), hm, 0, -0.125, -0.082));
      head.add(mk(geoBox(0.185 * hs, 0.075, 0.115), hm, 0, 0.055, -0.075));
    } else if (C.hairStyle === 3) {
      head.add(mk(geoSph(0.068, 10), hm, 0, 0.115, -0.062));
      for (const s of [-1, 1]) head.add(mk(geoBox(0.028, 0.16, 0.05), hm, 0.085 * s, -0.045, -0.055));
    }
  }

  // 头盔（骑士）
  if (C.helmet) {
    const steel = mat('#b7c2d0', { metalness: 0.86, roughness: 0.28 });
    const dome = new THREE.Mesh(new THREE.SphereGeometry(0.132 * hs, 16, 10, 0, Math.PI * 2, 0, Math.PI * 0.62), steel);
    dome.castShadow = true; dome.position.y = 0.012;
    head.add(dome);
    head.add(mk(geoBox(0.235 * hs, 0.055, 0.235 * hs), steel, 0, 0.008, 0));
    head.add(mk(geoBox(0.20 * hs, 0.075, 0.02), mat('#2a3038'), 0, -0.048, 0.113 * hs));
    head.add(mk(geoBox(0.03, 0.075, 0.10), mat('#d9b168', { metalness: 0.9, roughness: 0.3 }), 0, 0.075, 0.09));
  }

  // 武器挂到右手
  if (C.weapon) {
    const w = buildWeapon(C.weapon);
    w.position.set(0, -0.03, 0.015);
    w.rotation.set(0.72, 0.10, -0.18);
    rig.mount.add(w);
    rig.weaponModel = w;
  }

  const s = C.height / 1.78;
  body.scale.set(s * C.bulk, s, s * C.bulk);

  root.traverse(o => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  return { group: root, body, rig, cfg: C, dispose: () => disposeGroup(root) };
}

/* ---------------- slime ---------------- */
export function buildSlime(tint = '#5fbf6a') {
  const root = new THREE.Group();
  const body = new THREE.Group();
  root.add(body);
  const jelly = mat(tint, { roughness: 0.35, metalness: 0.1, opacity: 0.86, emissive: tint, emissiveIntensity: 0.22 });
  const core = mat(tint, { roughness: 0.3, emissive: tint, emissiveIntensity: 0.55 });
  const b = mk(geoSph(0.44, 16), jelly, 0, 0.36, 0);
  b.scale.set(1, 0.84, 1);
  body.add(b);
  body.add(mk(geoSph(0.20, 10), core, 0, 0.30, 0));
  for (const s of [-1, 1]) {
    body.add(mk(geoSph(0.085, 10), mat('#f6fbf4'), 0.135 * s, 0.44, 0.345));
    body.add(mk(geoSph(0.042, 8), mat('#141a20'), 0.145 * s, 0.445, 0.40));
  }
  const mouth = mk(geoBox(0.14, 0.026, 0.02), mat('#243026'), 0, 0.245, 0.395);
  body.add(mouth);
  root.traverse(o => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  return { group: root, body, rig: { body, head: body, mouth }, dispose: () => disposeGroup(root) };
}

/* ---------------- golem boss ---------------- */
export function buildGolem() {
  const root = new THREE.Group();
  const body = new THREE.Group();
  root.add(body);
  const stone = mat('#8d897d', { roughness: 0.96 });
  const stone2 = mat('#6e6a60', { roughness: 0.98 });
  const moss = mat('#4f7040', { roughness: 1 });
  const rune = mat('#a8e6ff', { emissive: '#54c8ff', emissiveIntensity: 2.1, roughness: 0.4 });

  for (const s of [-1, 1]) {
    const hip = new THREE.Group();
    hip.position.set(0.42 * s, 1.30, 0);
    body.add(hip);
    hip.add(mk(geoBox(0.40, 0.86, 0.44), stone2, 0, -0.43, 0));
    hip.add(mk(geoBox(0.46, 0.26, 0.52), stone, 0, -0.92, 0.03));
    if (s < 0) { root.userData.legL = hip; } else { root.userData.legR = hip; }
  }
  body.add(mk(geoBox(1.16, 1.16, 0.78), stone, 0, 1.78, 0));
  body.add(mk(geoBox(0.86, 0.30, 0.82), stone2, 0, 1.30, 0));
  body.add(mk(geoBox(0.52, 0.16, 0.06), moss, 0, 2.20, 0.40));
  const runeRing = mk(new THREE.TorusGeometry(0.24, 0.035, 8, 22), rune, 0, 1.90, 0.405);
  body.add(runeRing);
  body.add(mk(geoBox(0.055, 0.30, 0.03), rune, 0, 1.90, 0.408));

  const head = new THREE.Group();
  head.position.set(0, 2.50, 0.02);
  body.add(head);
  head.add(mk(geoBox(0.54, 0.46, 0.50), stone2, 0, 0, 0));
  head.add(mk(geoBox(0.60, 0.12, 0.14), stone, 0, 0.16, 0.24));
  for (const s of [-1, 1]) head.add(mk(geoBox(0.11, 0.055, 0.03), rune, 0.13 * s, 0.02, 0.255));

  const arms = {};
  for (const s of [-1, 1]) {
    const sh = new THREE.Group();
    sh.position.set(0.74 * s, 2.14, 0);
    body.add(sh);
    sh.add(mk(geoBox(0.40, 0.66, 0.44), stone, 0.02 * s, -0.34, 0));
    const el = new THREE.Group();
    el.position.y = -0.64;
    sh.add(el);
    el.add(mk(geoBox(0.38, 0.62, 0.42), stone2, 0, -0.30, 0));
    el.add(mk(geoBox(0.52, 0.46, 0.52), stone, 0, -0.72, 0.02));
    for (let i = 0; i < 3; i++) el.add(mk(geoBox(0.10, 0.16, 0.10), rune, (-0.16 + i * 0.16), -0.52, 0.22));
    arms[s < 0 ? 'L' : 'R'] = { sh, el };
  }
  root.traverse(o => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  return {
    group: root, body, rig: { body, head, ...arms }, dispose: () => disposeGroup(root),
  };
}

/* ---------------- archer skeleton extras ---------------- */
export function buildBow() {
  const g = new THREE.Group();
  const wood = mat('#4a3623', { roughness: 0.9 });
  const arc = mk(new THREE.TorusGeometry(0.42, 0.028, 6, 14, Math.PI * 1.1), wood, 0, 0, 0);
  arc.rotation.z = -Math.PI * 0.55;
  g.add(arc);
  g.add(mk(geoBox(0.012, 0.82, 0.012), mat('#d8d2bf'), 0, 0, 0));
  return g;
}
