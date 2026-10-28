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
const SNAP_HZ = 10;                 // 位置广播频率
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
    const d = { seed: w.seed, genVer: w.genVer, time: w.time, edits: Array.from(w.edits.entries()) };
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
    return w;
  } catch (e) { console.error('[bw] 读盘失败', code, e.message); return newWorld(code); }
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
    if (!p.ws || p.id === exceptId) continue;
    try { p.ws.write(f); stats.outBytes += f.length; stats.msgsOut++; } catch (e) { /* 掉线等 close 处理 */ }
  }
}
function playersPublic(w) {
  return Array.from(w.players.values()).map(p => ({
    i: p.id, n: p.name, x: +p.x.toFixed(2), y: +p.y.toFixed(2), z: +p.z.toFixed(2),
    w: +p.yaw.toFixed(2), q: +p.pitch.toFixed(2),
  }));
}
function hostId(w) { const first = w.players.values().next(); return first.done ? null : first.value.id; }

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
  const id = String(req.pid || ('p' + Math.random().toString(36).slice(2, 8))).slice(0, 24);
  const name = String(req.name || 'Player').slice(0, 14);
  const isHost = w.players.size === 0;
  w.players.set(id, {
    id, name, x: 0, y: 0, z: 0, yaw: 0, pitch: 0, at: Date.now(), ws: null, editT: 0, editN: 0,
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
  });
  console.log(`[bw] join ${code} ${id}/${name} host=${isHost} players=${w.players.size} edits=${w.edits.size}`);
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
      if (a.a === 'stats') {
        return json(res, {
          ok: true, ...stats, uptime: Math.round((Date.now() - stats.started) / 1000),
          worlds: Array.from(worlds.values()).map(w => ({
            code: w.code, seed: w.seed, edits: w.edits.size, players: w.players.size, host: hostId(w),
          })),
        });
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
      // ★ 断线重连：socket 断开时座位已经被 dropSocket 删掉了，这里必须**重建座位**，
      //   否则重连的客户端「连着但没座位」——收不到快照、也不再是主机，表现就是「回来之后卡住/看不到人」。
      if (!w || w.players.size >= MAX_PLAYERS) {
        try { socket.write(frame(JSON.stringify({ t: 'err', e: 'no_seat' }))); } catch (e) {}
        return;
      }
      p = { id: String(m.id), name: String(m.name || 'Player').slice(0, 14), x: 0, y: 0, z: 0,
            yaw: 0, pitch: 0, at: Date.now(), ws: null, editT: 0, editN: 0 };
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
  } else if (m.t === 'e') {                   // 方块编辑（服务端权威）
    const r = applyEdit(w, p, m);
    if (!r.ok) { try { socket.write(frame(JSON.stringify({ t: 'rej', seq: m.seq, e: r.e, x: m.x, y: m.y, z: m.z }))); } catch (e) {} }
    else { try { socket.write(frame(JSON.stringify({ t: 'ack', seq: m.seq }))); } catch (e) {} }
  } else if (m.t === 'hit') {                 // 非主机打的怪：转发给所有人，只有当前主机会真的扣血
    broadcast(w, { t: 'hit', i: m.i, d: Math.min(30, Number(m.d) || 0), from: p.id }, p.id);
  } else if (m.t === 'm') {                   // 主机广播的怪快照：只转发，服务端不模拟
    broadcast(w, { t: 'm', u: m.u, from: p.id }, p.id);
  } else if (m.t === 'time') {
    w.time = +m.time || w.time;
  }
}

function dropSocket(socket) {
  const w = socket.__w, p = socket.__p;
  if (!w || !p) return;
  if (w.players.get(p.id) === p) {
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
    for (const p of w.players.values()) if (!p.ws && Date.now() - p.at > 20000) w.players.delete(p.id);   // 未绑定 socket 的僵尸座位
  }
}, 1000 / SNAP_HZ);

// 5 秒落盘一次（只有脏世界）
setInterval(() => {
  for (const w of worlds.values()) if (w.dirty) saveWorld(w);
}, 5000);

process.on('SIGTERM', () => { for (const w of worlds.values()) saveWorld(w); process.exit(0); });
process.on('SIGINT', () => { for (const w of worlds.values()) saveWorld(w); process.exit(0); });

server.listen(PORT, () => console.log(`[bw] daemon listening :${PORT}  data=${DATA}  gen=${GEN_VER}`));
