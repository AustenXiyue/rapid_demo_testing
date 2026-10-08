// 对局与大厅：新建、加入（邀请码或从公开列表）、座位、状态流转，以及房间的实时推送与在线状态。
//
// 状态：lobby（招募中）→ active（进行中）⇄ paused（已暂停）→ finished（已结束）
// - 招募中：凭邀请码或公开列表加入，直到人满；主导可移除玩家、切换自己是否占座位；玩家可退出。
// - 开局后：只能加入被主导释放出来的空座位（座位和上面的数据保留，只解除旧账户）。
// - 删除：开局前真删；开局后只对主导隐藏（owner_deleted_at），对局记为已结束，记录留在服务器上。
//
// 面板存档：开局时由服务端用 core.js 生成——主持人存档（玩家名单按座位）跟着对局，每个座位一份玩家存档（已套用规则包）。
// 只在进行中可写；按 version 发现两台设备同时修改。主持人改了规则或玩家名单，服务端自动套到所有玩家存档上并推送。
//
// 所有写操作都是同步的 SQLite 调用，中间没有 await，单进程下天然不会并发冲突。

const crypto = require('node:crypto');
const express = require('express');
const C = require('../src/shared/core.js');
const { requireUser } = require('./auth');

const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // 去掉了容易看混的 I、L、O、0、1
const MAX_SEATS = 12;
const TITLE_MAX = 40;
const NEXT_STATUS = { lobby: ['active'], active: ['paused', 'finished'], paused: ['active', 'finished'], finished: [] };
// 不含存档 JSON 的列：列表、权限检查都用这些，免得每次都把大块存档读出来
const GAME_COLS = 'id, owner_id, title, code, status, max_seats, created_at, updated_at, owner_deleted_at';
const G_COLS = GAME_COLS.split(', ').map((c) => 'g.' + c).join(', ');

function createGames(db, io) {
  const getGame = (id) => db.prepare(`SELECT ${GAME_COLS} FROM games WHERE id = ?`).get(id);
  const seatOf = (gameId, userId) => db.prepare('SELECT id, seat_no, user_id FROM seats WHERE game_id = ? AND user_id = ?').get(gameId, userId);
  const touch = (id) => db.prepare('UPDATE games SET updated_at = ? WHERE id = ?').run(Date.now(), id);
  const isMember = (g, userId) => (g.owner_id === userId && !g.owner_deleted_at) || !!seatOf(g.id, userId);

  // 在线＝此刻有页面订阅着这个房间
  function onlineIds(gameId) {
    const ids = new Set();
    for (const sid of io.sockets.adapter.rooms.get('game:' + gameId) || []) {
      const s = io.sockets.sockets.get(sid);
      if (s) ids.add(s.data.user.id);
    }
    return ids;
  }

  function gameView(gameId) {
    const g = db.prepare(`SELECT ${G_COLS}, u.username AS owner_name FROM games g JOIN users u ON u.id = g.owner_id WHERE g.id = ?`).get(gameId);
    if (!g) return null;
    const online = onlineIds(gameId);
    const seats = db.prepare(
      'SELECT s.id, s.seat_no, s.user_id, u.username FROM seats s LEFT JOIN users u ON u.id = s.user_id WHERE s.game_id = ? ORDER BY s.seat_no'
    ).all(gameId);
    return {
      id: g.id, title: g.title, code: g.code, status: g.status, maxSeats: g.max_seats,
      owner: { id: g.owner_id, username: g.owner_name, online: online.has(g.owner_id) },
      ownerDeleted: !!g.owner_deleted_at,
      seats: seats.map((s) => ({
        id: s.id, seatNo: s.seat_no,
        user: s.user_id ? { id: s.user_id, username: s.username, online: online.has(s.user_id) } : null,
      })),
      createdAt: g.created_at, updatedAt: g.updated_at,
    };
  }

  // 只推房间里的最新状态（在线变化用）
  function broadcast(gameId) {
    const view = gameView(gameId);
    if (view) io.to('game:' + gameId).emit('game:update', view);
    return view;
  }

  // 对局有实质变化：推房间，并通知相关账户刷新「我的对局」、所有人刷新公开列表
  function push(gameId, affected = []) {
    const view = broadcast(gameId);
    const users = new Set(affected);
    if (view) {
      users.add(view.owner.id);
      view.seats.forEach((s) => s.user && users.add(s.user.id));
    }
    for (const u of users) io.to('user:' + u).emit('games:changed');
    io.emit('lobby:changed');
  }

  // 把某个账户从房间里请出去（被移除、座位被释放、对局被删除）
  function kick(gameId, userId) {
    io.in('user:' + userId).socketsLeave('game:' + gameId);
    io.to('user:' + userId).emit('game:gone', { id: gameId });
  }

  // 招募阶段占一个新座位（编号取最小的空号）；满了返回 false
  function addSeat(g, userId) {
    const taken = db.prepare('SELECT seat_no FROM seats WHERE game_id = ?').all(g.id).map((s) => s.seat_no);
    if (taken.length >= g.max_seats) return false;
    let no = 1;
    while (taken.includes(no)) no++;
    db.prepare('INSERT INTO seats (id, game_id, seat_no, user_id, joined_at) VALUES (?, ?, ?, ?, ?)')
      .run(crypto.randomUUID(), g.id, no, userId, Date.now());
    return true;
  }

  // 列表里的一行：free＝还能加入几个人（招募中按人数上限算，开局后按空座位算）
  function summary(row, me) {
    return {
      id: row.id, title: row.title, status: row.status, maxSeats: row.max_seats,
      taken: row.taken, free: row.status === 'lobby' ? row.max_seats - row.taken : row.open,
      owner: { username: row.owner_name },
      role: row.owner_id === me ? (row.seated ? 'host-player' : 'host') : 'player',
      ownerDeleted: !!row.owner_deleted_at,
      updatedAt: row.updated_at,
    };
  }
  const SUMMARY_SQL = `SELECT ${G_COLS}, u.username AS owner_name,
      (SELECT COUNT(*) FROM seats s WHERE s.game_id = g.id AND s.user_id IS NOT NULL) AS taken,
      (SELECT COUNT(*) FROM seats s WHERE s.game_id = g.id AND s.user_id IS NULL) AS open,
      EXISTS (SELECT 1 FROM seats s WHERE s.game_id = g.id AND s.user_id = :me) AS seated
    FROM games g JOIN users u ON u.id = g.owner_id`;

  function join(g, user, res) {
    if (!g || (g.owner_deleted_at && g.owner_id === user.id)) return res.status(404).json({ error: 'not_found' });
    if (isMember(g, user.id)) return res.json({ id: g.id });
    if (g.owner_deleted_at || g.status === 'finished') return res.status(409).json({ error: 'game_closed' });
    if (g.status === 'lobby') {
      if (!addSeat(g, user.id)) return res.status(409).json({ error: 'game_full' });
    } else {
      const open = db.prepare('SELECT id FROM seats WHERE game_id = ? AND user_id IS NULL ORDER BY seat_no LIMIT 1').get(g.id);
      if (!open) return res.status(409).json({ error: 'no_open_seat' });
      db.prepare('UPDATE seats SET user_id = ?, joined_at = ? WHERE id = ?').run(user.id, Date.now(), open.id);
    }
    touch(g.id);
    push(g.id);
    res.json({ id: g.id });
  }

  // ---------------------------------------------------------------- 面板存档

  // 开局：主持人存档的玩家名单按座位生成（玩家 ID＝座位 ID），每个座位一份玩家存档并套用规则包
  function initStates(gameId) {
    const seats = db.prepare(
      'SELECT s.id, u.username FROM seats s JOIN users u ON u.id = s.user_id WHERE s.game_id = ? ORDER BY s.seat_no'
    ).all(gameId);
    const now = Date.now();
    const host = C.newHostState();
    host.players = seats.map((s) => ({ id: s.id, name: s.username, alive: true }));
    host.seatOrder = host.players.map((p) => p.id);
    host.log.unshift({ id: C.uid('log'), at: now, day: host.day, phase: host.phase, text: '联机开局：按座位生成玩家名单', secret: false });
    db.prepare('UPDATE games SET host_state = ?, host_version = 1 WHERE id = ?').run(JSON.stringify(host), gameId);
    const pack = C.makeRulesPack(host, null);
    for (const s of seats) {
      const p = C.newPlayerState();
      p.name = s.username;
      p.playerId = s.id;
      C.applyRulesPack(p, pack);
      p.log.unshift({ id: C.uid('log'), at: now, day: p.publicInfo.day, text: '联机开局：已载入主持人的规则与玩家名单' });
      db.prepare('UPDATE seats SET state = ?, version = 1 WHERE id = ?').run(JSON.stringify(p), s.id);
    }
  }

  // 主持人改了规则／自定义物品或玩家名单：套到所有玩家存档上，并推给在线的玩家（页面弹出提示）
  function syncRules(gameId, before, after) {
    const a = C.makeRulesPack(before, null);
    const b = C.makeRulesPack(after, null);
    const rules = JSON.stringify([a.rules, a.customItems]) !== JSON.stringify([b.rules, b.customItems]);
    const roster = JSON.stringify(a.roster.players) !== JSON.stringify(b.roster.players);
    if (!rules && !roster) return;
    const what = rules && roster ? '规则和玩家名单' : rules ? '规则' : '玩家名单';
    const now = Date.now();
    for (const seat of db.prepare('SELECT id, user_id, state, version FROM seats WHERE game_id = ? AND state IS NOT NULL').all(gameId)) {
      const p = C.applyRulesPack(JSON.parse(seat.state), b);
      p.log.unshift({ id: C.uid('log'), at: now, day: p.publicInfo ? p.publicInfo.day : null, text: '主持人更新了' + what + '，已自动同步' });
      db.prepare('UPDATE seats SET state = ?, version = ? WHERE id = ?').run(JSON.stringify(p), seat.version + 1, seat.id);
      if (seat.user_id) {
        io.to('user:' + seat.user_id).emit('state:update', { gameId, kind: 'seat', version: seat.version + 1, state: p, reason: { rules, roster } });
      }
    }
  }

  // 写存档前的检查：只有进行中可写、版本号要对得上、结构要合法。不通过时已经回了错误，返回 null
  function checkWrite(req, res, g, row, kind) {
    if (g.status !== 'active') { res.status(409).json({ error: 'read_only', status: g.status }); return null; }
    const { version, state } = req.body || {};
    if (version !== row.version) {
      res.status(409).json({ error: 'version_conflict', version: row.version, state: row.state ? JSON.parse(row.state) : null });
      return null;
    }
    const v = C.validateSave(state, kind);
    if (!v.ok) { res.status(400).json({ error: 'bad_state', detail: v.errors[0] }); return null; }
    return C.normalizeSave(state, kind);
  }

  // ---------------------------------------------------------------- HTTP 接口（挂在 /api/games）

  const r = express.Router();
  r.use(express.json({ limit: '5mb' })); // 存档可能有几百 KB（日志、事件库）
  r.use(requireUser(db));

  // 只有成员能看到对局；对非成员一律 404，不透露对局是否存在
  function loadMember(req, res, { ownerOnly = false } = {}) {
    const g = getGame(req.params.id);
    if (!g || !isMember(g, req.user.id)) { res.status(404).json({ error: 'not_found' }); return null; }
    if (ownerOnly && g.owner_id !== req.user.id) { res.status(403).json({ error: 'owner_only' }); return null; }
    return g;
  }

  r.get('/', (req, res) => {
    const me = req.user.id;
    const rows = db.prepare(SUMMARY_SQL + `
      WHERE (g.owner_id = :me AND g.owner_deleted_at IS NULL)
         OR EXISTS (SELECT 1 FROM seats s WHERE s.game_id = g.id AND s.user_id = :me)
      ORDER BY g.updated_at DESC`).all({ me });
    res.json({ games: rows.map((row) => summary(row, me)) });
  });

  // 公开列表（匹配大厅）：还能加入、自己又不在里面的对局
  r.get('/open', (req, res) => {
    const me = req.user.id;
    const rows = db.prepare(SUMMARY_SQL + `
      WHERE g.owner_deleted_at IS NULL AND g.status != 'finished' AND g.owner_id != :me
        AND NOT EXISTS (SELECT 1 FROM seats s WHERE s.game_id = g.id AND s.user_id = :me)
      ORDER BY g.updated_at DESC LIMIT 100`).all({ me });
    res.json({ games: rows.map((row) => summary(row, me)).filter((g) => g.free > 0) });
  });

  r.post('/', (req, res) => {
    const { title, maxSeats, hostPlays } = req.body || {};
    const t = typeof title === 'string' ? title.trim() : '';
    if (!t || t.length > TITLE_MAX) return res.status(400).json({ error: 'bad_title' });
    if (!Number.isInteger(maxSeats) || maxSeats < 1 || maxSeats > MAX_SEATS) return res.status(400).json({ error: 'bad_max_seats' });
    const now = Date.now();
    const g = { id: crypto.randomUUID(), max_seats: maxSeats };
    for (let tries = 0; ; tries++) {
      const code = Array.from(crypto.randomBytes(6), (b) => CODE_CHARS[b % CODE_CHARS.length]).join('');
      try {
        db.prepare('INSERT INTO games (id, owner_id, title, code, status, max_seats, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
          .run(g.id, req.user.id, t, code, 'lobby', maxSeats, now, now);
        break;
      } catch (e) {
        if (!/UNIQUE/.test(e.message) || tries > 10) throw e;
      }
    }
    if (hostPlays === true) addSeat(g, req.user.id);
    push(g.id);
    res.json({ game: gameView(g.id) });
  });

  r.post('/join', (req, res) => {
    const code = String((req.body || {}).code || '').toUpperCase().replace(/\s+/g, '');
    const g = /^[A-Z0-9]{6}$/.test(code) ? db.prepare(`SELECT ${GAME_COLS} FROM games WHERE code = ?`).get(code) : null;
    if (!g) return res.status(404).json({ error: 'bad_code' });
    join(g, req.user, res);
  });

  r.post('/:id/join', (req, res) => join(getGame(req.params.id), req.user, res));

  r.get('/:id', (req, res) => {
    if (loadMember(req, res)) res.json({ game: gameView(req.params.id) });
  });

  r.post('/:id/status', (req, res) => {
    const g = loadMember(req, res, { ownerOnly: true });
    if (!g) return;
    const next = (req.body || {}).status;
    if (!NEXT_STATUS[g.status].includes(next)) return res.status(409).json({ error: 'bad_transition' });
    if (next === 'active' && g.status === 'lobby' && !db.prepare('SELECT 1 FROM seats WHERE game_id = ?').get(g.id)) {
      return res.status(409).json({ error: 'no_players' });
    }
    db.prepare('UPDATE games SET status = ?, updated_at = ? WHERE id = ?').run(next, Date.now(), g.id);
    if (g.status === 'lobby') initStates(g.id);
    push(g.id);
    res.json({ game: gameView(g.id) });
  });

  // 主导是否同时扮演角色：只能在招募阶段切换
  r.post('/:id/host-plays', (req, res) => {
    const g = loadMember(req, res, { ownerOnly: true });
    if (!g) return;
    if (g.status !== 'lobby') return res.status(409).json({ error: 'already_started' });
    const on = (req.body || {}).on === true;
    const mine = seatOf(g.id, req.user.id);
    if (on && !mine && !addSeat(g, req.user.id)) return res.status(409).json({ error: 'game_full' });
    if (!on && mine) db.prepare('DELETE FROM seats WHERE id = ?').run(mine.id);
    touch(g.id);
    push(g.id);
    res.json({ game: gameView(g.id) });
  });

  // 主导管理座位：招募阶段 remove（整个座位删掉）；开局后 release（座位与数据保留，解除账户，开放加入）
  r.post('/:id/seats/:seatId', (req, res) => {
    const g = loadMember(req, res, { ownerOnly: true });
    if (!g) return;
    const seat = db.prepare('SELECT id, user_id FROM seats WHERE id = ? AND game_id = ?').get(req.params.seatId, g.id);
    if (!seat) return res.status(404).json({ error: 'not_found' });
    const action = (req.body || {}).action;
    if (action === 'remove') {
      if (g.status !== 'lobby') return res.status(409).json({ error: 'already_started' });
      if (seat.user_id === g.owner_id) return res.status(409).json({ error: 'use_host_plays' });
      db.prepare('DELETE FROM seats WHERE id = ?').run(seat.id);
    } else if (action === 'release') {
      if (g.status !== 'active' && g.status !== 'paused') return res.status(409).json({ error: 'not_started' });
      if (!seat.user_id) return res.status(409).json({ error: 'already_open' });
      db.prepare('UPDATE seats SET user_id = NULL, joined_at = NULL WHERE id = ?').run(seat.id);
    } else {
      return res.status(400).json({ error: 'bad_action' });
    }
    touch(g.id);
    if (seat.user_id && seat.user_id !== g.owner_id) kick(g.id, seat.user_id);
    push(g.id, seat.user_id ? [seat.user_id] : []);
    res.json({ game: gameView(g.id) });
  });

  // 玩家在招募阶段退出；开局后要离开得请主导释放座位
  r.post('/:id/leave', (req, res) => {
    const g = loadMember(req, res);
    if (!g) return;
    if (g.owner_id === req.user.id) return res.status(409).json({ error: 'owner_cannot_leave' });
    if (g.status !== 'lobby') return res.status(409).json({ error: 'already_started' });
    db.prepare('DELETE FROM seats WHERE game_id = ? AND user_id = ?').run(g.id, req.user.id);
    touch(g.id);
    kick(g.id, req.user.id);
    push(g.id, [req.user.id]);
    res.json({ ok: true });
  });

  // 面板存档：主持人存档只有主导能读写；玩家存档只能读写自己的座位
  const hostRow = (id) => db.prepare('SELECT host_state AS state, host_version AS version FROM games WHERE id = ?').get(id);
  const seatRow = (id) => db.prepare('SELECT state, version FROM seats WHERE id = ?').get(id);
  function sendState(res, g, row) {
    if (!row.state) return res.status(409).json({ error: 'not_started' });
    res.type('json').send(`{"version":${row.version},"game":${JSON.stringify(gameView(g.id))},"state":${row.state}}`);
  }

  r.get('/:id/state/host', (req, res) => {
    const g = loadMember(req, res, { ownerOnly: true });
    if (g) sendState(res, g, hostRow(g.id));
  });

  r.put('/:id/state/host', (req, res) => {
    const g = loadMember(req, res, { ownerOnly: true });
    if (!g) return;
    const row = hostRow(g.id);
    const state = checkWrite(req, res, g, row, 'shelter-host');
    if (!state) return;
    const version = row.version + 1;
    db.prepare('UPDATE games SET host_state = ?, host_version = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(state), version, Date.now(), g.id);
    io.to('user:' + req.user.id).emit('state:update', { gameId: g.id, kind: 'host', version, state, from: req.body.from || null });
    if (row.state) syncRules(g.id, JSON.parse(row.state), state);
    res.json({ version });
  });

  r.get('/:id/state/seat', (req, res) => {
    const g = loadMember(req, res);
    if (!g) return;
    const seat = seatOf(g.id, req.user.id);
    if (!seat) return res.status(404).json({ error: 'no_seat' });
    sendState(res, g, seatRow(seat.id));
  });

  r.put('/:id/state/seat', (req, res) => {
    const g = loadMember(req, res);
    if (!g) return;
    const seat = seatOf(g.id, req.user.id);
    if (!seat) return res.status(404).json({ error: 'no_seat' });
    const row = seatRow(seat.id);
    const state = checkWrite(req, res, g, row, 'shelter-player');
    if (!state) return;
    const version = row.version + 1;
    db.prepare('UPDATE seats SET state = ?, version = ? WHERE id = ?').run(JSON.stringify(state), version, seat.id);
    touch(g.id);
    io.to('user:' + req.user.id).emit('state:update', { gameId: g.id, kind: 'seat', version, state, from: req.body.from || null });
    res.json({ version });
  });

  r.delete('/:id', (req, res) => {
    const g = loadMember(req, res, { ownerOnly: true });
    if (!g) return;
    if (g.status === 'lobby') {
      const members = db.prepare('SELECT user_id FROM seats WHERE game_id = ? AND user_id IS NOT NULL').all(g.id).map((s) => s.user_id);
      members.push(g.owner_id);
      db.prepare('DELETE FROM games WHERE id = ?').run(g.id);
      members.forEach((u) => kick(g.id, u));
      push(g.id, members);
    } else {
      const now = Date.now();
      db.prepare("UPDATE games SET owner_deleted_at = ?, status = 'finished', updated_at = ? WHERE id = ?").run(now, now, g.id);
      kick(g.id, g.owner_id);
      push(g.id);
    }
    res.json({ ok: true });
  });

  // ---------------------------------------------------------------- Socket.IO：订阅房间

  function attach(socket) {
    const user = socket.data.user;
    function unwatch() {
      const prev = socket.data.watching;
      if (!prev) return;
      socket.data.watching = null;
      socket.leave('game:' + prev);
      broadcast(prev);
    }
    socket.on('game:watch', (id, ack) => {
      const reply = typeof ack === 'function' ? ack : () => {};
      const g = typeof id === 'string' ? getGame(id) : null;
      if (!g || !isMember(g, user.id)) return reply({ error: 'not_found' });
      if (socket.data.watching !== id) unwatch();
      socket.data.watching = id;
      socket.join('game:' + id);
      reply({ game: broadcast(id) });
    });
    socket.on('game:unwatch', unwatch);
    socket.on('disconnect', () => {
      if (socket.data.watching) broadcast(socket.data.watching);
    });
  }

  return { router: r, attach };
}

module.exports = { createGames };
