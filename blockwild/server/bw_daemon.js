/* BLOCKWILD 联机守护进程（P0 spike）
 * 零依赖：手写 RFC6455 WebSocket + 一个 JSON HTTP 接口（用来 join / 测 RTT / 看统计）。
 * 设计要点（为什么这么写，别顺手改掉）：
 *  - 地形是「种子 + 纯函数」，所以服务端只存 **seed + 方块改动**，不存区块、不发区块。
 *  - 位置是客户端权威（每 10Hz 广播），方块编辑是服务端权威（校验距离/速率/不可破坏方块）。
 *  - 世界状态全在内存里；每 5 秒或断开时落盘成 JSON。**热路径绝不写库**（NAS 上一次写 ~270ms）。
 *  - 液体/怪物模拟不在服务端，交给「主机客户端」(isHost) 跑，它的 setBlock 一样走编辑通道。
 *
 * 启动：BW_PORT=9103 BW_DATA=/tmp/bwdata node bw_daemon.js
 * 接口：POST /api  {a:'join', code, pid, name} / {a:'state', code} / {a:'ping'} / {a:'stats'}
 */
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.BW_PORT || 9103);
const DATA = process.env.BW_DATA || path.join(__dirname, 'data');
const GEN_VER = Number(process.env.BW_GEN || 3);
const SNAP_HZ = 12;                 // 位置广播频率（10→12：局域网 WS 更跟手）
const MAX_PLAYERS = 8;
const EDIT_PER_SEC = 25;            // 单玩家编辑速率上限（挖矿正常 5~8 次/秒）
const UNBREAKABLE = new Set([51, 41, 42, 45]);   // 基岩 / 传送门框 / 传送门 / 核心

fs.mkdirSync(DATA, { recursive: true });
const worlds = new Map();           // code -> world
const stats = { inBytes: 0, outBytes: 0, msgsIn: 0, msgsOut: 0, edits: 0, rejects: 0, started: Date.now() };

function newWorld(code) {
  const w = {
    code,
    seed: (Math.random() * 2147483647) | 0,
    genVer: GEN_VER,
    time: 300 * 0.03,
    edits: new Map(),             // "x,y,z" -> block id
    chests: new Map(),            // "x,y,z" -> 27 格箱子内容（两人共用）
    inv: {},                      // pid -> {inv, armor, hp, hunger}（客人的东西存服务端）
    pos: {},                      // pid -> {x,y,z,w,q} 每个人上次在房间里的位置（进来接着站这儿）
    seq: 0,                       // 单调递增的编辑序号（断线重连靠它补发）
    log: [],                      // 最近 2000 条编辑，用于 since 补发
    players: new Map(),           // id -> {id, name, x, y, z, yaw, pitch, at, ws, editT, editN}
    dirty: false,
    wasDirtyAt: 0,
  };
  worlds.set(code, w);
  saveWorld(w);
  return w;
}
function worldPath(code) { return path.join(DATA, code.replace(/[^\w-]/g, '_') + '.json'); }
function saveWorld(w) {
  try {
    // ★ 落盘前把「当前坐在房间里的人」的坐标收进 pos：这样重启/重进之后每个人都还在原地
    for (const p of w.players.values()) {
      w.pos[p.id] = { x: +(+p.x).toFixed(2), y: +(+p.y).toFixed(2), z: +(+p.z).toFixed(2),
                      w: +(+p.yaw).toFixed(3), q: +(+p.pitch).toFixed(3) };
    }
    const d = {
      seed: w.seed, genVer: w.genVer, time: w.time,
      edits: Array.from(w.edits.entries()),
      chests: Array.from((w.chests || new Map()).entries()),     // 箱子内容：两人共用一张表
      inv: w.inv || {},                                          // 客人背包（房主背包在他自己本地存档里）
      pos: w.pos || {},                                          // 每个人的位置
      owner: w.owner || null,                                    // 房主 pid（守护进程重启后不能把房主身份弄丢）
    };
    fs.writeFileSync(worldPath(w.code), JSON.stringify(d));
    w.dirty = false;
    w.wasDirtyAt = Date.now();
  } catch (e) { console.error('[bw] 存盘失败', w.code, e.message); }
}
function loadWorld(code) {
  if (worlds.has(code)) return worlds.get(code);
  const p = worldPath(code);
  if (!fs.existsSync(p)) return newWorld(code);
  try {
    const d = JSON.parse(fs.readFileSync(p, 'utf8'));
    const w = newWorld(code);
    w.seed = d.seed | 0;
    w.genVer = d.genVer || GEN_VER;
    w.time = d.time || 0;
    w.edits = new Map((d.edits || []).map(e => [e[0], e[1]]));
    w.chests = new Map(d.chests || []);
    w.inv = d.inv || {};
    w.pos = d.pos || {};
    w.owner = d.owner || null;
    w.dirty = false;
    // ★ 必须放回缓存表：以前这里 return 一个「游离」的世界对象 —— 它不在 worlds 里，
    //   于是 10Hz 位置广播循环和 5s 落盘循环**都看不到这个房间**，玩家之间永远收不到
    //   {t:'p'} 快照（表现就是「联机里看不到其他玩家」，而新建的世界却正常）。
    worlds.set(code, w);
    return w;
  } catch (e) { console.error('[bw] 读盘失败', code, e.message); return newWorld(code); }
}

/* ---------------- 账号 / 好友 / 在线状态 ----------------
 * 只做「这台机器上的局域网熟人社交」：昵称即身份，没有密码（同学之间够用，别当公网账号系统）。
 * 数据落 BW_DATA/accounts.json —— 必须在 docroot 之外，否则等于公开可下载。 */
const ACC_PATH = path.join(DATA, 'accounts.json');
let ACCOUNTS = {};
try { ACCOUNTS = JSON.parse(fs.readFileSync(ACC_PATH, 'utf8')) || {}; } catch (e) { ACCOUNTS = {}; }
function saveAccounts() { try { fs.writeFileSync(ACC_PATH, JSON.stringify(ACCOUNTS)); } catch (e) { console.error('[bw] 账号存盘失败', e.message); } }
function accOf(pid, nick, world) {
  const id = String(pid || '').slice(0, 24);
  if (!id) return null;
  let a = ACCOUNTS[id];
  if (!a) a = ACCOUNTS[id] = { pid: id, nick: String(nick || id).slice(0, 14), friends: [], req: [], inv: [], at: 0, world: null };
  if (nick) a.nick = String(nick).slice(0, 14);
  a.at = Date.now();
  if (world !== undefined) a.world = String(world || '').slice(0, 12);
  return a;
}
const accOnline = a => !!a && Date.now() - (a.at || 0) < 45000;
function accByNick(nick) {
  const n = String(nick || '').trim().toLowerCase();
  if (!n) return null;
  return Object.values(ACCOUNTS).find(a => (a.nick || '').toLowerCase() === n) || null;
}
const accPublic = a => ({ pid: a.pid, nick: a.nick, online: accOnline(a), world: accOnline(a) ? a.world : null });
function pushTo(pid, msg) {                       // 定向推送（只对当前绑定了 socket 的账号）
  for (const w of worlds.values()) {
    const p = w.players.get(pid);
    if (p && p.ws) { try { p.ws.write(frame(JSON.stringify(msg))); return true; } catch (e) {} }
  }
  return false;
}

/* ---------------- 极简 RFC6455 ---------------- */
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
function acceptKey(k) { return crypto.createHash('sha1').update(k + GUID).digest('base64'); }
function frame(str) {
  const p = Buffer.from(str, 'utf8');
  const n = p.length;
  let h;
  if (n < 126) { h = Buffer.from([0x81, n]); }
  else if (n < 65536) { h = Buffer.alloc(4); h[0] = 0x81; h[1] = 126; h.writeUInt16BE(n, 2); }
  else { h = Buffer.alloc(10); h[0] = 0x81; h[1] = 127; h.writeBigUInt64BE(BigInt(n), 2); }
  return Buffer.concat([h, p]);
}
// 从累积缓冲区里解出尽可能多的完整帧（客户端帧一定带 mask）
function parse(buf) {
  const out = [];
  let off = 0;
  while (off + 2 <= buf.length) {
    const b0 = buf[off], b1 = buf[off + 1];
    const op = b0 & 0x0f, masked = (b1 & 0x80) !== 0;
    let len = b1 & 0x7f, p = off + 2;
    if (len === 126) { if (p + 2 > buf.length) break; len = buf.readUInt16BE(p); p += 2; }
    else if (len === 127) { if (p + 8 > buf.length) break; len = Number(buf.readBigUInt64BE(p)); p += 8; }
    const maskLen = masked ? 4 : 0;
    if (p + maskLen + len > buf.length) break;
    let payload;
    if (masked) {
      const mask = buf.slice(p, p + 4);
      payload = Buffer.alloc(len);
      for (let i = 0; i < len; i++) payload[i] = buf[p + 4 + i] ^ mask[i & 3];
      p += 4;
    } else {
      payload = buf.slice(p, p + len);
    }
    out.push({ op, payload });
    off = p + len;
  }
  return { frames: out, rest: buf.slice(off) };
}

/* ---------------- 世界逻辑 ---------------- */
function broadcast(w, msg, exceptId) {
  const f = frame(JSON.stringify(msg));
  for (const p of w.players.values()) {
    if (p.id === exceptId) continue;
    if (p.ws) {
      try { p.ws.write(f); stats.outBytes += f.length; stats.msgsOut++; } catch (e) { /* 掉线等 close 处理 */ }
    } else {
      // 轮询模式的玩家（公网 PHP 桥）：先排队，等它下次 sync 时一起取走
      p.out = p.out || [];
      if (msg.t === 'p') {
        // ★ 位置快照只留「上一条 + 最新一条」：轮询客户端下一次 sync 拿到的就是当前位置，
        //   而不是排队等着播的 100ms 前的历史帧 —— 这一条能直接砍掉一截延迟。
        let lastIdx = -1, prevIdx = -1;
        for (let i = p.out.length - 1; i >= 0; i--) {
          if (p.out[i].t !== 'p') continue;
          if (lastIdx < 0) lastIdx = i; else { prevIdx = i; break; }
        }
        if (prevIdx >= 0) p.out.splice(prevIdx, 1);      // 更早的那条扔掉
        p.out.push(msg);
      } else {
        p.out.push(msg);
      }
      if (p.out.length > 200) p.out.shift();
    }
  }
}
function playersPublic(w) {
  return Array.from(w.players.values()).map(p => ({
    i: p.id, n: p.name, x: +p.x.toFixed(2), y: +p.y.toFixed(2), z: +p.z.toFixed(2),
    w: +p.yaw.toFixed(2), q: +p.pitch.toFixed(2),
    sk: p.sk | 0, cl: p.cl | 0,                   // 外观：肤色 / 衣服颜色（0 = 没设置过）
    f: p.f || 0,                                 // 状态位：1=挖掘 2=疾跑 4=腾空（远端形象靠它做动画）
  }));
}
function hostId(w) {
  // 房主 = 开房的人（w.owner）；他重进房间时不能变成客人
  if (w.owner && w.players.has(w.owner)) return w.owner;
  const first = w.players.values().next(); return first.done ? null : first.value.id;
}

function applyEdit(w, p, msg) {
  const now = Date.now();
  if (now - p.editT > 1000) { p.editT = now; p.editN = 0; }
  p.editN++;
  if (p.editN > EDIT_PER_SEC) { stats.rejects++; return { ok: false, e: 'rate' }; }
  const x = msg.x | 0, y = msg.y | 0, z = msg.z | 0, b = msg.b | 0;
  if (y < 0 || y > 191) return { ok: false, e: 'range' };
  if (UNBREAKABLE.has(b)) return { ok: false, e: 'protected' };
  // 距离校验：允许 8 格（REACH 6 + 一点余量），防止瞬移拆家
  const d = Math.hypot(x + 0.5 - p.x, y + 0.5 - p.y, z + 0.5 - p.z);
  if (d > 8) { stats.rejects++; return { ok: false, e: 'far' }; }
  const key = x + ',' + y + ',' + z;
  // ★ 挖空（b=0）也必须落表：以前这里 delete，等于「挖掉的方块类型不记录」，
  //   重进世界时天然地形会把洞填回去（和单机版 indexEdit 那个 bug 同源）。
  w.edits.set(key, b);
  w.dirty = true;
  stats.edits++;
  w.seq++;
  w.log.push({ q: w.seq, x, y, z, b });
  if (w.log.length > 2000) w.log.shift();
  broadcast(w, { t: 'e', q: w.seq, x, y, z, b, from: p.id }, p.id);
  return { ok: true };
}

function join(req, res) {
  const code = String(req.code || 'W1').slice(0, 12);
  const w = loadWorld(code);
  if (w.genVer !== GEN_VER) {
    return json(res, { ok: false, e: 'gen_mismatch', genVer: w.genVer, serverGen: GEN_VER });
  }
  if (w.players.size >= MAX_PLAYERS) return json(res, { ok: false, e: 'full' });
  let id = String(req.pid || ('p' + Math.random().toString(36).slice(2, 8))).slice(0, 24);
  // ★ 同名占位：两台机器用同一个昵称时，以前两条连接抢同一个座位（服务端只认 pid），
  //   结果两端都把自己筛掉 → 「联机里看不到其他玩家」。现在给后来者加后缀，并把新 id 返回给客户端。
  const ex = w.players.get(id);
  if (ex && ex.ws) id = (id + '#' + Math.random().toString(36).slice(2, 4)).slice(0, 24);
  const name = String(req.name || 'Player').slice(0, 14);
  const isHost = w.owner ? (w.owner === id) : (w.players.size === 0);
  // ★ 上次在房间里的位置：座位一建好就坐在那儿（别人看到的快照也从老位置开始，不会从 0,0 闪一下）
  const keep = w.pos[id] || null;
  w.players.set(id, {
    id, name,
    x: keep ? +keep.x || 0 : 0, y: keep ? +keep.y || 0 : 0, z: keep ? +keep.z || 0 : 0,
    yaw: keep ? +keep.w || 0 : 0, pitch: keep ? +keep.q || 0 : 0,
    sk: Number(req.sk) || 0, cl: Number(req.cl) || 0,      // 外观（肤色/衣服）
    at: Date.now(), ws: null, editT: 0, editN: 0,
  });
  // ★ 兴趣管理：进服只发玩家附近的改动（默认 ±128 格），不是整张表。
  //   世界再大，进服包也是「几十 KB」量级；走远以后客户端用 region 分块补。
  const jx = Number(req.x) || 0, jz = Number(req.z) || 0, jr = Math.min(512, Number(req.r) || 128);
  const near = [];
  for (const [k, id] of w.edits) {
    const p = k.split(',');
    if (Math.abs(+p[0] - jx) <= jr && Math.abs(+p[2] - jz) <= jr) near.push([k, id]);
  }
  json(res, {
    ok: true, id, isHost, code, seed: w.seed, genVer: w.genVer, time: w.time, seq: w.seq,
    edits: near, totalEdits: w.edits.size, players: playersPublic(w),
    pos: keep,                                   // 你上次在房间里的位置（客户端进房后站回这里）
  });
  console.log(`[bw] join ${code} ${id}/${name} host=${isHost} players=${w.players.size} edits=${w.edits.size}`);
}

/* ---------------- 开房：把自己的单机世界搬成联机房间 ----------------
 * 「先进入自己的世界，再邀请好友」：客户端把 seed + 已有方块改动传上来，房间就用这个世界。
 * 同一个房间码反复开房是**幂等**的（只补差异），所以关掉房间明天再开还是同一片地形。
 * edits 分批上传（chunk:true 只合并不占座），第一批带 seed。 */
function hostWorld(req, res) {
  const code = String(req.code || '').slice(0, 12);
  if (!code) return json(res, { ok: false, e: 'no_code' });
  const w = loadWorld(code);
  const want = Number(req.seed);
  if (Number.isFinite(want) && want) {
    if (w.seed !== (want | 0)) {
      // 房间码撞了别人不同的种子：有内容就拒绝（客户端会换新码），空的就直接采用
      if (w.edits.size > 0 || w.players.size > 0) return json(res, { ok: false, e: 'seed_mismatch', seed: w.seed, edits: w.edits.size });
      w.seed = want | 0; w.dirty = true;
    }
  }
  w.genVer = GEN_VER;
  let n = 0;
  for (const e of (req.edits || []).slice(0, 1500)) {
    if (!Array.isArray(e) || e.length < 2) continue;
    const k = String(e[0]);
    if (!/^-?\d+,-?\d+,-?\d+$/.test(k)) continue;
    const v = e[1] | 0;
    if (w.edits.get(k) !== v) { w.edits.set(k, v); n++; }
  }
  if (n) w.dirty = true;
  if (req.chunk) return json(res, { ok: true, code, seed: w.seed, added: n, total: w.edits.size });
  w.owner = String(req.pid || '').slice(0, 24);        // 开房的人 = 房主（重进房间也不丢）
  return join(Object.assign({}, req, { code }), res);
}

function json(res, obj) {
  const s = JSON.stringify(obj);
  res.writeHead(200, {
    'content-type': 'text/plain; charset=utf-8',
    'access-control-allow-origin': '*',
    'access-control-allow-headers': '*',
    'cache-control': 'no-store',
  });
  res.end(s);
}

const server = http.createServer((req, res) => {
  if (req.method === 'OPTIONS') { res.writeHead(204, { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'POST,GET,OPTIONS' }); return res.end(); }
  if (req.url.startsWith('/api')) {
    let body = '';
    req.on('data', c => { body += c; stats.inBytes += c.length; });
    req.on('end', () => {
      let a = {};
      try { a = JSON.parse(body || '{}'); } catch (e) { return json(res, { ok: false, e: 'bad_json' }); }
      if (a.a === 'ping') return json(res, { ok: true, t: Date.now() });
      if (a.a === 'join') return join(a, res);
      if (a.a === 'host') return hostWorld(a, res);
      /* ---- 箱子：两个人开同一个箱子必须看到同一批东西 ---- */
      if (a.a === 'chest') {
        const w = loadWorld(String(a.code || 'W1'));
        const k = String(a.k || '').slice(0, 40);
        if (!k) return json(res, { ok: false, e: 'no_key' });
        if (Array.isArray(a.slots)) {                        // 写入（放/取之后整表覆盖，幂等）
          w.chests.set(k, a.slots.slice(0, 27).map(s => (s && s.id && s.n > 0) ? { id: s.id | 0, n: s.n | 0 } : null));
          w.dirty = true;
          broadcast(w, { t: 'ch', k, slots: w.chests.get(k), from: String(a.pid || '') }, String(a.pid || ''));
          return json(res, { ok: true });
        }
        return json(res, { ok: true, slots: w.chests.get(k) || null });
      }
      /* ---- 客人背包：按 pid 存服务端，进房/换设备都能拿回来 ---- */
      if (a.a === 'inv') {
        const w = loadWorld(String(a.code || 'W1'));
        const pid = String(a.pid || '').slice(0, 24);
        if (!pid) return json(res, { ok: false, e: 'no_pid' });
        if (a.set) {
          w.inv[pid] = { inv: a.set.inv || [], armor: a.set.armor || {}, hp: +a.set.hp || 20, hunger: +a.set.hunger || 20 };
          w.dirty = true;
          return json(res, { ok: true });
        }
        return json(res, { ok: true, data: w.inv[pid] || null });
      }
      if (a.a === 'hit') {                       // 轮询模式的「打幽灵怪」（没有 ws 的客户端走这条）
        const w = loadWorld(String(a.code || 'W1'));
        broadcast(w, { t: 'hit', i: a.i | 0, d: Math.min(30, Number(a.d) || 0), from: String(a.pid || '') }, String(a.pid || ''));
        return json(res, { ok: true });
      }
      if (a.a === 'drop') {                      // 客人挖出来的掉落物 → 转给主机去模拟
        const w = loadWorld(String(a.code || 'W1'));
        broadcast(w, { t: 'drop', u: a.u }, String(a.pid || ''));
        return json(res, { ok: true });
      }
      if (a.a === 'act') {                       // 轮询模式的「一次性动作」（挥砍/放置）
        const w = loadWorld(String(a.code || 'W1'));
        broadcast(w, { t: 'act', i: String(a.pid || ''), a: String(a.act || '').slice(0, 8) }, String(a.pid || ''));
        return json(res, { ok: true });
      }
      if (a.a === 'drops') {                     // 轮询模式下主机广播掉落物（没有 ws 的房主走这条）
        const w = loadWorld(String(a.code || 'W1'));
        broadcast(w, { t: 'd', u: a.u || [], from: String(a.pid || '') }, String(a.pid || ''));
        return json(res, { ok: true });
      }
      if (a.a === 'pick') {                      // 轮询模式的「捡走」上报（没有 ws 的客户端走这条）
        const w = loadWorld(String(a.code || 'W1'));
        // ★ 掉落物编号可能是字符串（客人挖的用 "g<pid>:<n>"），不能 |0 —— 转成 0 主机就删不掉那个掉落物了
        if (process.env.BW_DEBUG) console.log('[bw] pick', a.code, a.pid, JSON.stringify(a.i));
        broadcast(w, { t: 'pick', i: a.i, from: String(a.pid || '') }, String(a.pid || ''));
        return json(res, { ok: true });
      }
      if (a.a === 'stats') {
        return json(res, {
          ok: true, ...stats, uptime: Math.round((Date.now() - stats.started) / 1000),
          worlds: Array.from(worlds.values()).map(w => ({
            code: w.code, seed: w.seed, edits: w.edits.size, players: w.players.size, host: hostId(w),
          })),
        });
      }
      if (a.a === 'sync') {                     // ★ 公网轮询：一个请求完成 位置上行/编辑上行/消息下行
        const w = loadWorld(String(a.code || 'W1'));
        const pid = String(a.pid || '').slice(0, 24);
        let p = w.players.get(pid);
        if (!p) {
          if (w.players.size >= MAX_PLAYERS) return json(res, { ok: false, e: 'full' });
          p = { id: pid, name: String(a.name || 'Player').slice(0, 14), x: 0, y: 0, z: 0,
                yaw: 0, pitch: 0, sk: Number(a.sk) || 0, cl: Number(a.cl) || 0,
                at: Date.now(), ws: null, editT: 0, editN: 0, out: [] };
          w.players.set(pid, p);
        }
        p.at = Date.now();
        if (typeof a.sk === 'number') { p.sk = a.sk | 0; p.cl = a.cl | 0; }   // 外观随同步更新
        if (typeof a.x === 'number') {
          p.x = +a.x || 0; p.y = +a.y || 0; p.z = +a.z || 0;
          p.yaw = +a.w || 0; p.pitch = +a.q || 0;
          p.f = a.f | 0;
          // 每 10 秒把世界标脏一次：这样即使浏览器被直接杀掉，位置也能在 5s 落盘里存下来
          if (Date.now() - (p.posMark || 0) > 10000) { p.posMark = Date.now(); w.dirty = true; }
        }
        const ack = [];
        for (const ed of (a.edits || []).slice(0, 40)) {
          const r = applyEdit(w, p, ed);
          if (r.ok) ack.push(ed.seq); else ack.push(-ed.seq);      // 负数 = 被拒，客户端要回滚
        }
        // ★ 公网轮询模式下没有 ws：主机把「怪 / 掉落物」快照顺手挂在 sync 请求上，
        //   服务端在这里转发。以前这些只走 ws，于是轮询模式里别人家的怪和掉落物永远不同步。
        if (Array.isArray(a.mobs) && a.mobs.length) broadcast(w, { t: 'm', u: a.mobs }, pid);
        if (Array.isArray(a.drops)) broadcast(w, { t: 'd', u: a.drops }, pid);
        const out = (p.out || []).splice(0, 80);
        return json(res, {
          ok: true, id: p.id, host: hostId(w) === p.id, seq: w.seq, ack, out,
          players: playersPublic(w), time: w.time,
        });
      }
      if (a.a === 'acct' || a.a === 'friends') {
        const me = accOf(a.pid, a.nick, a.code);
        if (!me) return json(res, { ok: false, e: 'no_pid' });
        const out = {
          ok: true, me: accPublic(me),
          friends: (me.friends || []).map(id => ACCOUNTS[id]).filter(Boolean).map(accPublic),
          req: a.a === 'acct' ? (me.req || []) : (me.req || []),
          inv: me.inv || [],                         // 别人邀请我进的房间（好友面板里显示「加入」）
        };
        if (a.a === 'friends') me.req = [];        // friends 是"取走即清"，acct 只是心跳顺带看一眼
        saveAccounts();
        return json(res, out);
      }
      if (a.a === 'fadd') {                        // 按昵称加好友（互相加）
        const me = accOf(a.pid, a.nick, a.code);
        if (!me) return json(res, { ok: false, e: 'no_pid' });
        const t = accByNick(a.target);
        if (!t) return json(res, { ok: false, e: 'no_user' });
        if (t.pid === me.pid) return json(res, { ok: false, e: 'self' });
        if (!me.friends.includes(t.pid)) me.friends.push(t.pid);
        if (!t.friends.includes(me.pid)) t.friends.push(me.pid);
        saveAccounts();
        pushTo(t.pid, { t: 'f', nick: me.nick });
        return json(res, { ok: true, friend: accPublic(t) });
      }
      if (a.a === 'jreq') {                        // 申请加入好友的世界
        const me = accOf(a.pid, a.nick, a.code);
        if (!me) return json(res, { ok: false, e: 'no_pid' });
        const t = ACCOUNTS[String(a.to || '')];
        if (!t) return json(res, { ok: false, e: 'no_user' });
        if (!(me.friends || []).includes(t.pid)) return json(res, { ok: false, e: 'not_friend' });
        if (!accOnline(t)) return json(res, { ok: false, e: 'offline' });
        const r = { from: me.pid, nick: me.nick, code: t.world, at: Date.now() };
        t.req = (t.req || []).filter(x => x.from !== me.pid);
        t.req.push(r);
        if (t.req.length > 8) t.req.shift();
        saveAccounts();
        pushTo(t.pid, { t: 'req', req: r });
        return json(res, { ok: true, sent: true });
      }
      if (a.a === 'jres') {                        // 好友回应申请：同意 → 通知他来我的世界
        const me = accOf(a.pid, a.nick, a.code);
        if (!me) return json(res, { ok: false, e: 'no_pid' });
        const who = ACCOUNTS[String(a.from || '')];
        if (!who) return json(res, { ok: false, e: 'no_user' });
        me.req = (me.req || []).filter(x => x.from !== who.pid);
        if (a.ok) {
          who.inv = (who.inv || []).filter(x => x.code !== me.world);
          who.inv.push({ code: me.world, nick: me.nick, at: Date.now() });
          if (who.inv.length > 8) who.inv.shift();
          pushTo(who.pid, { t: 'acc', code: me.world, nick: me.nick });
        } else {
          pushTo(who.pid, { t: 'deny', nick: me.nick });
        }
        saveAccounts();
        return json(res, { ok: true, accepted: !!a.ok });
      }
      if (a.a === 'invite') {                     // 房主邀请好友进自己的房间（方向：我拉你，不用你申请）
        const me = accOf(a.pid, a.nick, a.code);
        if (!me) return json(res, { ok: false, e: 'no_pid' });
        const t = ACCOUNTS[String(a.to || '')];
        if (!t) return json(res, { ok: false, e: 'no_user' });
        if (!(me.friends || []).includes(t.pid)) return json(res, { ok: false, e: 'not_friend' });
        const code = String(a.code || me.world || '').slice(0, 12);
        if (!code) return json(res, { ok: false, e: 'no_room' });
        const r = { code, nick: me.nick, at: Date.now() };
        t.inv = (t.inv || []).filter(x => x.code !== code);
        t.inv.push(r);
        if (t.inv.length > 8) t.inv.shift();
        saveAccounts();
        const pushed = pushTo(t.pid, { t: 'inv', code, nick: me.nick });
        return json(res, { ok: true, sent: true, pushed });
      }
      if (a.a === 'region') {                    // 依序补发某片区域的改动（客户端走远了就来拉一次）
        const w = loadWorld(String(a.code || 'W1'));
        const x = Number(a.x) || 0, z = Number(a.z) || 0, r = Math.min(256, Number(a.r) || 112);
        const out = [];
        for (const [k, id] of w.edits) {
          const p = k.split(',');
          if (Math.abs(+p[0] - x) <= r && Math.abs(+p[2] - z) <= r) out.push([k, id]);
        }
        return json(res, { ok: true, n: out.length, edits: out });
      }
      if (a.a === 'since') {                     // 断线补发：给我 after 之后的所有编辑
        const w = loadWorld(String(a.code || 'W1'));
        const after = Number(a.after) || 0;
        const first = w.log.length ? w.log[0].q : w.seq + 1;
        if (after + 1 < first) {                 // 日志已经被裁掉 → 只能整表重发
          return json(res, { ok: true, resync: true, seq: w.seq,
                             edits: Array.from(w.edits.entries()) });
        }
        return json(res, { ok: true, resync: false, seq: w.seq,
                           edits: w.log.filter(e => e.q > after).map(e => [e.x, e.y, e.z, e.b]) });
      }
      if (a.a === 'leave') {                     // 测试/掉线清理用（正常玩家由 ws close 处理）
        const w = worlds.get(String(a.code || 'W1'));
        if (!w) return json(res, { ok: false, e: 'no_world' });
        w.players.delete(String(a.pid || ''));
        broadcast(w, { t: 'left', i: String(a.pid || '') });
        if (w.players.size === 0) saveWorld(w);
        return json(res, { ok: true, players: w.players.size });
      }
      if (a.a === 'state') {
        const w = loadWorld(String(a.code || 'W1'));
        return json(res, { ok: true, players: playersPublic(w), host: hostId(w), edits: w.edits.size, time: w.time });
      }
      return json(res, { ok: false, e: 'unknown_action' });
    });
    return;
  }
  res.writeHead(404); res.end('blockwild mp daemon');
});

/* ---------------- WebSocket 升级 ---------------- */
server.on('upgrade', (req, socket) => {
  const key = req.headers['sec-websocket-key'];
  if (!key) { socket.destroy(); return; }
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\nConnection: Upgrade\r\n' +
    'Sec-WebSocket-Accept: ' + acceptKey(key) + '\r\n\r\n');
  socket.__buf = Buffer.alloc(0);
  socket.__w = null; socket.__p = null;

  socket.on('data', chunk => {
    stats.inBytes += chunk.length;
    socket.__buf = Buffer.concat([socket.__buf, chunk]);
    const { frames, rest } = parse(socket.__buf);
    socket.__buf = rest;
    for (const f of frames) {
      if (f.op === 0x8) { try { socket.end(); } catch (e) {} return; }
      if (f.op === 0x9) { try { socket.write(Buffer.from([0x8a, 0])); } catch (e) {} continue; }
      if (f.op !== 0x1) continue;
      stats.msgsIn++;
      let m;
      try { m = JSON.parse(f.payload.toString('utf8')); } catch (e) { continue; }
      onMsg(socket, m);
    }
  });
  socket.on('close', () => dropSocket(socket));
  socket.on('error', () => dropSocket(socket));
});

function onMsg(socket, m) {
  if (m.t === 'hello') {                       // 绑定 socket 到玩家
    const w = worlds.get(String(m.code || 'W1'));
    let p = w && w.players.get(String(m.id));
    if (!p) {
      // ★ 断线重连���socket 断开时座位已经被 dropSocket 删掉了，这里必须**重建座位**，
      //   否则重连的客户端「连着但没座位」——收不到快照、也不再是主机，表现就是「回来之后卡住/看不到人」。
      if (!w || w.players.size >= MAX_PLAYERS) {
        try { socket.write(frame(JSON.stringify({ t: 'err', e: 'no_seat' }))); } catch (e) {}
        return;
      }
      p = { id: String(m.id), name: String(m.name || 'Player').slice(0, 14), x: 0, y: 0, z: 0,
            yaw: 0, pitch: 0, sk: Number(m.sk) || 0, cl: Number(m.cl) || 0,
            at: Date.now(), ws: null, editT: 0, editN: 0 };
      w.players.set(p.id, p);
      console.log(`[bw] rejoin ${w.code} ${p.id} players=${w.players.size}`);
    }
    socket.__w = w; socket.__p = p; p.ws = socket; p.at = Date.now();
    const since = Number(m.since) || 0;
    const first = w.log.length ? w.log[0].q : w.seq + 1;
    const resync = since + 1 < first;
    const missed = resync ? Array.from(w.edits.entries()) : w.log.filter(e => e.q > since).map(e => [e.x, e.y, e.z, e.b]);
    socket.write(frame(JSON.stringify({
      t: 'ok', id: p.id, host: hostId(w) === p.id, seq: w.seq, resync, missed, code: w.code,
    })));
    return;
  }
  const w = socket.__w, p = socket.__p;
  if (!w || !p) return;
  p.at = Date.now();
  if (m.t === 'p') {                          // 位置（客户端权威）
    p.x = +m.x || 0; p.y = +m.y || 0; p.z = +m.z || 0;
    p.yaw = +m.w || 0; p.pitch = +m.q || 0;
    p.f = m.f | 0;                            // 挖掘/疾跑/腾空 状态位 → 广播给其他人做动作
    if (typeof m.sk === 'number') { p.sk = m.sk | 0; p.cl = m.cl | 0; }   // 外观随位置包更新（改色立刻可见）
    if (Date.now() - (p.posMark || 0) > 10000) { p.posMark = Date.now(); w.dirty = true; }
  } else if (m.t === 'act') {                 // 一次性动作（挥砍/放置）：转发给同房间其他人
    broadcast(w, { t: 'act', i: p.id, a: String(m.act || '').slice(0, 8) }, p.id);
  } else if (m.t === 'e') {                   // 方块编辑（服务端权威）
    const r = applyEdit(w, p, m);
    if (!r.ok) { try { socket.write(frame(JSON.stringify({ t: 'rej', seq: m.seq, e: r.e, x: m.x, y: m.y, z: m.z }))); } catch (e) {} }
    else { try { socket.write(frame(JSON.stringify({ t: 'ack', seq: m.seq }))); } catch (e) {} }
  } else if (m.t === 'hit') {                 // 非主机打的怪：转发给所有人，只有当前主机会真的扣血
    broadcast(w, { t: 'hit', i: m.i, d: Math.min(30, Number(m.d) || 0), from: p.id }, p.id);
  } else if (m.t === 'm') {                   // 主机广播的怪快照：只转发，服务端不模拟
    broadcast(w, { t: 'm', u: m.u, from: p.id }, p.id);
  } else if (m.t === 'd') {                   // 主机广播的掉落物快照：只转发
    broadcast(w, { t: 'd', u: m.u, from: p.id }, p.id);
  } else if (m.t === 'pick') {                // 「我捡走了这个掉落物」→ 主机删掉它，其他人也跟着消失
    broadcast(w, { t: 'pick', i: m.i, from: p.id }, p.id);
  } else if (m.t === 'time') {
    w.time = +m.time || w.time;
  }
}

function dropSocket(socket) {
  const w = socket.__w, p = socket.__p;
  if (!w || !p) return;
  if (w.players.get(p.id) === p) {
    w.pos[p.id] = { x: +(+p.x).toFixed(2), y: +(+p.y).toFixed(2), z: +(+p.z).toFixed(2),
                    w: +(+p.yaw).toFixed(3), q: +(+p.pitch).toFixed(3) };   // 断线前的位置要留住
    w.dirty = true;
    w.players.delete(p.id);
    console.log(`[bw] leave ${w.code} ${p.id} players=${w.players.size}`);
    broadcast(w, { t: 'left', i: p.id });
    if (w.players.size === 0) saveWorld(w);
  }
  socket.__w = null; socket.__p = null;
}

/* ---------------- 主循环：10Hz 位置广播 ---------------- */
setInterval(() => {
  for (const w of worlds.values()) {
    if (!w.players.size) continue;
    const msg = { t: 'p', u: playersPublic(w), time: +w.time.toFixed(1), host: hostId(w) };
    broadcast(w, msg);
    // 未绑定 socket 的僵尸座位：清掉之前先把位置留下（轮询模式玩家每 90ms 会刷新 at，不会误删）
    for (const p of Array.from(w.players.values())) {
      if (p.ws || Date.now() - p.at <= 20000) continue;
      w.pos[p.id] = { x: +(+p.x).toFixed(2), y: +(+p.y).toFixed(2), z: +(+p.z).toFixed(2),
                      w: +(+p.yaw).toFixed(3), q: +(+p.pitch).toFixed(3) };
      w.dirty = true;
      w.players.delete(p.id);
    }
  }
}, 1000 / SNAP_HZ);

// 5 秒落盘一次（只有脏世界）
setInterval(() => {
  for (const w of worlds.values()) if (w.dirty) saveWorld(w);
}, 5000);

process.on('SIGTERM', () => { for (const w of worlds.values()) saveWorld(w); process.exit(0); });
process.on('SIGINT', () => { for (const w of worlds.values()) saveWorld(w); process.exit(0); });

server.listen(PORT, () => console.log(`[bw] daemon listening :${PORT}  data=${DATA}  gen=${GEN_VER}`));
