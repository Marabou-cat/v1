#!/usr/bin/env node
/* =============================================================================
 *  超级乱斗 · 联机房间守护进程 (zero-dependency)
 *  职责：房间/座位管理、输入中继（锁定步）、帧确认、掉线变 AI、观战、去同步检测、战绩落盘
 *  传输：1) 原生 WebSocket（/ws，需要 Apache 反代或直连端口）
 *        2) HTTP JSON API（POST /api，供 PHP 透传用，无需 root）
 *  HTTP / WS 共用同一套 action，业务逻辑只有一份。
 * ========================================================================== */
'use strict';
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PORT = parseInt(process.env.SB_PORT || process.argv[2] || '9001', 10);
const HOST = process.env.SB_HOST || '127.0.0.1';
const DATA_DIR = process.env.SB_DATA || path.join(__dirname, 'data');
const MAX_ROOMS = 200;
const SEAT_TIMEOUT_MS = 1200;      // 超过这个时间没收到该座位消息 → 判定掉线
/* AI 接管阈值：判定依据 =「有没有在往房间里送输入」（`inT`），而不是「有没有发消息」也不是
   「它自己报的帧号有没有涨」。
   为什么三层判据都不够：
     · lastSeen（有没有消息）：后台标签页的 setInterval 泵照样发消息 → 认为活着 → 全场永久冻住。
     · frameSeen（自报帧号）：能收不能发的链路（上行被限/丢包）自报帧号照涨，但别人拿不到它的输入
       → 剩下的人照样永久卡住。
     · inT（最后一条**被存进房间的输入**）：直接量「这个座位有没有在给房间供货」，上面三种情况全能命中。
   450ms = 54 帧游戏时间没供上任何输入，只有真的卡住/掉线才会这样。玩家回来后连续输入 500ms 自动收回。 */
const AI_TAKEOVER_MS = 900;         // 原本 450ms。450ms 在校园网/Chromebook 上一次普通卡顿就会误判掉线：
                                    // 误判 → AI 接管 → 玩家迟到的输入到货 → 「谁控制这个座位」两个序列分叉 → 永久去同步。
                                    // 短卡顿（<900ms）根本不该接管：迟到的输入会被正常回放，全局仍然一致。
const EV_MARGIN = 30;               // 「控制权切换」统一生效帧的余量（30 帧 = 250ms @120Hz）
const START_GRACE_MS = 2500;        // 开局宽限：客户端要加载场景/建网格/连上先跑几帧，头一两秒供不上输入是正常的。
                                    // 实测（无头/低帧率环境）开局 900ms 内所有座位就被判成离线 → 两个真人座位全被 AI 接管
                                    // → 房间失去锁定步（各端自由跑各自的 AI）→ 帧号漂移 → 「画面不同步」。
                                    // 真机（30~60fps）一般 100~300ms 就能供货，这个宽限不会挡住真正的掉线判活。
/* 控制权切换（AI 接管 / 交还）必须是一个**所有端完全相同的绝对帧**。
   各端 FRAME 不一样；以前客户端用 max(FRAME+2, evFrame) 自己算 → 各端在不同帧切换 → AI(Bot 构造要抽随机数)
   在不同帧开始跑 → 随机数流错位 → 画面永久不同步（用户报的正是这个）。
   帧 = max(服务端已知最高输入帧, 各座位自报帧) + 余量，保证对每一端都在「未来」，且所有端读到同一个数。 */
function eventFrame(room) {
  let mx = room.frameHigh | 0;
  for (const s of room.seats) if (s && s.frameSeen) mx = Math.max(mx, s.frameSeen | 0);
  return mx + EV_MARGIN;
}
const AI_RECOVER_MS = 500;         // 连续输入多久后把控制权还给玩家（迟滞，防抖）
const ROOM_IDLE_MS = 1000 * 60 * 20;
const INPUT_KEEP = 900;            // 每个座位保留最近多少帧输入（2B/帧，内存可忽略）
const ROOM_CODE_LEN = 5;
/* 调试用人工延迟（毫秒）：SB_LAG_MS=120 可在本机复现 120ms 单程延迟，用于压测锁同步 */
const LAG_MS = parseInt(process.env.SB_LAG_MS || '0', 10);
/* 角色池：仅用于空位（AI）的确定性兜底 —— 必须与客户端 CHARS 顺序一致 */
const CHAR_POOL = ['sparky','rocky','zephyr','cobalt','mage','warrior','archer','knight', 'pumpkin', 'smiley', 'turtle', 'titan', 'teacher', 'baby', 'dragon', 'shadow', 'slayer', 'reaper', 'gorilla', 'hacker', 'blocky', 'blub'];

try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (e) {}
const RESULTS_FILE = path.join(DATA_DIR, 'results.jsonl');
const LOG_FILE = path.join(DATA_DIR, 'daemon.log');

function log(...a) {
  const line = new Date().toISOString() + ' ' + a.map(x => typeof x === 'string' ? x : JSON.stringify(x)).join(' ');
  try { fs.appendFileSync(LOG_FILE, line + '\n'); } catch (e) {}
  if (process.env.SB_QUIET !== '1') console.log(line);
}

/* ------------------------------------------------------------------ 房间状态 */
const rooms = new Map();       // code -> room
let roomSeq = 0;

function newCode() {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  for (let tries = 0; tries < 500; tries++) {
    let c = '';
    for (let i = 0; i < ROOM_CODE_LEN; i++) c += A[crypto.randomInt(A.length)];
    if (!rooms.has(c)) return c;
  }
  return 'R' + (++roomSeq);      // 兜底
}
function newToken() { return crypto.randomBytes(12).toString('hex'); }
/* 房间密码：只存 hash（列表接口绝不会泄露原文），加固定前缀防彩虹表 */
function passHash(p) { return crypto.createHash('sha1').update('sbra|' + String(p)).digest('hex').slice(0, 16); }
/* 建房限流：同一玩家 10 秒只能建一个房（防手滑连点 / 刷房）。
   身份用客户端持久化的 pid（localStorage）—— 经 PHP 透传时守护进程看到的源 IP 恒为 127.0.0.1，
   拿 IP 当身份会把所有玩家一起限掉。 */
const CREATE_COOLDOWN_MS = 10000;
const lastCreate = new Map();          // pid -> 上次建房时间戳

function createRoom(opts) {
  const code = newCode();
  const o = opts || {};
  const room = {
    code,
    created: Date.now(),
    updated: Date.now(),
    state: 'lobby',            // lobby | play | end
    gen: 1,                    // 对局代次：每次开局/再来一局 +1。客户端靠它判断「这是新一局」，
                               // 而不是靠「房间在 play 且我这局结束了」——后者会撞上结算上报的时间差，
                               // 把刚结束的局又重开一次（结算页被隐藏、按钮不出现，实测踩到）。
    pub: o.pub !== false,      // 公共房（默认）／私密房
    passHash: (o.pub === false && o.pass) ? passHash(o.pass) : null,
    frameHigh: 0,
    hostSeat: 0,
    seed: (crypto.randomInt(0xffffffff) >>> 0),
    startFrame: 0,
    rules: Object.assign({ count: 4, stocks: 3, time: 180, diff: 2 }, opts && opts.rules),
    seats: [],
    inputs: new Map(),         // seatIdx -> Map(frame -> bits)
    clients: new Set(),        // ws 连接
    specs: new Set(),          // 观战 ws
    hashes: new Map(),         // frame -> Map(seat -> hash)
    ack: {},                   // seat -> 该座位已执行到的帧（用于裁剪与超前限制）
    desync: null,
    results: null,
    rematch: new Set(),        // 「再来一局」投票：已投的 seat 号（全员同意才开下一局）
    lastHashFrame: -1,
  };
  rooms.set(code, room);
  log('[room] create', code, JSON.stringify(room.rules));
  return room;
}

/* 座位：每人一个，带 token；掉线后 token 可重连；无主座位由 AI 接管 */
function seatIndex(room, token) {
  if (!token) return -1;
  for (let i = 0; i < room.seats.length; i++) if (room.seats[i].token === token) return i;
  return -1;
}
function freeSeatIndex(room) {
  for (let i = 0; i < room.rules.count; i++) if (!room.seats[i]) return i;
  return -1;
}
function seatPublic(s) {
  return s ? { seat: s.seat, name: s.name, char: s.char, ready: !!s.ready, ai: !!s.ai,
               connected: !!s.connected, bot: !!s.bot, aiFrom: s.aiFrom | 0 } : null;
}
function roomPublic(room) {
  const seats = [];
  for (let i = 0; i < room.rules.count; i++) seats.push(seatPublic(room.seats[i]));
  return { code: room.code, state: room.state, hostSeat: room.hostSeat, rules: room.rules,
           gen: room.gen | 0,                     // 代次：客户端用它分辨「新一局」（见 createRoom 注释）
           locked: !!room.passHash,               // 大厅里给房主/加入者看「这是私密房」（不含密码本身）
           evFrame: (room.frameHigh | 0) + 12,   // 事件统一生效帧（留足余量，保证各端同帧应用）
           seats, seed: room.seed, startFrame: room.startFrame,
           spectators: room.specs.size, desync: room.desync };
}

/* 广播给房内所有实况连接（含观战），不发给 except */
function broadcast(room, msg, except) {
  const s = JSON.stringify(msg);
  for (const ws of room.clients) if (ws !== except && ws.readyState === 1) ws.send(s);
  for (const ws of room.specs) if (ws !== except && ws.readyState === 1) ws.send(s);
}

/* 每个座位自己的输入窗口：从它需要的帧一直给到服务器最新帧。
   早期版本只给 [f-2, f+10] 的窄窗，一旦客户端落后于窗口就再也拿不到缺的那一帧 →
   永久卡死（实战踩到）。2 字节/帧，多给几十帧的流量可以忽略，正确性优先。 */
function inputWindow(room, fromFrame) {
  const out = {};
  const from = Math.max(0, fromFrame | 0);
  const to = Math.max(from, room.frameHigh | 0);
  for (const s of room.seats) {
    if (!s) continue;
    const m = room.inputs.get(s.seat);
    if (!m) continue;
    const obj = {};
    let n = 0;
    for (let f = from; f <= to && n < 200; f++) {
      if (m.has(f)) { obj[f] = m.get(f); n++; }
    }
    if (n) out[s.seat] = obj;
  }
  return out;
}

function minAck(room) {
  let m = null;
  for (const s of room.seats) {
    if (!s || s.ai) continue;
    const a = room.ack[s.seat] !== undefined ? room.ack[s.seat] : room.startFrame || 0;
    m = (m === null) ? a : Math.min(m, a);
  }
  return m === null ? (room.frameHigh | 0) : m;
}
/* 新一局开始时把「按帧号索引」的对局状态全部作废 —— 帧号在新一局从 0 重新计数，
   上一局的 ack / inputs / hashes 留着就会污染新一局：
   ack 残留 → minAck 变大 → storeInput 的裁剪 (cut = minAck-60) 把新一局 1..N 帧的输入全删掉
   → 两端 haveAll() 永远为假 → 全场卡死在帧 0（实测复现：ack=4199，新一局输入一个都取不到）。
   ⚠ start 与 rematch 两条开局路径都必须调用（只清一条 = 另一条照样卡死）。 */
function resetMatchInput(room) {
  room.inputs.clear();        // seat -> Map(frame -> bits)
  room.ack = {};              // seat -> 已执行帧
  room.hashes.clear();        // 去同步检测的帧哈希
  room.frameHigh = 0;
  room.startFrame = 0;
  room.desync = null;
}
function storeInput(room, seat, frame, bits) {
  if (frame > minAck(room) + 600) return;          // 跑太前的输入丢弃（正常客户端不会发生）
  const so = room.seats[seat];
  if (so) so.inT = Date.now();                     // 「这个座位最后供货时间」→ AI 接管判据（见 AI_TAKEOVER_MS）
  let m = room.inputs.get(seat);
  if (!m) { m = new Map(); room.inputs.set(seat, m); }
  m.set(frame, bits);
  // 裁剪基准＝最慢座位已执行到的帧（否则慢端还没用到的输入会被提前丢掉）
  const cut = minAck(room) - 60;
  if (cut > 0) for (const f of m.keys()) if (f < cut) m.delete(f);
  // 帧号推进
  if (frame > room.frameHigh) room.frameHigh = frame;
}
function seatLastSeen(room) {
  let t = 0;
  for (const s of room.seats) if (s) t = Math.max(t, s.lastSeen || 0);
  return t;
}

/* ------------------------------------------------------------ 掉线 / AI 接管 */
function tick() {
  const now = Date.now();
  for (const room of rooms.values()) {
    if (room.state === 'play') {
      for (const s of room.seats) {
        if (!s || s.bot) continue;
        const noMsg = now - (s.lastSeen || 0);
        /* inT = 最后一条「被存进房间」的输入的时间（见 AI_TAKEOVER_MS 注释：这才是「在给房间供货」的证据） */
        const noFeed = now - (s.inT || now);
        const inGrace = (now - (room.startT || 0)) < START_GRACE_MS;    // 开局宽限内一律不判离线
        if (!s.ai && !inGrace && (noFeed > AI_TAKEOVER_MS || noMsg > 5000)) {
          s.ai = true; s.recoverMs = 0;               // 交给 AI（各端本地跑，结果一致）
          s.aiFrom = eventFrame(room);                // ⚠ 固定生效帧：所有端必须在这一帧一起切
          s.connected = false;
          room.updated = now;
          broadcast(room, { a:'ev', room: room.code, f: s.aiFrom, seat: s.seat, ai: true, why: noFeed > AI_TAKEOVER_MS ? 'stalled' : 'timeout' });
          log('[ai] takeover', room.code, 'seat', s.seat, noFeed > AI_TAKEOVER_MS ? 'stalled' : 'timeout', Math.round(noFeed) + 'ms');
        }
      }
    }
    if (now - room.updated > ROOM_IDLE_MS) {
      log('[room] reap', room.code);
      for (const ws of room.clients) try { ws.close(); } catch (e) {}
      for (const ws of room.specs) try { ws.close(); } catch (e) {}
      rooms.delete(room.code);
    }
  }
  if (rooms.size > MAX_ROOMS) {
    const arr = [...rooms.values()].sort((a, b) => a.updated - b.updated);
    for (let i = 0; i < arr.length - MAX_ROOMS; i++) rooms.delete(arr[i].code);
  }
}
setInterval(tick, 150).unref();     // 150ms：AI 接管 / 空房回收的检测粒度（原 500ms 会让「掉线冻结」多拖最多半秒）

/* --------------------------------------------------------------- 战绩落盘 */
function saveResult(room, res) {
  const rec = { t: Date.now(), room: room.code, rules: room.rules, seed: room.seed,
                seats: room.seats.filter(Boolean).map(s => ({ seat: s.seat, name: s.name, char: s.char, bot: s.bot })),
                result: res };
  try { fs.appendFileSync(RESULTS_FILE, JSON.stringify(rec) + '\n'); } catch (e) { log('[err] result', e.message); }
  room.results = rec;
  log('[result]', room.code, JSON.stringify(res));
}

/* ============================================================ 业务逻辑（共用） */
function handle(act, ctx) {
  const now = Date.now();
  /* --- 建房 / 加入 --- */
  if (act.a === 'hello') {
    let room = act.room ? rooms.get(String(act.room).toUpperCase()) : null;
    /* 私密房必须真的给一个密码，否则就是「锁了但没钥匙」的空房 */
    if (!room && act.create && act.opts && act.opts.pub === false &&
        !String(act.opts.pass || '').trim()) return { ok: false, e: 'need_pass' };
    const justCreated = !room && !!act.create;         // 只有「这一下真的新建了」才跳过密码校验
    if (!room && act.create) {
      /* 建房限流（10 秒一个）。放在「密码合法性」检查之后：被拒的请求不该吃掉冷却时间 */
      const pid = String(act.pid || '').slice(0, 48);
      if (pid) {
        const left = CREATE_COOLDOWN_MS - (now - (lastCreate.get(pid) || 0));
        if (left > 0) return { ok: false, e: 'rate_limited', wait: Math.ceil(left / 1000) };
        lastCreate.set(pid, now);
        if (lastCreate.size > 800) {                   // 防内存膨胀：清掉早就过期的记录
          for (const [k, v] of lastCreate) if (now - v > CREATE_COOLDOWN_MS * 6) lastCreate.delete(k);
        }
      }
      room = createRoom(act.opts);
    }
    if (!room) return { ok: false, e: 'room_not_found' };
    room.updated = now;

    /* 私密房：加入/观战必须密码正确；建房者本人与凭 token 重连不用（你已经有权了）。
       ⚠ 建房时密码在 act.opts.pass（客户端约定），加入时在 act.pass —— 别混。 */
    if (!justCreated && room.passHash && seatIndex(room, act.token) < 0) {
      if (!act.pass || passHash(act.pass) !== room.passHash) return { ok: false, e: 'bad_pass' };
    }

    if (act.spec) {                                   // 观战
      room.specs.add(ctx.ws || { readyState: 1, send(){}, close(){} });
      ctx.room = room; ctx.isSpec = true;
      return { ok: true, spec: true, room: roomPublic(room), f: room.frameHigh,
               in: inputWindow(room, room.frameHigh) };
    }

    let idx = seatIndex(room, act.token);
    let reconnected = false;
    if (idx < 0) {
      if (room.state !== 'lobby') return { ok: false, e: 'game_in_progress' };
      idx = freeSeatIndex(room);
      if (idx < 0) return { ok: false, e: 'room_full' };
    } else reconnected = true;

    const prev = room.seats[idx];
    const s = {
      seat: idx,
      token: (prev && prev.token) || newToken(),
      name: String(act.name || (prev && prev.name) || ('玩家' + (idx + 1))).slice(0, 12),
      /* 只有大厅能改角色：对局中重连必须沿用原角色，否则各端FIGHTERS不一致 → 锁同步desync */
      char: (room.state === 'lobby' && act.char) ? act.char : ((prev && prev.char) || 'sparky'),
      ready: reconnected ? (prev && prev.ready) : false,
      ai: false, bot: !!act.bot, connected: true, lastSeen: now,
      frameSeen: 0, frameT: now, recoverMs: 0,          // 帧号推进判活用（见 AI_TAKEOVER_MS 注释）
      joined: (prev && prev.joined) || now,
    };
    room.seats[idx] = s;
    if (reconnected && s.ai) {                        // 断线回来了：收回控制权
      s.ai = false;
      broadcast(room, { a:'ev', room: room.code, f: (room.frameHigh | 0) + 12, seat: idx, ai: false, why:'reconnect' });
      log('[ai] reclaim', room.code, 'seat', idx);
    }
    ctx.room = room; ctx.seat = idx;
    if (ctx.ws) room.clients.add(ctx.ws);

    const wel = { ok: true, room: roomPublic(room), seat: idx, token: s.token,
                  seed: room.seed, startFrame: room.startFrame, start: room.state === 'play',
                  reconnected, f: room.frameHigh };
    if (room.state === 'play') wel.in = inputWindow(room, room.frameHigh);
    broadcast(room, { a:'seats', room: roomPublic(room) }, ctx.ws);
    log('[hello]', room.code, 'seat', idx, reconnected ? '(重连)' : '', s.name, s.char);
    return wel;
  }

  /* --- 房间列表（大厅搜索）---
     默认一次给 10 个；`off` 翻页（「点刷新找更多」靠它）。
     只暴露可加入所需信息，**绝不含密码**（只有 locked 标志）。 */
  if (act.a === 'list') {
    const lim = Math.max(1, Math.min(20, parseInt(act.lim, 10) || 10));
    const off = Math.max(0, parseInt(act.off, 10) || 0);
    const all = [...rooms.values()]
      .filter(r => r.state !== 'end')
      .sort((a, b) =>
        (b.seats.filter(Boolean).length - a.seats.filter(Boolean).length) ||   // 人多的排前面
        (b.created - a.created));                                             // 同人数新的排前面
    return {
      ok: true, total: all.length, off, lim,
      list: all.slice(off, off + lim).map(r => {
        const host = r.seats[r.hostSeat];
        return {
          code: r.code,
          host: (host && host.name) || '—',
          players: r.seats.filter(Boolean).length,
          max: r.rules.count,
          state: r.state,                 // lobby | play
          locked: !!r.passHash,
        };
      }),
    };
  }

  if (!act.room) return { ok: false, e: 'no_room' };
  const room = rooms.get(String(act.room).toUpperCase());
  if (!room) return { ok: false, e: 'room_not_found' };
  room.updated = now;
  const seat = (act.seat !== undefined && act.seat !== null) ? act.seat : seatIndex(room, act.token);
  const s = (seat >= 0) ? room.seats[seat] : null;

  /* --- 改角色 / 准备 --- */
  if (act.a === 'char') {
    if (!s || !sameToken(s, act)) return { ok: false, e: 'bad_seat' };
    if (room.state !== 'lobby') return { ok: true, ignored: true };   // 开局后改角色只会让各端名单不一致
    if (CHAR_POOL.indexOf(act.char) < 0) return { ok: false, e: 'bad_char' };
    s.char = act.char; s.lastSeen = now;
    broadcast(room, { a:'seats', room: roomPublic(room) });
    log('[char]', room.code, 'seat', seat, '->', act.char);
    return { ok: true };
  }
  if (act.a === 'ready') {
    if (!s || !sameToken(s, act)) return { ok: false, e: 'bad_seat' };
    // 准备时一并带上当前选的角色：玩家常见操作是「先加入 → 再换角色 → Ready」，
    // 只靠 hello 那一次上报会让开局用回旧角色。
    if (room.state === 'lobby' && act.char && CHAR_POOL.indexOf(act.char) >= 0) s.char = act.char;
    s.ready = !!act.v; s.lastSeen = now;
    broadcast(room, { a:'seats', room: roomPublic(room) });
    return { ok: true };
  }

  /* --- 房主开始对局 --- */
  if (act.a === 'start') {
    if (!s) return { ok: false, e: 'bad_seat' };
    if (seat !== room.hostSeat) return { ok: false, e: 'not_host' };
    if (room.state === 'play') return { ok: true, already: true };
    // 空位自动补 AI
    for (let i = 0; i < room.rules.count; i++) {
      if (!room.seats[i]) room.seats[i] = { seat: i, token: newToken(), name: '电脑' + (i + 1),
        char: act.chars && act.chars[i] ? act.chars[i] : null, ready: true, ai: true, bot: true,
        connected: false, lastSeen: now, joined: now };
      // 空位（AI）必须有确定的角色，否则各端名单不一致 → 会去同步
      if (!room.seats[i].char) room.seats[i].char = CHAR_POOL[i % CHAR_POOL.length];
    }
    room.rules = Object.assign(room.rules, act.rules || {});
    room.seed = (act.seed !== undefined && act.seed !== null) ? (act.seed >>> 0) : room.seed;
    room.gen = (room.gen | 0) + 1;                     // 新一局：代次 +1（客户端据此进场）
    room.state = 'play';
    /* 帧号从 0 重开 → 必须清 ack/inputs/hashes。原来这里只清了 frameHigh/desync/hashes，
       而 ack 会带着上一局的帧号留下来（同一页面「打完一局回菜单再建房」或大厅里 FRAME 已非 0
       都会踩到）：minAck 一被抬高，新一局 1..N 帧的输入就会被裁剪掉 → 卡死。 */
    resetMatchInput(room);
    for (const s of room.seats) if (s) { s.frameSeen = 0; s.frameT = now; s.recoverMs = 0; s.inT = now; }   // 开局重置判活基准
    room.startT = now;                                  // 开局宽限起点（见 START_GRACE_MS）
    broadcast(room, { a:'go', room: roomPublic(room), seed: room.seed,
                      startFrame: room.startFrame, rules: room.rules,
                      chars: room.seats.map(x => x && x.char) });
    log('[start]', room.code, 'seed', room.seed, 'chars', room.seats.map(x => x && x.char).join(','));
    return { ok: true, seed: room.seed, startFrame: 0, rules: room.rules };
  }

  /* --- 联机「再来一局」：必须房里所有人（真人座位）都点了才开下一局；
         有人没点 → 房间停在结算状态，其他人只能点 Back 退出（不再误进人机对局）。 --- */
  if (act.a === 'rematch') {
    if (!s) return { ok: false, e: 'bad_seat' };
    if (room.state !== 'end') return { ok: false, e: 'not_ended' };
    room.rematch.add(seat);
    const need = [];
    for (let i = 0; i < room.rules.count; i++) {
      const x = room.seats[i];
      /* 需要投票的 = 所有「真人座位」；电脑补位（bot）不投票也不阻塞。
         ⚠ 判据只能用 bot，**不能用 ai**：ai 是「临时被托管」的标记（走神/后台标签页会被标上），
         用 ai 判会把走神的真人排除掉 → 不等他就开局（实测踩到）。 */
      if (x && !x.bot) need.push(i);
    }
    const voted = need.filter(i => room.rematch.has(i)).length;
    if (voted < need.length) {
      broadcast(room, { a:'rematch', room: roomPublic(room), voted, need: need.length });
      return { ok: true, voted, need: need.length };
    }
    /* 全员同意 → 开下一局：新种子 + 清掉上一局的输入/哈希/结算，广播形状与房主 start 完全一致
       （客户端 onGo 直接复用，不用写第二条开局路径） */
    room.rematch.clear();
    room.seed = crypto.randomInt(0xffffffff) >>> 0;
    room.gen = (room.gen | 0) + 1;                     // 再来一局也是新一局：代次 +1
    room.state = 'play'; resetMatchInput(room); room.results = null;
    /* ⚠ 重开一局必须把「AI 托管」标记清掉：上一局的尾声/结算期间，没在喂输入的真人座位会被判活
       标成 ai=true（见 AI_TAKEOVER_MS）。若不清理，新一局里两边都被当 AI 托管 ——
       实测症状：一个人完全无法控制，另一个人看到「两个角色都被同一台设备控制」。
       这里「非电脑座位一律交还控制权」：重开的前提就是所有真人都投了票；
       真已离场的人会在新局里被判活（450ms）重新接管，自愈。 */
    for (const x of room.seats) if (x) {
      if (!x.bot) x.ai = false;
      x.ready = true; x.frameSeen = 0; x.frameT = now; x.recoverMs = 0; x.inT = now;
    }
    broadcast(room, { a:'go', room: roomPublic(room), seed: room.seed, startFrame: 0,
                      rules: room.rules, chars: room.seats.map(x => x && x.char) });
    log('[rematch]', room.code, 'seed', room.seed, 'players', need.length);
    return { ok: true, voted, need: need.length, started: true, seed: room.seed, startFrame: 0, rules: room.rules };
  }

  /* --- 客户端上报「某座位卡死了」--- */
  /* 客户端有本地自救接管（见 skill §15）：被堵住时它会在**同一帧**自己把消失的座位交给 AI，
     否则服务端给的生效帧（frameHigh+30）在「全场卡着等它输入」的状态下永远到不了 → 房间永久冻住。
     这里只做同步：把该座位也标成 ai（固定帧，沿用判活那套），免得服务端还认为对方在线、
     并在对方真的回来时按 500ms 连续供货交还控制权（自愈）。 */
  if (act.a === 'stall') {
    if (!s) return { ok: false, e: 'bad_seat' };
    const vs = room.seats[act.seat | 0];
    if (vs && !vs.bot && !vs.ai && room.state === 'play') {
      vs.ai = true; vs.recoverMs = 0; vs.aiFrom = eventFrame(room); vs.connected = false;
      room.updated = now;
      broadcast(room, { a:'ev', room: room.code, f: vs.aiFrom, seat: vs.seat, ai: true, why:'stall_report' });
      log('[ai] takeover (client-reported stall)', room.code, 'seat', vs.seat);
    }
    return { ok: true, ai: !!(vs && vs.ai), aiFrom: (vs && vs.aiFrom) | 0 };
  }

  /* --- 输入上行 + 状态下行（HTTP 透传走这一条）--- */
  if (act.a === 'sync' || act.a === 'input') {
    if (!s) return { ok: false, e: 'bad_seat' };
    const gap = now - (s.lastSeen || 0);
    const list = (act.a === 'input' ? [[act.f, act.b]] : (act.inbox || []))
      .filter(it => it && it.length >= 2);
    /* 客户端自报代次（可选字段，老客户端不发）：帧号每局从 0 重开，只靠「帧号看着合理」挡不住
       「上一局残留、且帧号恰好落在新一局范围内」的输入 —— 那条会被当成新一局的第 N 帧喂给全场
       （自己算的和别人算的不一样 → 去同步）。所以代次对不上时整条丢弃。 */
    const reqGen = (act.gen === undefined || act.gen === null) ? null : (act.gen | 0);
    const staleGen = reqGen !== null && reqGen !== (room.gen | 0);
    /* 控制权交还：必须是「连续在供货」（消息不断 **且** 真的带输入）。
       只判消息的话，一台「照常轮询但不产生输入」的客户端（后台标签页、卡住的渲染）
       会每 ~0.5s 在 human/AI 之间反复横跳 —— 每次横跳全场都要停一下（实测踩到）。
       上一局的迟到请求（staleGen）不算供货，否则会让「没在喂新一局输入」的座位收回控制权。 */
    if (s.ai && room.state === 'play') {
      if (gap < 300 && list.length && !staleGen) s.recoverMs = (s.recoverMs || 0) + gap;
      else s.recoverMs = 0;
      if (s.recoverMs >= AI_RECOVER_MS) {
        s.ai = false; s.recoverMs = 0;
        s.aiFrom = eventFrame(room);                  // 交还也用固定帧（同一次切换的两端必须一致）
        broadcast(room, { a:'ev', room: room.code, f: s.aiFrom, seat, ai: false, why:'input' });
        log('[ai] handback', room.code, 'seat', seat);
      }
    }
    s.lastSeen = now; s.connected = true;
    if (staleGen) list.length = 0;          // 上一局的输入一律不入库、不转发（也不刷新 inT）
    for (const item of list) {
      const f = item[0] | 0, b = item[1] | 0;
      storeInput(room, seat, f, b);
      if (room.state === 'play') broadcast(room, { a:'in', room: room.code, s: seat, f, b }, ctx.ws);
    }
    // 注意：帧号 0 是合法值，不能用 `||` 兜底（曾因此把帧 1~10 的输入裁掉，客户端卡死在帧 0）
    const cur = (act.f === undefined || act.f === null) ? (room.frameHigh | 0) : (act.f | 0);
    /* ⚠ 关键：帧号在「新一局」从 0 重开，而**上一局的在途请求是带着旧帧号到货的** ——
       「带回新代次的那次响应」必然是用旧帧号发出去的（客户端收到它才会把 FRAME 归零），
       所以重开一局后必定有一条 request 带 ack=旧帧号。若照旧记进 room.ack，ack 用 Math.max
       只增不减 → minAck 被钉死在旧帧号 → storeInput 的裁剪 (cut = minAck-60) 把新一局 1..N 帧的
       输入**全部删掉** → 两端 haveAll() 永远为假 → 闸门永不开 → 全场卡死在帧 0。
       判据与「存输入」保持一致：不超过 minAck+600 的帧号才可能是本局的；
       客户端自报代次（新客户端才有）不一致时直接判为上一局的残留。 */
    const plausible = !staleGen && cur <= minAck(room) + 600;
    if (plausible) {
      room.ack[seat] = Math.max(room.ack[seat] || 0, cur);      // 该座位执行进度
      /* 活着的判据 = 帧号在推进（不是「有没有消息」）：后台标签页的泵还在发消息但帧号不动 */
      if (cur > (s.frameSeen || 0)) { s.frameSeen = cur; s.frameT = now; }
    }
    const resp = { ok: true, f: cur, room: roomPublic(room), ack: minAck(room),
                   in: inputWindow(room, cur), in2: undefined };
    resp.win = room.frameHigh;         // 服务器已收到的最高帧（客户端用于对齐）
    if (room.desync) resp.desync = room.desync;
    return resp;
  }

  /* --- 帧哈希（去同步检测）--- */
  if (act.a === 'hash') {
    if (!s) return { ok: false };
    s.lastSeen = now;
    const f = act.f | 0, h = act.h >>> 0;
    let m = room.hashes.get(f);
    if (!m) { m = new Map(); room.hashes.set(f, m); }
    m.set(seat, h);
    if (f > room.startFrame + 8) {
      for (const k of room.hashes.keys()) if (k < f - 60) room.hashes.delete(k);
    }
    // 等所有非 AI 座位都报了同一帧，再比对
    const need = room.seats.filter(x => x && !x.ai && x.connected).length;
    let bad = false;
    for (const [frame, mm] of room.hashes) {
      if (mm.size >= Math.max(2, need)) {
        const vals = [...mm.values()];
        if (vals.some(v => v !== vals[0])) {
          bad = true;
          if (!room.desync) {
            room.desync = { f: frame, by: [...mm.entries()] };
            broadcast(room, { a:'desync', room: room.code, f: frame });
            log('[desync]', room.code, 'frame', frame, JSON.stringify(room.desync.by));
          }
        }
      }
    }
    return { ok: true, desync: bad ? room.desync : null };
  }

  /* --- 对局结束（房主上报结果）--- */
  if (act.a === 'over') {
    if (!s) return { ok: false };
    if (room.state !== 'end') { room.state = 'end'; saveResult(room, act.res || null); }
    broadcast(room, { a:'end', room: roomPublic(room), res: act.res || null });
    return { ok: true };
  }

  if (act.a === 'leave') {
    if (s && room.state === 'lobby') { room.seats[seat] = null; }
    else if (s) { s.ai = true; s.connected = false;
      broadcast(room, { a:'ev', room: room.code, f: (room.frameHigh | 0) + 12, seat, ai: true, why:'leave' }); }
    broadcast(room, { a:'seats', room: roomPublic(room) });
    return { ok: true };
  }
  if (act.a === 'ping') return { ok: true, t: now, f: room.frameHigh };
  if (act.a === 'state') return { ok: true, room: roomPublic(room), f: room.frameHigh, ack: minAck(room),
                                  in: inputWindow(room, (act.f === undefined || act.f === null) ? (room.frameHigh | 0) : (act.f | 0)) };
  return { ok: false, e: 'unknown_action' };
}
function sameToken(s, act) {
  if (!s) return false;
  if (!act.token) return true;           // 无 token 视为宽松（HTTP 回退）
  return s.token === act.token;
}

/* ================================================================ HTTP 服务 */
const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  const ok = (o, code = 200) => {
    const b = JSON.stringify(o);
    const put = () => {
      try {
        res.writeHead(code, { 'content-type': 'application/json; charset=utf-8',
                              'access-control-allow-origin': '*',
                              'access-control-allow-headers': 'content-type',
                              'access-control-allow-methods': 'POST, GET, OPTIONS',
                              'cache-control': 'no-store', 'content-length': Buffer.byteLength(b) });
        res.end(b);
      } catch (e) {}
    };
    if (LAG_MS > 0) setTimeout(put, LAG_MS); else put();
  };
  if (req.method === 'OPTIONS') return ok({ ok: true });
  if (url === '/health') return ok({ ok: true, rooms: rooms.size, up: process.uptime(),
                                     mem: Math.round(process.memoryUsage().rss / 1048576),
                                     results: countResults() });
  if (url === '/rooms') {
    return ok({ ok: true, rooms: [...rooms.values()].filter(r => r.state === 'lobby')
      .map(r => ({ code: r.code, rules: r.rules, players: r.seats.filter(Boolean).length })).slice(0, 40) });
  }
  if (url === '/results') {
    const n = Math.min(50, parseInt((req.url.split('count=')[1] || '20'), 10) || 20);
    return ok({ ok: true, list: readResults(n) });
  }
  if (url === '/api' && req.method === 'POST') {
    let body = '';
    req.on('data', c => { body += c; if (body.length > 1e6) req.destroy(); });
    req.on('end', () => {
      let act; try { act = JSON.parse(body || '{}'); } catch (e) { return ok({ ok: false, e: 'bad_json' }, 400); }
      let out;
      try { out = handle(act, { ws: null }); } catch (e) { log('[err] api', e.stack); out = { ok: false, e: 'internal' }; }
      ok(out);
    });
    return;
  }
  res.writeHead(404, { 'content-type': 'text/plain' }); res.end('not found');
});
function countResults() { try { return fs.readFileSync(RESULTS_FILE, 'utf8').split('\n').filter(Boolean).length; } catch (e) { return 0; } }
function readResults(n) {
  try {
    const lines = fs.readFileSync(RESULTS_FILE, 'utf8').split('\n').filter(Boolean);
    return lines.slice(-n).reverse().map(l => { try { return JSON.parse(l); } catch (e) { return null; } }).filter(Boolean);
  } catch (e) { return []; }
}

/* ================================================= 手写 WebSocket（RFC6455） */
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
function wsAccept(key) { return crypto.createHash('sha1').update(key + GUID).digest('base64'); }

function wsEncode(str) {
  const payload = Buffer.from(str, 'utf8');
  const len = payload.length;
  let head;
  if (len < 126) { head = Buffer.alloc(2); head[1] = len; }
  else if (len < 65536) { head = Buffer.alloc(4); head[1] = 126; head.writeUInt16BE(len, 2); }
  else { head = Buffer.alloc(10); head[1] = 127; head.writeBigUInt64BE(BigInt(len), 2); }
  head[0] = 0x81;                                  // FIN + text
  return Buffer.concat([head, payload]);
}
function wsDecode(buf) {                            // 单帧解析（客户端消息都很小）
  if (buf.length < 2) return null;
  const fin = (buf[0] & 0x80) !== 0, op = buf[0] & 0x0f;
  const masked = (buf[1] & 0x80) !== 0;
  let len = buf[1] & 0x7f, off = 2;
  if (len === 126) { if (buf.length < 4) return null; len = buf.readUInt16BE(2); off = 4; }
  else if (len === 127) { if (buf.length < 10) return null; len = Number(buf.readBigUInt64BE(2)); off = 10; }
  let mask = null;
  if (masked) { if (buf.length < off + 4) return null; mask = buf.slice(off, off + 4); off += 4; }
  if (buf.length < off + len) return null;
  let payload = buf.slice(off, off + len);
  if (masked) { payload = Buffer.from(payload); for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3]; }
  return { fin, op, payload, total: off + len };
}

server.on('upgrade', (req, socket) => {
  const key = req.headers['sec-websocket-key'];
  if (!key || (req.headers.upgrade || '').toLowerCase() !== 'websocket') { socket.destroy(); return; }
  socket.write('HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\nConnection: Upgrade\r\n' +
    'Sec-WebSocket-Accept: ' + wsAccept(key) + '\r\n\r\n');
  socket.setNoDelay(true);

  const ctx = { ws: null, room: null, seat: -1, isSpec: false };
  const ws = {
    readyState: 1, socket,
    send(str) { if (this.readyState !== 1) return; try { socket.write(wsEncode(str)); } catch (e) {} },
    close() { this.readyState = 3; try { socket.end(); } catch (e) {} },
  };
  ctx.ws = ws;
  let buf = Buffer.alloc(0);
  socket.on('data', chunk => {
    buf = Buffer.concat([buf, chunk]);
    for (;;) {
      const m = wsDecode(buf);
      if (!m) break;
      buf = buf.slice(m.total);
      if (m.op === 0x8) { cleanup(); ws.close(); return; }              // close
      if (m.op === 0x9) {                                              // ping → pong
        const p = Buffer.concat([Buffer.from([0x8a, m.payload.length]), m.payload]);
        try { socket.write(p); } catch (e) {}
        continue;
      }
      if (m.op !== 0x1) continue;
      let act; try { act = JSON.parse(m.payload.toString('utf8')); } catch (e) { continue; }
      let out;
      try { out = handle(act, ctx); } catch (e) { log('[err] ws', e.stack); out = { ok: false, e: 'internal' }; }
      if (out) ws.send(JSON.stringify(out));
    }
  });
  socket.on('error', cleanup);
  socket.on('close', cleanup);
  function cleanup() {
    ws.readyState = 3;
    if (ctx.room) {
      ctx.room.clients.delete(ws); ctx.room.specs.delete(ws);
      if (ctx.seat >= 0 && ctx.room.seats[ctx.seat]) {
        const s = ctx.room.seats[ctx.seat];
        if (s.connected) { s.connected = false; log('[ws] disconnect', ctx.room.code, 'seat', ctx.seat); }
      }
      ctx.room.updated = Date.now();
    }
  }
});

server.listen(PORT, HOST, () => log(`[daemon] listening http+ws on ${HOST}:${PORT} data=${DATA_DIR}`));
process.on('uncaughtException', e => log('[fatal]', e.stack || String(e)));
