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
const CHAR_POOL = ['sparky','rocky','zephyr','cobalt','mage','warrior','archer','knight', 'pumpkin', 'smiley', 'turtle', 'titan', 'teacher', 'baby', 'dragon', 'shadow', 'slayer', 'reaper', 'gorilla', 'hacker', 'blocky', 'blub', 'tamer', 'mechanic', 'quicksand', 'fang', 'angel', 'demon', 'shark', 'french', 'sovereign', 'mosquito'];

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
    createdBy: String((opts && opts.pid) || ''),   // ★ 第 90 轮：房主账号（决定空房是否保留）
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
               connected: !!s.connected, bot: !!s.bot, aiFrom: s.aiFrom | 0,
               idle: !!s.idle, left: !!s.left, gone: !!s.gone } : null;
}
function roomPublic(room) {
  const seats = [];
  for (let i = 0; i < room.rules.count; i++) seats.push(seatPublic(room.seats[i]));
  return { code: room.code, state: room.state, hostSeat: room.hostSeat, rules: room.rules,
           gen: room.gen | 0,                     // 代次：客户端用它分辨「新一局」（见 createRoom 注释）
           locked: !!room.passHash,               // 大厅里给房主/加入者看「这是私密房」（不含密码本身）
           evFrame: (room.frameHigh | 0) + 12,   // 事件统一生效帧（留足余量，保证各端同帧应用）
           seats, seed: room.seed, startFrame: room.startFrame,
           spectators: room.specs.size, desync: room.desync, redirect: room.redirect || '',
           /* ★ 第 83 轮：房间是否正在匹配中（后加入的玩家靠这个显示人数/计时） */
           queued: room.queued ? { mode: room.queued.mode, at: room.queued.at,
                                   await: !!room.queued.await } : null };
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
    /* ★ 第 101 轮：掉线/退出的真人座位 = **站着不动**（喂全 0 = 一个键都不按），
       不再挂 AI。这样其他玩家的帧照常推进，那个角色只是原地发呆。 */
    if (s.idle || s.left) {
      const obj = {};
      let n = 0;
      for (let f = from; f <= to && n < 200; f++) { obj[f] = 0; n++; }
      if (n) out[s.seat] = obj;
      continue;
    }
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
    if (!s || s.ai || s.idle || s.left) continue;      // ★ 第 101 轮：idle/left 的座位不参与「最慢进度」统计
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
  room.badFrames = null;      // ★ 2026-10-23：新一局重新数「有几个帧对不上」
}
function storeInput(room, seat, frame, bits) {
  if (frame > minAck(room) + 600) return;          // 跑太前的输入丢弃（正常客户端不会发生）
  const so = room.seats[seat];
  if (so) {
    /* ★ 第 59 轮回退：判活口径必须是「收到任何输入就算活着」（含 stallGuard 的**心跳重发**）。
       上一轮改成「只算新帧」把心跳废掉了：房间被别人卡住时，健康玩家的帧号也不推进、
       也没有新帧 → 900ms 后被判 AI → 用户看到「对局中突然有人说他退出了，然后各端位置都不一样」。
       inTop 只留作诊断/防抖，不参与判活。真正的卡死由同伴上报 a:'stall' 解（见 stall 处理）。 */
    if (frame > (so.inTop | 0)) so.inTop = frame | 0;
    so.inT = Date.now();
  }
  let m = room.inputs.get(seat);
  if (!m) { m = new Map(); room.inputs.set(seat, m); }
  m.set(frame, bits);
  /* ★ 第 102 轮：另外留一份**永不裁剪**的完整输入史，用于「掉线回来快进重放」。
     有了它就不需要状态快照：同 seed 从第 0 帧按同样的输入重跑，结果必然一致（已实测确定性）。 */
  if (!room.hist) room.hist = new Map();
  let hm = room.hist.get(seat);
  if (!hm) { hm = new Map(); room.hist.set(seat, hm); }
  if (hm.size < 40000) hm.set(frame, bits);
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
/* ★ 第 62 轮：全员下线的房间自动删除（原来只能等 20 分钟 ROOM_IDLE_MS，房间里留一堆空房，
   而且空房还会出现在「Search Rooms」列表里，别人点进去才发现没人）。 */
const EMPTY_LOBBY_MS = 4000;      // 大厅里一个活人都没有 → 4s 后删房（留一点重连窗口）
const EMPTY_PLAY_MS = 25000;      // 对局中全员掉线 → 给 25s 重连（token 还在就还能回来）
/* ★ 第 62b 轮：ws 客户端在**大厅里不发任何消息**（客户端 tick 的 ping 只在比赛中发），
   所以 lastSeen 会一直变旧 —— 只按 lastSeen 判「下线」会把正在大厅里等人的房主判死，
   4 秒后房间被删 → 别人加入时 room_not_found（用户报的「现在无法加入房间」）。
   判活必须把「这个座位有一条活着的 ws 连接」也算在内。 */
function seatHasSocket(room, seatNo) {
  for (const ws of room.clients) if (ws && ws.__seat === seatNo && ws.readyState === 1) return true;
  return false;
}
function humansIn(room) {
  let n = 0;
  for (const s of room.seats) if (s && !s.bot && (s.connected || seatHasSocket(room, s.seat))) n++;
  return n;
}
function reapRoom(room, why) {
  log('[room] reap', room.code, '(' + why + ')');
  for (const ws of room.clients) try { ws.close(); } catch (e) {}
  for (const ws of room.specs) try { ws.close(); } catch (e) {}
  rooms.delete(room.code);
}
/* ★ 第 63 轮：用同一个 seed 从第 0 帧重开这一局（全员重新对齐）。
   用途：某人离线、AI 替他打了一段之后又回来 —— 这段历史各端本来就不同（AI 输入 vs 他的输入），
   而引擎没有回滚/快照，**继续打一定是四台显示不一样**。唯一能保证一致的解法就是整局重开。 */
function restartRoom(room, why) {
  const now = Date.now();
  room.gen = (room.gen | 0) + 1;
  room.state = 'play';
  resetMatchInput(room);
    if (room) room.hist = new Map();                  // ★ 第 102 轮：新一局 → 清空重放用的输入史
  for (const s of room.seats) if (s) {
    if (!s.bot) { s.ai = false; s.connected = true; }
    s.frameSeen = 0; s.frameT = now; s.recoverMs = 0; s.inT = now; s.inTop = 0;
  }
  if (room.rematch) room.rematch.clear();
  room.startT = now; room.updated = now;
  broadcast(room, { a:'go', room: roomPublic(room), seed: room.seed, startFrame: 0,
                    rules: room.rules, chars: room.seats.map(x => x && x.char),
                    avatars: room.seats.map(x => (x && x.avatar) || ''),   // ★ 第 67 轮：开局阵容用
                    resync: why });
  log('[match] restart', room.code, '(' + why + ')', 'gen', room.gen, 'seed', room.seed);
}

/* ================= ★ 第 72 轮：账号 / 好友 / 组队匹配 ================= */
/* ⚠ 账号库必须放在 **站点根目录之外**（docroot = /volume1/schoolexam_web/v1/）。
   第一版放在 sbgames/ 里，结果 https://…/sbgames/accounts.json 直接 200 明文可读（好友关系+账号 id 全泄露）。 */
const ACC_FILE = process.env.SB_ACC_FILE || '/volume1/schoolexam_web/sbgames_data/accounts.json';
/* 起服时清掉历史遗留：旧版本把账号库写在 sbgames/（在站点根内，可被 https 明文下载） */
try { fs.unlinkSync(path.join(__dirname, 'accounts.json')); } catch (e) {}
let ACCTS = {};
try { ACCTS = JSON.parse(fs.readFileSync(ACC_FILE, 'utf8')) || {}; } catch (e) { ACCTS = {}; }
let accSaveT = 0;
function accSave(force) {
  const now = Date.now();
  if (!force && now - accSaveT < 1500) return;
  accSaveT = now;
  try { fs.writeFileSync(ACC_FILE + '.tmp', JSON.stringify(ACCTS)); fs.renameSync(ACC_FILE + '.tmp', ACC_FILE); } catch (e) {}
}
function accOf(id) {
  const k = String(id || '').slice(0, 48); if (!k) return null;
  if (!ACCTS[k]) ACCTS[k] = { nick: '', friends: [], inv: [], last: 0 };
  if (!ACCTS[k].friends) ACCTS[k].friends = [];
  if (!ACCTS[k].inv) ACCTS[k].inv = [];
  if (typeof ACCTS[k].trophies !== 'number') ACCTS[k].trophies = 0;      // ★ 第 86 轮：奖杯
  if (!Array.isArray(ACCTS[k].trophyTok)) ACCTS[k].trophyTok = [];
  /* ★ 第 94 轮：服务端存档字段（金币 / 解锁角色 / 奖励领取 / 每日任务 / 邮箱登录） */
  if (typeof ACCTS[k].coins !== 'number') ACCTS[k].coins = 0;
  if (!Array.isArray(ACCTS[k].owned)) ACCTS[k].owned = [];
  if (!Array.isArray(ACCTS[k].claimed)) ACCTS[k].claimed = [];
  if (!Array.isArray(ACCTS[k].dailyClaimed)) ACCTS[k].dailyClaimed = [];
  if (typeof ACCTS[k].dailyDay !== 'string') ACCTS[k].dailyDay = '';
  if (!ACCTS[k].dailyProg || typeof ACCTS[k].dailyProg !== 'object') ACCTS[k].dailyProg = {};
  if (typeof ACCTS[k].char !== 'string') ACCTS[k].char = '';
  if (typeof ACCTS[k].email !== 'string') ACCTS[k].email = '';
  if (typeof ACCTS[k].emailVerified !== 'boolean') ACCTS[k].emailVerified = false;
  if (typeof ACCTS[k].welcome !== 'boolean') ACCTS[k].welcome = false;
  /* ★ 2026-10-23：跨设备同步新增字段（宝石 / 抽卡 / 皮肤武器 / 宝石任务 / 活动领取 / 同步版本号） */
  if (typeof ACCTS[k].gems !== 'number') ACCTS[k].gems = 0;
  if (typeof ACCTS[k].pity !== 'number') ACCTS[k].pity = 0;
  if (!Array.isArray(ACCTS[k].supreme)) ACCTS[k].supreme = [];
  if (!Array.isArray(ACCTS[k].weapons)) ACCTS[k].weapons = [];
  if (!Array.isArray(ACCTS[k].skins)) ACCTS[k].skins = [];
  if (!ACCTS[k].equipSkins || typeof ACCTS[k].equipSkins !== 'object') ACCTS[k].equipSkins = {};
  if (!ACCTS[k].equipWeapon || typeof ACCTS[k].equipWeapon !== 'object') ACCTS[k].equipWeapon = {};
  if (!ACCTS[k].gemQ || typeof ACCTS[k].gemQ !== 'object')
    ACCTS[k].gemQ = { day: '', dayGems: 0, total: 0, prog: {}, dayClaimed: {} };
  if (!ACCTS[k].gemOnce || typeof ACCTS[k].gemOnce !== 'object') ACCTS[k].gemOnce = {};
  if (!ACCTS[k].eventClaims || typeof ACCTS[k].eventClaims !== 'object') ACCTS[k].eventClaims = {};
  if (typeof ACCTS[k].rev !== 'number') ACCTS[k].rev = 0;
  return ACCTS[k];
}
const ONLINE = new Map();          // pid -> { ws, nick, code, at }
const QUEUE = new Map();           // code -> { code, rules, pid, at }
/* ★ 第 85 轮：补位的电脑伪装成真人 —— 用真人风格昵称，且同房同座位名字固定（各端一致、重开也一样） */
const BOT_NAMES = ['Alex', 'Kai', 'Nova', 'Mika', 'Rex', 'Luna', 'Zed', 'Ivy', 'Milo', 'Sage', 'Rin', 'Otto'];
function botName(room, seat) {
  const used = new Set(room.seats.filter(x => x && x.name).map(x => x.name));
  let h = 0; const s = String(room.code) + ':' + seat;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) & 0x7fffffff;
  for (let k = 0; k < BOT_NAMES.length; k++) {
    const n = BOT_NAMES[(h + k) % BOT_NAMES.length];
    if (!used.has(n)) return n;
  }
  return BOT_NAMES[h % BOT_NAMES.length];
}
function rulesKey(r) { r = r || {}; return [r.count|0, r.stocks|0, r.time|0, r.diff|0, r.teams|0, String(r.mode || ''),
  (typeof r.stage === 'number' ? r.stage : -1)].join('/'); }   // ★ 第 77 轮：地图不同 → 视为不同设置（匹配会问）
function pushTo(pid, msg) {
  const o = ONLINE.get(String(pid || ''));
  if (o && o.ws && o.ws.readyState === 1) { try { o.ws.send(JSON.stringify(msg)); return true; } catch (e) {} }
  return false;
}
/* ★ 第 74 轮：在线判定改成「心跳 + TTL」。
   以前 ONLINE 只在 hello（建房/加入）时写入 → 光在大厅打开好友面板的人永远不在线，
   于是所有人互相显示 offline；关掉标签页的记录又永远不消失。现在客户端开机就心跳，45s 无声即离线。 */
const PRESENCE_MS = 45000;
function isOn(id) { const o = ONLINE.get(String(id || '')); return !!o && (Date.now() - (o.at || 0) < PRESENCE_MS); }
function friendListOf(pid) {
  const a = accOf(pid); if (!a) return [];
  return a.friends.map(id => {
    const b = ACCTS[id] || {}, o = isOn(id) ? ONLINE.get(id) : null;
    return { id, nick: (o && o.nick) || b.nick || 'Player', online: !!o, code: o ? (o.code || '') : '' };
  });
}
function reqListOf(pid) {
  const a = accOf(pid); if (!a) return [];
  return (a.req || []).map(r => ({ id: r.id, nick: (ACCTS[r.id] || {}).nick || r.nick || 'Player', at: r.at || 0 }));
}
function outReqOf(pid) {
  const out = [];
  for (const k of Object.keys(ACCTS)) {
    const a2 = ACCTS[k];
    if (a2 && a2.req && a2.req.some(r => r.id === String(pid))) out.push({ id: k, nick: a2.nick || 'Player' });
  }
  return out;
}
function acceptFriend(pid, tid) {
  const me = accOf(pid); if (!me) return { ok: false, e: 'no_id' };
  const other = accOf(tid); if (!other) return { ok: false, e: 'no_account' };
  me.req = (me.req || []).filter(r => r.id !== tid);
  if (me.friends.indexOf(tid) < 0) me.friends.push(tid);
  const pk = String(pid);
  if (other.friends.indexOf(pk) < 0) other.friends.push(pk);
  accSave(true);
  pushTo(tid, { a: 'freq', ok: true, from: { id: pk, nick: me.nick } });
  return { ok: true, accepted: true, id: tid, list: friendListOf(pid), req: reqListOf(pid) };
}
function tick() {
  const now = Date.now();
  for (const room of rooms.values()) {
    if (room.state === 'play') {
      for (const s of room.seats) {
        if (!s || s.bot) continue;
        const noMsg = now - (s.lastSeen || 0);
        /* inT = 最后一条「被存进房间」的输入的时间（含心跳重发）；frameT = 自报帧号最后推进的时间 */
        const noFeed = now - (s.inT || now);
        const noProg = now - (s.frameT || now);
        const inGrace = (now - (room.startT || 0)) < START_GRACE_MS;    // 开局宽限内一律不判离线
        /* ★ 第 59 轮：自动判 AI 必须**保守**，只认「真的失联」：
           - noMsg > 2000：完全没消息（轮询/ws 都没了）→ 真掉线
           - noFeed>3000 且 noProg>3000：一直在轮询、既没新输入帧号也不推进 → 真卡死
           只要消息还在来（哪怕只是心跳），就不自动判 AI —— 否则「房间被别人卡住」的健康玩家
           会被误判成掉线（用户报的「对局中突然显示某人退出、随后各端位置不一致」）。
           卡住但活着的座位由同伴上报 a:'stall' 解决，服务端用「上报者卡住的那一帧」广播，
           各端在同一帧切 AI，Bot 随机数流不会错开。 */
        /* ★ 第 99 轮：阈值大幅放宽（2s → 12s）。锁步里「短卡顿」应该表现为**全场等一下**，
           而不是把这个座位挂 AI；挂 AI 会让各端接管帧号不同 → 回连时 hash/gap 判定失败 → 整局重开。
           12 秒才判死，只用于「人真的走了/关页面」的兜底。 */
        /* ★ 第 100 轮：判死还要加一条「别人**此刻**确实在推进」——
           必须有一个真人座位最近 3 秒内还在送帧、并且帧号已经领先这个人 >20 帧，
           才说明是他拖住了全场。全场都停着（结算/暂停/大家一起卡）时谁都不判离线
           （用户报的「没人掉线却显示有人掉线」就是这一类）。 */
        let otherAdvancingNow = false;
        for (const x of room.seats) {
          if (!x || x === s || x.bot) continue;
          const fresh = (now - (x.inT || 0)) < 3000;
          if (fresh && ((x.inTop | 0) - (s.inTop | 0)) > 20) { otherAdvancingNow = true; break; }
        }
        /* ★ 第 107 轮：按用户要求「3 秒不回复就踢出」——
           3 秒无消息（或 3 秒既没新输入也没推进）且别人确实在推进 → 标记 idle/gone，
           客户端会把这个角色从场上移除，剩下的人继续打。 */
        const dead = otherAdvancingNow && (noMsg > 3000 || (noFeed > 3000 && noProg > 3000));
        if (!s.idle && !s.left && !inGrace && dead) {
          /* ★ 第 101 轮：不做 AI 接管 —— 标记 idle，之后这个座位一律喂「全 0」输入，
             角色就站在那儿不动，其他人完全不受影响（不再等、不再重开）。 */
          s.idle = true; s.gone = true; s.connected = false;   // 3 秒不回 → 踢出场（gone 让快照也能直接隐藏）
          room.updated = now;
          broadcast(room, { a:'ev', room: room.code, f: (room.frameHigh | 0) + 1, seat: s.seat, idle: true, why:'timeout' });
          log('[idle] seat stands still', room.code, 'seat', s.seat,
              'noMsg=' + Math.round(noMsg) + 'ms myTop=' + (s.inTop | 0));
        }
      }
    }
    /* ★ 第 62 轮：大厅里「关掉标签页但没 leave」的座位也要判离线（客户端大厅轮询 450ms 一次，
       8s 没有任何消息基本就是走了），否则空房要等 20 分钟空闲回收。 */
    if (room.state === 'lobby') {
      for (const s of room.seats) if (s && !s.bot && s.connected && !seatHasSocket(room, s.seat) && now - (s.lastSeen || 0) > 12000) {
        s.connected = false;
        broadcast(room, { a:'seats', room: roomPublic(room) });
      }
    }
    /* ★ 第 62 轮：全员下线 → 自动删房。判据是「有没有 connected 的真人座位」：
       AI 座位 / 被接管的座位都不算（接管时 connected 已经被置 false）。 */
    if (humansIn(room) === 0) {
      if (!room.emptySince) room.emptySince = now;
      const lim = room.state === 'play' ? EMPTY_PLAY_MS : EMPTY_LOBBY_MS;
      if (now - room.emptySince >= lim) { reapRoom(room, 'all off ' + Math.round((now - room.emptySince) / 1000) + 's'); continue; }
    } else room.emptySince = 0;
    if (room.keepUntil && now < room.keepUntil) continue;      // ★ 第 90 轮：自己创建的空房保留窗口内不回收
    /* ★ 第 90 轮：大厅里清掉「已退出」的残留座位（对局中退出的会先标 left，回到大厅就该彻底消失） */
    if (room.state === 'lobby') {
      for (let i = 0; i < room.seats.length; i++) {
        const x = room.seats[i];
        if (x && x.left) { room.seats[i] = null; if (room.ack) delete room.ack[i]; if (room.inputs) room.inputs.delete(i); }
      }
    }
    if (now - room.updated > ROOM_IDLE_MS) {
      reapRoom(room, 'idle ' + Math.round((now - room.updated) / 60000) + 'min');
      continue;
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
      room.createdBy = String(act.pid || '');        // ★ 第 90 轮：记住房主账号（空房保留判定用）
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

    /* ★ 2026-10-19（第 61 轮）：同一个 token 不允许同时坐在两个房间里。
       客户端多开/连点/「加入自己的房间」时会出现：新房间拿到座位，旧房间那个座位还在但客户端
       再也不给它发 leave / 供帧 → 旧房间留一个「在线但永远不供帧」的幽灵座位 → 全员锁步卡死。
       这里做服务端兜底：把同 token 在**别的房间**里的座位就地交给 AI 并广播。 */
    if (act.token) {
      for (const r2 of rooms.values()) {
        if (r2 === room) continue;
        for (const s2 of r2.seats) {
          if (!s2 || s2.token !== act.token) continue;
          s2.ai = true; s2.connected = false; s2.recoverMs = 0; s2.aiFrom = eventFrame(r2);
          broadcast(r2, { a:'ev', room: r2.code, f: s2.aiFrom, seat: s2.seat, ai: true, why:'left' });
          log('[seat] token moved to another room', r2.code, 'seat', s2.seat);
        }
      }
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
      name: String(act.name || (prev && prev.name) || ('Player' + (idx + 1))).slice(0, 12),
      /* 只有大厅能改角色：对局中重连必须沿用原角色，否则各端FIGHTERS不一致 → 锁同步desync */
      char: (room.state === 'lobby' && act.char) ? act.char : ((prev && prev.char) || 'sparky'),
      ready: reconnected ? (prev && prev.ready) : false,
      ai: false, bot: !!act.bot, connected: true, lastSeen: now,
      frameSeen: 0, frameT: now, recoverMs: 0, inTop: 0,          // 帧号推进判活用（见 AI_TAKEOVER_MS 注释）
      joined: (prev && prev.joined) || now,
      pid: String(act.pid || (prev && prev.pid) || '').slice(0, 48),   // ★ 第 72 轮：账号 id（好友在线状态/邀请用）
      avatar: String(act.avatar || (prev && prev.avatar) || '').slice(0, 60000),   // ★ 第 67 轮：头像 data URL（96×96 JPEG，约 4~8KB）
    };
    room.seats[idx] = s;
    room.emptySince = 0;          // ★ 第 62 轮：有人进来了 → 取消「全员下线」倒计时
    room.queued = null;           // ★ 有人进来了（多半是匹配对方） → 「等待对手加入」状态结束
    if (s.pid) { const o = ONLINE.get(s.pid) || {}; o.code = room.code; o.nick = s.name; if (ctx.ws) o.ws = ctx.ws; ONLINE.set(s.pid, o); }   // ★ 第 72 轮
    let catchUp = false;                              // ★ 第 102 轮：掉线回来要走「快进重放」
    if (reconnected) {                                // 断线回来了（token 命中座位）
      const wasAi = !!s.ai;
      const wasIdle = !!s.idle;
      const gapFrames = (room.frameHigh | 0) - (room.ack[idx] | 0);
      s.ai = false; s.idle = false; s.connected = true; s.lastSeen = now; s.inTop = room.frameHigh | 0;
      /* ★ 第 102 轮：掉线期间房间一直在跑 → **不再重开整局**，
         改成把这个座位的输入史发给它，让它自己从第 0 帧快进到当前帧（同 seed 重放，结果必然一致）。 */
      if (room.state === 'play' && (wasIdle || wasAi || gapFrames > 30)) {
        catchUp = true;
        log('[catchup] ask client to replay', room.code, 'seat', idx, 'wasIdle', wasIdle, 'gap', gapFrames);
      } else if (room.state === 'play') {
        broadcast(room, { a:'ev', room: room.code, f: (room.frameHigh | 0) + 12, seat: idx, ai: false, why:'reconnect' });
        log('[ai] reclaim', room.code, 'seat', idx);
      }
    }
    ctx.room = room; ctx.seat = idx;
    if (ctx.ws) { room.clients.add(ctx.ws); ctx.ws.__seat = idx; ctx.ws.__code = room.code; }   // 第 62b 轮：给 socket 打座位标记（判活/删房要用）

    const wel = { ok: true, room: roomPublic(room), seat: idx, token: s.token,
                  seed: room.seed, startFrame: room.startFrame, start: room.state === 'play',
                  reconnected, f: room.frameHigh, catchUp: !!catchUp };
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

  /* ★ 第 72 轮：账号/好友/邀请/匹配自带 code，不依赖 act.room —— 必须在下面的 no_room 检查**之前**分流 */
  if (act.a === 'acct' || act.a === 'friends' || act.a === 'fadd' || act.a === 'fdel' ||
      act.a === 'invite' || act.a === 'queue' || act.a === 'facc' || act.a === 'fdec' ||
      act.a === 'trophy' || act.a === 'bind' || act.a === 'verify' || act.a === 'login' || act.a === 'profile') return social(act, ctx, now);
  if (!act.room) return { ok: false, e: 'no_room' };
  const room = rooms.get(String(act.room).toUpperCase());
  if (!room) return { ok: false, e: 'room_not_found' };
  room.updated = now;
  /* ★ redirect 只该活 8 秒：配对后对方没接住（满房/已开局/断线）时，旧 redirect 会让客户端
     每拿到一次快照就重复跳房，而每次跳房都会先把自己原来的房间 leave 掉 → 越跳越没房。 */
  if (room.redirect && room.redirectAt && (now - room.redirectAt) > 8000) { room.redirect = ''; room.redirectAt = 0; }
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
    /* ★ 第 90 轮：对局结束回到大厅时，把「已经离开」的座位真正清掉 */
    for (let i = 0; i < room.seats.length; i++) {
      const x = room.seats[i];
      if (x && x.left) { room.seats[i] = null; if (room.ack) delete room.ack[i]; if (room.inputs) room.inputs.delete(i); }
    }
    if (!room.seats[room.hostSeat]) { const nx = room.seats.findIndex(x => x && !x.bot); room.hostSeat = nx >= 0 ? nx : 0; }
    /* ★ 第 85 轮：对局一开始就退出匹配队列（避免「30 秒自动开局」之后还残留 queued 状态） */
    QUEUE.delete(room.code); room.queued = null;
    // 空位自动补 AI
    for (let i = 0; i < room.rules.count; i++) {
      if (!room.seats[i]) room.seats[i] = { seat: i, token: newToken(), name: botName(room, i),
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
    if (room) room.hist = new Map();                  // ★ 第 102 轮：新一局 → 清空重放用的输入史
    /* ★ 2026-10-19（第 60 轮，本轮的根因）：开新局必须把**真人座位的 AI 标记清掉**。
       上一局结束/结算阶段客户端不再供帧（tick 走 lobby 分支），判活会把座位标成 ai=true；
       全员点「Back to Select」后房主再点开始 → 旧代码只重置了判活基准，**没重置 ai 标记**
       → 'go' 里 humanSeats 全是 false → 各端把四个座位全建成 Bot（netSeat=-1）
       → 没人供输入 → 全场卡死，而且各自 Bot 构造帧不同 → 位置也不一致。
       rematch 分支一直有这句，start 分支漏了。 */
    for (const s of room.seats) if (s) {
      if (!s.bot) { s.ai = false; s.connected = true; }
      s.frameSeen = 0; s.frameT = now; s.recoverMs = 0; s.inT = now; s.inTop = 0;
    }
    room.rematch.clear();
    room.startT = now;                                  // 开局宽限起点（见 START_GRACE_MS）
    broadcast(room, { a:'go', room: roomPublic(room), seed: room.seed,
                      startFrame: room.startFrame, rules: room.rules,
                      avatars: room.seats.map(x => (x && x.avatar) || ''),   // ★ 第 67 轮
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
    room.state = 'play'; resetMatchInput(room);
    if (room) room.hist = new Map();                   // ★ 第 102 轮：新一局 → 清空重放用的输入史
    room.results = null;
    /* ⚠ 重开一局必须把「AI 托管」标记清掉：上一局的尾声/结算期间，没在喂输入的真人座位会被判活
       标成 ai=true（见 AI_TAKEOVER_MS）。若不清理，新一局里两边都被当 AI 托管 ——
       实测症状：一个人完全无法控制，另一个人看到「两个角色都被同一台设备控制」。
       这里「非电脑座位一律交还控制权」：重开的前提就是所有真人都投了票；
       真已离场的人会在新局里被判活（450ms）重新接管，自愈。 */
    for (const x of room.seats) if (x) {
      if (!x.bot) x.ai = false;
      x.ready = true; x.frameSeen = 0; x.frameT = now; x.recoverMs = 0; x.inT = now; x.inTop = 0;
    }
    broadcast(room, { a:'go', room: roomPublic(room), seed: room.seed, startFrame: 0,
                      rules: room.rules, chars: room.seats.map(x => x && x.char),
                      avatars: room.seats.map(x => (x && x.avatar) || '') });
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
    if (vs && !vs.bot && room.state === 'play') {
      /* ★ 2026-10-19（第 58 轮）：生效帧必须用「上报者卡住的那一帧 act.f」，不能用 eventFrame()。
         房间是被这个缺席座位卡死的 → 所有端都停在同一个帧 F；eventFrame() = 最高帧 + 余量 = F+30，
         对卡住的端**永远到不了**（它们缺的就是 F+1 的输入）→ 各端只能各自按本地帧抢管，
         切换帧不同 → Bot 构造时抽随机数的位置不同 → 全场位置永久不一致（用户报的 bug）。 */
      const rf = act.f | 0;
      const ef = eventFrame(room);
      const nf = (rf > 0 && rf <= ef) ? rf : ef;
      /* 已经被自动判过 AI、但那个生效帧够不到 → 用上报者的实际卡住帧**重新广播**，
         把切换点拉回到所有人都能到达的帧。没有这一步，自动判 AI 之后房间会冻在那一帧，
         各端只能各自本地抢管 → 位置再次不一致。 */
      if (!vs.ai || nf < (vs.aiFrom || 0)) {
        vs.ai = true; vs.recoverMs = 0; vs.connected = false; vs.aiFrom = nf;
        room.updated = now;
        broadcast(room, { a:'ev', room: room.code, f: vs.aiFrom, seat: vs.seat, ai: true, why:'stall_report' });
        log('[ai] takeover (client-reported stall)', room.code, 'seat', vs.seat, 'frame', vs.aiFrom, '(eventFrame ' + ef + ')');
      }
    }
    return { ok: true, ai: !!(vs && vs.ai), aiFrom: (vs && vs.aiFrom) | 0 };
  }

  /* --- 客户端发现「自己已经和别人算岔了」→ 请求整局 resync（同 seed 从 0 重开）--- */
  if (act.a === 'resync') {
    if (!s) return { ok: false, e: 'bad_seat' };
    if (room.state !== 'play') return { ok: false, e: 'not_playing' };
    if (room.lastResync && (now - room.lastResync) < 4000) return { ok: true, throttled: true, gen: room.gen };
    room.lastResync = now;
    restartRoom(room, 'client-resync');
    return { ok: true, restarted: true, gen: room.gen };
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

  /* --- ★ 第 102 轮：把整局输入史发给掉线回来的客户端，让它自己从第 0 帧快进 --- */
  if (act.a === 'history') {
    if (!room) return { ok: false, e: 'no_room' };
    if (room.state !== 'play') return { ok: false, e: 'not_playing' };
    const hist = {};
    if (room.hist) for (const [seat, m] of room.hist) {
      const obj = {};
      for (const [f, b] of m) if (f <= (room.frameHigh | 0)) obj[f] = b;
      hist[seat] = obj;
    }
    return { ok: true, gen: room.gen, seed: room.seed, count: room.rules.count, stocks: room.rules.stocks,
             time: room.rules.time, diff: room.rules.diff, teams: room.rules.teams, mode: room.rules.mode || '',
             chars: room.seats.map(x => (x ? x.char : '')), upto: room.frameHigh | 0, hist };
  }

  /* --- 帧哈希（去同步检测）--- */
  if (act.a === 'hash') {
    if (!s) return { ok: false };
    s.lastSeen = now;
    /* ★ 2026-10-23：只认「本局代次」的哈希。
       重开一局后帧号从 0 重新数，而且指纹都落在 30 的倍数上 —— 上一局的在途 hash 会正好撞进
       新一局的帧号段，被当成本局的分歧 → 刚重开就再判一次去同步 → 连环重开（实测 3 分钟重开 5 次）。
       客户端现在带 gen；没带的老客户端按原样放行（兼容）。 */
    const hg = (act.gen === undefined || act.gen === null) ? null : (act.gen | 0);
    if (hg !== null && hg !== (room.gen | 0)) return { ok: true, stale: true, gen: room.gen };
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
          /* ★ 2026-10-23：单帧分歧不当场重开 —— 太容易是「刚重开、某台还在跑旧局」或一次抖动，
             一次误判就把整局的进度抹掉（用户报的「比赛时不时重开」）。
             至少要 **2 个不同帧** 都对不上，才认定两端真的算岔了。 */
          if (!room.badFrames) room.badFrames = new Set();
          room.badFrames.add(frame);
          if (!room.desync) {
            room.desync = { f: frame, by: [...mm.entries()] };
            broadcast(room, { a:'desync', room: room.code, f: frame });
            log('[desync]', room.code, 'frame', frame, JSON.stringify(room.desync.by));
          }
        }
      }
    }
    /* ★ 第 65 轮 + 2026-10-23：哈希对不上 = 各家画面已经不同（重连 / AI 接管之后最常见）。
       引擎没有回滚 → 靠 ev 修补不了，唯一解是同 seed 从第 0 帧重开。
       ⚠ 但重开判据必须是「**至少 2 个不同帧**都对不上」（room.badFrames 在循环里累计）：
       单帧分歧太容易是「刚重开、某台还在跑旧局」的迟到包或一次 GC 抖动 ——
       一次误判就把整局进度抹掉，正是用户报的「比赛时不时重开」。
       这段放在 if (!room.desync) 之外，否则第一帧分歧时 size 只有 1、第二帧分歧又进不来，
       永远重开不了。 */
    if (room.badFrames && room.badFrames.size >= 2 && room.state === 'play' &&
        (!room.lastResync || (now - room.lastResync) > 8000)) {
      const firstBad = room.badFrames.values().next().value;
      room.lastResync = now;
      log('[desync] restart trigger', room.code, 'badFrames', [...room.badFrames].join(','), 'gen', room.gen);
      restartRoom(room, 'desync@' + firstBad);
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
    /* ★ 第 90 轮：退出必须真的把人弄出房间。
       老逻辑在「对局中」只把座位标成 AI（座位还占着）→ 匹配开打之后退出，
       那个人仍然留在房间里（用户报的 bug）；而且 ws 模式客户端发完 leave 立刻 close，
       这条包经常根本到不了服务端。现在：
       ① 大厅里 → 座位直接清空 + 房主重选；
       ② 对局中 → 标记 left（这局继续由 AI 顶），回到大厅时统一清掉；
       ③ 自己创建的房间保留 2 分钟（方便回房），别人的空房立刻回收。 */
    if (s) {
      s.left = true;
      if (!act.pid) act.pid = s.pid;                 // ★ 第 90 轮：客户端没带 pid 时用座位上的账号 id
      if (room.state === 'lobby') {
        room.seats[seat] = null;
        if (room.ack) delete room.ack[seat];
        if (room.inputs) room.inputs.delete(seat);
        log('[room] left', room.code, 'seat', seat, s.name);
      } else {
        /* ★ 第 103 轮：对局中退出 —— 不挂 AI，标记 idle（服务端喂全 0 = 站着不动），
           并广播**谁**离线了，其他人继续打完这一局。 */
        s.idle = true; s.left = true; s.gone = true; s.connected = false;
        room.updated = now;
        broadcast(room, { a:'ev', room: room.code, f: (room.frameHigh | 0) + 1, seat, idle: true, gone: true, why:'leave', name: s.name });
        log('[left] mid-match', room.code, 'seat', seat, s.name);
      }
    }
    /* 房主走了 → 交给下一个真人座位（否则房间永远开不了局） */
    if (room.hostSeat === seat || !room.seats[room.hostSeat]) {
      const nx = room.seats.findIndex(x => x && !x.bot && !x.left);
      room.hostSeat = nx >= 0 ? nx : 0;
    }
    broadcast(room, { a:'seats', room: roomPublic(room) });
    if (humansIn(room) === 0) {
      if (room.state === 'lobby') {
        /* 自己创建的房间保留（给房主留个回房窗口），加入别人的房 → 立刻回收 */
        if (room.createdBy && room.createdBy === String(act.pid)) {
          room.keepUntil = now + 120000; room.emptySince = 0;
          log('[room] kept (creator left)', room.code, '2min');
        } else { reapRoom(room, 'all left'); return { ok: true, reaped: true }; }
      } else {
        room.emptySince = room.emptySince || now;
      }
    }
    return { ok: true };
  }
  /* --- ★ 第 72 轮：账号在线登记 / 好友 / 邀请 / 组队匹配（由 handle 顶部分流进来）--- */
  function social(act, ctx, now) {
  /* ★ 第 94 轮：账号存档 / 邮箱验证码（复用 werewolf 的 PHP SMTP 发信器） */
  const profileOf = (a) => ({
    coins: a.coins | 0, trophies: a.trophies | 0, owned: a.owned || [], claimed: a.claimed || [],
    welcome: a.welcome !== false, dailyDay: a.dailyDay || '', dailyProg: a.dailyProg || {},
    dailyClaimed: a.dailyClaimed || [], char: a.char || '', nick: a.nick || '',
    avatar: a.avatar || '',                       // ★ 第 97 轮：头像也存服务端（跨设备一致）
    email: a.emailVerified ? a.email : '',
    /* ★ 2026-10-23：跨设备同步（宝石/抽卡/皮肤武器/宝石任务/活动领取） */
    gems: a.gems | 0, shards: a.shards | 0, pity: a.pity | 0, supreme: a.supreme || [], weapons: a.weapons || [],
    skins: a.skins || [], equipSkins: a.equipSkins || {}, equipWeapon: a.equipWeapon || {},
    gemQ: a.gemQ || { day: '', dayGems: 0, total: 0, prog: {}, dayClaimed: {} },
    gemOnce: a.gemOnce || {}, eventClaims: a.eventClaims || {}, rev: a.rev | 0,
  });
  /* ================= ★ 跨设备同步：把客户端档案合并进服务端档案 =================
     merge=false（正常情况：客户端 rev == 服务端 rev，只有一个设备在写）→ 货币/进度以客户端为准；
     merge=true （客户端 rev 落后 = 别的设备写过）→ 货币取大、集合取并集、任务进度取大，
     宁可多给一点也不吞玩家进度；两边都只有「加法」语义，所以不会把已花掉的钱变回来太多。 */
  const _dayNum = (s) => { const m = /^(\d+)-(\d+)-(\d+)$/.exec(String(s || ''));
    return m ? (+m[1]) * 10000 + (+m[2]) * 100 + (+m[3]) : 0; };
  const _uni = (arr, cap) => Array.from(new Set((arr || []).filter(x => x !== null && x !== undefined))).slice(0, cap || 96);
  function applyProfile(a, p, merge) {
    if (!p || typeof p !== 'object') return;
    const pick = (cur, v) => merge ? Math.max(cur | 0, v | 0) : (v | 0);
    if (Number.isFinite(p.coins))    a.coins = Math.max(0, pick(a.coins, p.coins));
    if (Number.isFinite(p.gems))     a.gems = Math.max(0, pick(a.gems, p.gems));
    if (Number.isFinite(p.shards))   a.shards = Math.max(0, pick(a.shards, p.shards));   // 记忆碎片
    if (Number.isFinite(p.trophies)) a.trophies = Math.max(0, pick(a.trophies, p.trophies));
    if (Number.isFinite(p.pity))     a.pity = Math.max(0, Math.min(50, pick(a.pity, p.pity)));
    /* 集合类永远并集：解锁/皮肤/武器/至尊/奖励领取只会增加 */
    if (Array.isArray(p.owned))    a.owned = _uni((a.owned || []).concat(p.owned.filter(x => typeof x === 'string')), 96);
    if (Array.isArray(p.claimed))  a.claimed = _uni((a.claimed || []).concat(p.claimed.map(x => Number(x) | 0)), 96);
    if (Array.isArray(p.supreme))  a.supreme = _uni((a.supreme || []).concat(p.supreme.filter(x => typeof x === 'string')), 96);
    if (Array.isArray(p.weapons))  a.weapons = _uni((a.weapons || []).concat(p.weapons.filter(x => typeof x === 'string')), 128);
    if (Array.isArray(p.skins))    a.skins = _uni((a.skins || []).concat(p.skins.filter(x => typeof x === 'string')), 128);
    /* 装备表：以客户端为准（刚在这台设备上点的） */
    if (p.equipSkins && typeof p.equipSkins === 'object') a.equipSkins = Object.assign({}, a.equipSkins || {}, p.equipSkins);
    if (p.equipWeapon && typeof p.equipWeapon === 'object') a.equipWeapon = Object.assign({}, a.equipWeapon || {}, p.equipWeapon);
    /* 一次性标记：并集 */
    if (typeof p.welcome === 'boolean') a.welcome = a.welcome || p.welcome;
    if (p.gemOnce && typeof p.gemOnce === 'object') a.gemOnce = Object.assign({}, a.gemOnce || {}, p.gemOnce);
    if (p.eventClaims && typeof p.eventClaims === 'object') a.eventClaims = Object.assign({}, a.eventClaims || {}, p.eventClaims);
    /* 每日任务：按自然日比较（不能拿字符串比：'2026-10-9' > '2026-10-23' 是错的） */
    if (p.dailyDay && p.dailyProg) {
      const sd = _dayNum(a.dailyDay), cd = _dayNum(p.dailyDay);
      if (cd > sd) { a.dailyDay = String(p.dailyDay).slice(0, 20); a.dailyProg = p.dailyProg;
                     a.dailyClaimed = Array.isArray(p.dailyClaimed) ? p.dailyClaimed.slice(0, 8) : []; }
      else if (cd === sd && cd > 0) {
        const pr = a.dailyProg || (a.dailyProg = {});
        for (const k in p.dailyProg) pr[k] = Math.max(pr[k] | 0, p.dailyProg[k] | 0);
        a.dailyClaimed = _uni((a.dailyClaimed || []).concat(p.dailyClaimed || []), 8);
      }
    }
    /* 宝石任务：日进度/累计进度取大，日领取记录并集，两个上限服务端再夹一层 */
    if (p.gemQ && typeof p.gemQ === 'object') {
      if (!a.gemQ || typeof a.gemQ !== 'object') a.gemQ = { day: '', dayGems: 0, total: 0, prog: {}, dayClaimed: {} };
      const g = a.gemQ;
      const sd = _dayNum(g.day), cd = _dayNum(p.gemQ.day);
      if (cd > sd) { g.day = String(p.gemQ.day).slice(0, 20); g.dayGems = p.gemQ.dayGems | 0;
                     g.prog = p.gemQ.prog || {}; g.dayClaimed = p.gemQ.dayClaimed || {}; }
      else if (cd === sd && cd > 0) {
        const pr = g.prog || (g.prog = {});
        for (const k in (p.gemQ.prog || {})) pr[k] = Math.max(pr[k] | 0, p.gemQ.prog[k] | 0);
        g.dayClaimed = Object.assign({}, g.dayClaimed || {}, p.gemQ.dayClaimed || {});
        g.dayGems = Math.max(g.dayGems | 0, p.gemQ.dayGems | 0);
      }
      g.total = Math.max(0, Math.min(4000, Math.max(g.total | 0, p.gemQ.total | 0)));
      g.dayGems = Math.max(0, Math.min(500, g.dayGems | 0));
    }
    if (typeof p.char === 'string' && p.char) a.char = p.char.slice(0, 24);
    if (typeof p.nick === 'string' && p.nick) a.nick = p.nick.slice(0, 12);
    if (typeof p.avatar === 'string' && p.avatar) a.avatar = p.avatar.slice(0, 60000);
  }
  const codeHash = (c) => require('crypto').createHash('sha256').update('sbcode:' + c).digest('hex').slice(0, 40);
  const genCode = () => String(require('crypto').randomInt(100000, 1000000));
  function sendCodeMail(to, code) {
    /* ★ 第 96 轮：改成**异步**发信 —— 同步 execFileSync 会让 HTTP 请求卡在 SMTP 上，
       客户端/网关先超时（显示 net: failed），但邮件其实发出去了。现在立刻返回，后台发。 */
    try {
      const { spawn } = require('child_process');
      const child = spawn('php', [require('path').join(__dirname, 'mail_code.php'), to, String(code)],
                          { stdio: 'ignore', detached: true });
      child.on('error', (e) => log('[mail] spawn error', String(e.message).slice(0, 120)));
      child.on('exit', (c) => log('[mail]', c === 0 ? 'code sent' : 'send failed(' + c + ')', to));
      child.unref();
      return true;
    } catch (e) { log('[mail] failed', to, String(e.message).slice(0, 120)); return false; }
  }
  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
  const byEmail = (em) => Object.keys(ACCTS).find(k => ACCTS[k].emailVerified && ACCTS[k].email === em);
  /* 邮箱验证码：bind（绑定）/ verify（确认）/ login（登录另一台设备上的号） */
  if (act.a === 'bind') {
    const a = accOf(act.pid); if (!a) return { ok: false, e: 'no_id' };
    const em = String(act.email || '').trim().toLowerCase();
    if (!EMAIL_RE.test(em)) return { ok: false, e: 'bad_email' };
    const other = byEmail(em);
    if (other && other !== String(act.pid)) return { ok: false, e: 'email_taken' };
    const c = genCode();
    a.pendingEmail = em; a.emailCode = codeHash(c); a.emailExp = now + 600000;
    accSave(true);
    return sendCodeMail(em, c) ? { ok: true, sent: true, email: em } : { ok: false, e: 'mail_failed' };
  }
  if (act.a === 'verify') {
    const a = accOf(act.pid); if (!a) return { ok: false, e: 'no_id' };
    if (!a.emailCode || !a.emailExp || now > a.emailExp) return { ok: false, e: 'code_expired' };
    if (codeHash(String(act.code || '').trim()) !== a.emailCode) return { ok: false, e: 'bad_code' };
    a.email = a.pendingEmail; a.emailVerified = true; a.emailCode = ''; a.pendingEmail = '';
    accSave(true);
    log('[acct] email bound', String(act.pid).slice(0, 8), a.email);
    return { ok: true, email: a.email, profile: profileOf(a) };
  }
  if (act.a === 'login') {
    const em = String(act.email || '').trim().toLowerCase();
    if (!EMAIL_RE.test(em)) return { ok: false, e: 'bad_email' };
    const key = byEmail(em);
    if (!key) return { ok: false, e: 'no_account' };
    const a = ACCTS[key];
    if (act.code) {
      if (!a.emailCode || !a.emailExp || now > a.emailExp) return { ok: false, e: 'code_expired' };
      if (codeHash(String(act.code).trim()) !== a.emailCode) return { ok: false, e: 'bad_code' };
      a.emailCode = ''; accSave(true);
      log('[acct] login', em, '->', key.slice(0, 8));
      return { ok: true, pid: key, profile: profileOf(a) };
    }
    const c = genCode();
    a.emailCode = codeHash(c); a.emailExp = now + 600000; accSave(true);
    return sendCodeMail(em, c) ? { ok: true, sent: true } : { ok: false, e: 'mail_failed' };
  }
  if (act.a === 'profile') {                                    // ★ 只读：按 pid 拉服务端档案（客户端测试账号同步奖杯/金币/解锁用）
    const a = accOf(String(act.pid || ''));
    if (!a) return { ok: false, e: 'no_id' };
    return { ok: true, pid: String(act.pid), nick: a.nick, profile: profileOf(a) };
  }
  if (act.a === 'acct') {
    const a = accOf(act.pid); if (!a) return { ok: false, e: 'no_id' };
    a.nick = String(act.nick || a.nick || '').slice(0, 12); a.last = now;
    const rec = ONLINE.get(String(act.pid)) || {};
    if (ctx.ws) rec.ws = ctx.ws;
    rec.nick = a.nick; rec.code = act.code || ''; rec.at = now;
    /* ★ 跨设备同步：客户端把整份档案推上来（含金币/宝石/每日任务/宝石任务/皮肤武器）
       rev 相同 = 只有这台设备在写 → 以客户端为准；rev 落后 = 别的设备写过 → 保守合并。 */
    const _cr = Number.isFinite(act.rev) ? (act.rev | 0) : 0;
    const _merge = _cr < (a.rev | 0);
    if (act.profile && typeof act.profile === 'object') applyProfile(a, act.profile, _merge);
    a.rev = (a.rev | 0) + 1;
    ONLINE.set(String(act.pid), rec);
    accSave();
    return { ok: true, me: String(act.pid), nick: a.nick, trophies: a.trophies | 0, merged: _merge,
             email: a.emailVerified ? a.email : '', profile: profileOf(a) };
  }
  if (act.a === 'friends') {
    const a = accOf(act.pid); if (!a) return { ok: false, e: 'no_id' };
    a.nick = String(act.nick || a.nick || '').slice(0, 12);
    const inv = a.inv.splice(0, a.inv.length);           // 取走待处理邀请（轮询端靠这里拿，ws 端也有推送）
    /* 拉个列表也算「活着」：否则只在大厅看好友的人永远被判离线 */
    const rec = ONLINE.get(String(act.pid)) || {};
    rec.nick = a.nick; rec.at = now; if (act.code) rec.code = act.code;
    if (ctx.ws) rec.ws = ctx.ws;
    /* ★ 跨设备同步（好友轮询也会捎带整份档案）—— 与 acct 同一套 rev 合并规则 */
    const _cr2 = Number.isFinite(act.rev) ? (act.rev | 0) : 0;
    if (act.profile && typeof act.profile === 'object') applyProfile(a, act.profile, _cr2 < (a.rev | 0));
    ONLINE.set(String(act.pid), rec);
    accSave();
    return { ok: true, me: String(act.pid), nick: a.nick, list: friendListOf(act.pid), inv,
             req: reqListOf(act.pid), out: outReqOf(act.pid), trophies: a.trophies | 0,
             email: a.emailVerified ? a.email : '', profile: profileOf(a) };
  }
  /* ★ 第 86 轮：奖杯结算（客户端上报增量；token 去重，同一局同一座位只算一次） */
  if (act.a === 'trophy') {
    const a = accOf(act.pid); if (!a) return { ok: false, e: 'no_id' };
    const tk = String(act.token || '').slice(0, 48);
    if (tk && a.trophyTok.indexOf(tk) >= 0) return { ok: true, dup: true, trophies: a.trophies | 0 };
    if (tk) { a.trophyTok.push(tk); if (a.trophyTok.length > 40) a.trophyTok.shift(); }
    const d = Math.max(-20, Math.min(20, Number(act.delta) | 0));        // 单局增量夹在 ±20，防离谱数值
    a.trophies = Math.max(0, (a.trophies | 0) + d);
    a.last = now; accSave(true);
    log('[trophy]', String(act.pid).slice(0, 8), d >= 0 ? '+' + d : d, '→', a.trophies);
    return { ok: true, trophies: a.trophies };
  }
    if (act.a === 'fadd') {
    const me = accOf(act.pid); if (!me) return { ok: false, e: 'no_id' };
    const q = String(act.target || '').trim(); if (!q) return { ok: false, e: 'need_target' };
    if (q === String(act.pid)) return { ok: false, e: 'self' };
    let tid = ACCTS[q] ? q : null;
    if (!tid) for (const k of Object.keys(ACCTS)) if (k.indexOf(q) === 0) { tid = k; break; }
    if (!tid) { const ql = q.toLowerCase();
      for (const k of Object.keys(ACCTS)) if ((ACCTS[k].nick || '').toLowerCase() === ql) { tid = k; break; } }
    if (!tid) return { ok: false, e: 'no_account' };
    if (me.friends.indexOf(tid) >= 0) return { ok: true, already: true, id: tid, list: friendListOf(act.pid), req: reqListOf(act.pid) };
    /* ★ 第 74 轮：加好友要对方同意。
       ① 对方已经申请过我 → 直接互相成为好友；② 否则只写一条待处理申请并推给对端。 */
    if ((me.req || []).some(r => r.id === tid)) return acceptFriend(act.pid, tid);
    const other = accOf(tid);
    if (!other.req) other.req = [];
    if (!other.req.some(r => r.id === String(act.pid)))
      other.req.push({ id: String(act.pid), nick: me.nick, at: now });
    accSave(true);
    pushTo(tid, { a: 'freq', from: { id: String(act.pid), nick: me.nick } });
    return { ok: true, pending: true, id: tid, nick: other.nick || '', list: friendListOf(act.pid), req: reqListOf(act.pid) };
  }
  if (act.a === 'facc') return acceptFriend(act.pid, String(act.target || ''));
  if (act.a === 'fdec') {
    const me = accOf(act.pid); if (!me) return { ok: false, e: 'no_id' };
    me.req = (me.req || []).filter(r => r.id !== String(act.target || ''));
    accSave(true);
    return { ok: true, declined: true, list: friendListOf(act.pid), req: reqListOf(act.pid) };
  }
  if (act.a === 'fdel') {
    const me = accOf(act.pid); if (!me) return { ok: false, e: 'no_id' };
    const t = String(act.target || '');
    me.friends = me.friends.filter(x => x !== t);
    const other = ACCTS[t]; if (other) other.friends = (other.friends || []).filter(x => x !== String(act.pid));
    accSave(true);
    return { ok: true, list: friendListOf(act.pid) };
  }
  if (act.a === 'invite') {
    /* 把全部在线好友拉进我当前的房间：已在大厅的自动加入；房满了就回 room_full */
    const me = accOf(act.pid); if (!me) return { ok: false, e: 'no_id' };
    const rm = rooms.get(String(act.code || '').toUpperCase());
    if (!rm) return { ok: false, e: 'no_room' };
    let free = 0;
    for (let i = 0; i < rm.rules.count; i++) if (!rm.seats[i]) free++;
    let sent = 0, full = 0;
    for (const fid of me.friends) {
      if (!ONLINE.get(fid)) continue;
      if (free - sent <= 0) {
        pushTo(fid, { a: 'invite', from: { id: String(act.pid), nick: me.nick }, code: rm.code, e: 'room_full' });
        const fa = accOf(fid); if (fa) { fa.inv.push({ from: { id: String(act.pid), nick: me.nick }, code: rm.code, e: 'room_full', at: now }); if (fa.inv.length > 8) fa.inv.shift(); accSave(); }
        full++; continue;
      }
      pushTo(fid, { a: 'invite', from: { id: String(act.pid), nick: me.nick }, code: rm.code });
      const fa = accOf(fid);
      if (fa) { fa.inv.push({ from: { id: String(act.pid), nick: me.nick }, code: rm.code, at: now }); if (fa.inv.length > 8) fa.inv.shift(); accSave(); }
      sent++;
    }
    return { ok: true, sent, full, free };
  }
  if (act.a === 'queue') {
    /* 组队匹配：整个房间一起排。模式（mode）与设置（rules）都要一致才配对；
       不同模式但**有空位**的房会放进 suggest，客户端问「要不要改加入那个模式」。 */
    const rm = rooms.get(String(act.code || '').toUpperCase());
    if (!rm) return { ok: false, e: 'no_room' };
    /* ★ 只退出「我自己」这一份匹配；队里还有人想排就继续排。
       以前按房间号直接删队列 → 任何一名队员点掉匹配面板就取消全队匹配，
       其他人面板还在倒计时（用户报的「一个人看不到正在匹配」）。 */
    /* ★ 我们已经被别人匹配上了（对方正往这边 join）：**不要再把自己塞回队列**。
       否则被匹配方下一次 3 秒轮询就会把 queued.await 覆盖成普通排队状态，
       还可能被第三支队重复匹配（用户报的「有人没进去/看不到匹配」的放大器）。 */
    if (rm.queued && rm.queued.await && (now - (rm.queued.at || 0)) < 12000) {
      return { ok: true, await: true, mode: rm.queued.mode,
               joined: rm.seats.filter(x => x && !x.bot).length };
    }
    if (act.op === 'leave') {
      rm.qout = rm.qout || new Set();
      if (act.pid) rm.qout.add(String(act.pid));
      const humans = rm.seats.filter(x => x && !x.bot && !x.left).map(x => String(x.pid || ''));
      const still = humans.filter(p => !p || !rm.qout.has(p));
      if (!still.length) { QUEUE.delete(rm.code); rm.queued = null; rm.qout = new Set(); }
      return { ok: true, left: true, still: still.length };
    }
    if (rm.state === 'play') return { ok: false, e: 'in_game' };
    const mode = String(act.mode || rm.mode || 'classic').slice(0, 12);
    rm.mode = mode;
    const key = rulesKey(rm.rules) + '|' + mode;
    const found = [], suggest = [];
    let cand = null, candSame = false;
    /* ★ 我这队要占几个座位 + 对方还剩几个空位。
       以前只看「规则相同」就配对，满房对满房也配 → 每个人 join 时都会先 leave 掉自己的房间，
       到对方房间又被 room_full 拒 → 整队变成「无房、也看不到比赛」（用户报的 bug）。 */
    const needSeats = rm.seats.filter(x => x && !x.bot).length || 1;
    const freeSeatsOf = (r) => { let n = 0; for (let i = 0; i < r.rules.count; i++) if (!r.seats[i]) n++; return n; };
    for (const it of QUEUE.values()) {
      if (it.code === rm.code) continue;
      const r2 = rooms.get(it.code);
      if (!r2) { QUEUE.delete(it.code); continue; }
      if ((it.at || 0) < now - 120000) { QUEUE.delete(it.code); continue; }
      const k2 = rulesKey(it.rules) + '|' + (it.mode || 'classic');
      const fits = freeSeatsOf(r2) >= needSeats && r2.state !== 'play';
      if (fits) for (const s3 of r2.seats) if (s3 && !s3.bot && found.length < 8) found.push(s3.name);
      if (k2 === key) { if (fits && !cand) { cand = it; candSame = true; } continue; }
      let free = 0; for (let i = 0; i < r2.rules.count; i++) if (!r2.seats[i]) free++;
      if (free > 0 && suggest.length < 3) suggest.push({
        code: it.code, mode: it.mode || 'classic', rules: it.rules, free,
        nick: ((r2.seats.find(x => x && !x.bot)) || {}).name || '' });
    }
    for (const s4 of rm.seats) if (s4 && !s4.bot && found.length < 8) found.push(s4.name);
    if (!cand) {
      if (rm.qout && act.pid) rm.qout.delete(String(act.pid));   // 我又点了匹配 → 撤销「退出」标记
      const prev = QUEUE.get(rm.code);
      const at = (prev && prev.at) || now;
      QUEUE.set(rm.code, { code: rm.code, rules: rm.rules, mode, pid: act.pid, at });
      rm.queued = { mode, at };                    // ★ 第 83 轮：写回房间，后加入的人也能看到「匹配中 + 已等多久」
      return { ok: true, queued: true, mode, waiting: QUEUE.size, found, suggest };
    }
    if (!candSame && !act.force) {
      return { ok: true, conflict: { code: cand.code, mode: cand.mode || 'classic', rules: cand.rules,
                                     nick: (ACCTS[String(cand.pid)] || {}).nick || '' }, found, suggest };
    }
    const target = rooms.get(cand.code);
    if (!target) return { ok: true, queued: true, retry: true, found, suggest };
    QUEUE.delete(cand.code);
    /* ★ 配对成功必须**两边都通知**：
       · 发起方：redirect → 客户端 applyRoom 里跳房
       · 被匹配方：queued 改成 await（面板显示「对手就要来了」）。
         以前只广播给发起方、还把对方 queued 清空 → 那一方一点提示都没有，
         而且它下一次 queue 轮询会把自己重新入队，可能又匹配到第三队（用户报的 bug）。 */
    rm.queued = null; rm.redirect = target.code; rm.redirectAt = now; rm.updated = now;
    target.queued = { mode, at: now, await: true };
    target.updated = now; target.redirectAt = now;
    broadcast(target, { a: 'match', code: rm.code, same: candSame, incoming: true });
    broadcast(rm, { a: 'match', code: target.code, same: candSame });
    log('[queue] match', rm.code, '→', target.code, mode, candSame ? '(same rules+mode)' : '(forced)');
    return { ok: true, match: target.code, same: candSame, found, suggest: [] };
  }
    return { ok: false, e: 'unknown_action' };
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
    /* ★ 第 74 轮：这条 socket 断掉 → 立刻把它的在线记录清掉（否则会一直显示 online 直到 TTL） */
    for (const [k, v] of ONLINE) if (v && v.ws === ws) ONLINE.delete(k);
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
