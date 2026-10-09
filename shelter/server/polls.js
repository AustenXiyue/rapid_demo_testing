// 站内投票：挂在 /api/games/:id/polls（由 games.js 挂载，沿用登录与成员检查）。
//
// 主持人发起（事件投票带上事件流程 flow_ref，或通用投票），名单里的座位投票，服务端计票。
// 投票中玩家只看到「已投几人」，结束后才看到各选项票数；谁投了什么只有主持人看得到。
// 「采用结果」时主持人页面先把投票结果写进自己的事件流程（现有的录入投票结果），再告诉服务端最终采用了哪一项。
// 同一个事件流程只保留一个进行中的投票：重新发起时旧的自动取消。暂停时只读。

const crypto = require('node:crypto');
const express = require('express');
const { Refuse, identityOf, guarded } = require('./scope');

const MAX_OPTIONS = 10;

function createPolls(db, io, { loadMember, seatOf }) {
  const r = express.Router({ mergeParams: true });
  const identity = (req, g, as) => identityOf(seatOf, req, g, as);
  const handle = (fn) => guarded(loadMember, fn);
  const parse = (s) => (s ? JSON.parse(s) : null);

  /** 按查看者裁剪：主持人看到完整计票和每个人投了什么；玩家看到自己的票、已投人数，结束后才有各选项票数。 */
  function pollView(p, viewer) {
    const ballots = db.prepare('SELECT seat_id, option_id FROM ballots WHERE poll_id = ? ORDER BY at').all(p.id);
    const voters = parse(p.voters);
    const v = {
      id: p.id, day: p.day, title: p.title, body: p.body || '', options: parse(p.options), voters, flowRef: p.flow_ref,
      status: p.status, result: p.result, at: p.created_at, closedAt: p.closed_at, voted: ballots.length, total: voters.length,
    };
    const counts = {};
    v.options.forEach((o) => { counts[o.id] = 0; });
    ballots.forEach((b) => { counts[b.option_id] = (counts[b.option_id] || 0) + 1; });
    if (viewer === 'host') {
      v.counts = counts;
      v.ballots = ballots.map((b) => ({ seat: b.seat_id, option: b.option_id }));
    } else {
      const mine = ballots.find((b) => b.seat_id === viewer);
      v.myVote = mine ? mine.option_id : null;
      if (p.status !== 'open') v.counts = counts;
    }
    return v;
  }

  // 推给每个人各自能看到的那份：主持人一份（as host），每个在座的玩家一份（as seat）
  function announce(g, p) {
    if (!g.owner_deleted_at) io.to('user:' + g.owner_id).emit('poll:update', { gameId: g.id, as: 'host', poll: pollView(p, 'host') });
    for (const s of db.prepare('SELECT id, user_id FROM seats WHERE game_id = ? AND user_id IS NOT NULL').all(g.id)) {
      io.to('user:' + s.user_id).emit('poll:update', { gameId: g.id, as: 'seat', poll: pollView(p, s.id) });
    }
  }

  function load(g, pid) {
    const p = db.prepare('SELECT * FROM polls WHERE id = ? AND game_id = ?').get(pid, g.id);
    if (!p) throw new Refuse(404, 'not_found');
    return p;
  }

  function setStatus(g, p, status, extra = {}) {
    Object.assign(p, { status }, extra);
    db.prepare('UPDATE polls SET status = ?, result = ?, closed_at = ? WHERE id = ?').run(p.status, p.result, p.closed_at, p.id);
    announce(g, p);
  }

  r.get('/', guarded(loadMember, (req, res, g) => {
    const me = identity(req, g, req.query.as);
    const rows = db.prepare('SELECT * FROM polls WHERE game_id = ? ORDER BY created_at, rowid').all(g.id);
    res.json({ me, polls: rows.map((p) => pollView(p, me)) });
  }, { active: false }));

  r.post('/', handle((req, res, g) => {
    const body = req.body || {};
    if (identity(req, g, body.as) !== 'host') throw new Refuse(403, 'host_only');
    const title = typeof body.title === 'string' ? body.title.trim().slice(0, 100) : '';
    if (!title) throw new Refuse(400, 'bad_title');
    const options = Array.isArray(body.options) ? body.options.map((o, i) => ({
      id: typeof o.id === 'string' && o.id ? o.id.slice(0, 60) : 'o' + (i + 1),
      label: String(o.label || '').trim().slice(0, 100),
    })) : [];
    if (options.length < 2 || options.length > MAX_OPTIONS || options.some((o) => !o.label) || new Set(options.map((o) => o.id)).size !== options.length) {
      throw new Refuse(400, 'bad_options');
    }
    const seats = db.prepare('SELECT id FROM seats WHERE game_id = ?').all(g.id).map((s) => s.id);
    const voters = Array.isArray(body.voters) ? [...new Set(body.voters)] : [];
    if (!voters.length || voters.some((v) => !seats.includes(v))) throw new Refuse(400, 'bad_voters');
    const row = db.prepare('SELECT host_state FROM games WHERE id = ?').get(g.id);
    if (!row.host_state) throw new Refuse(409, 'not_started');
    const day = JSON.parse(row.host_state).day || 0;
    const flowRef = typeof body.flowRef === 'string' && body.flowRef ? body.flowRef.slice(0, 80) : null;
    const now = Date.now();
    if (flowRef) {
      for (const old of db.prepare("SELECT * FROM polls WHERE game_id = ? AND flow_ref = ? AND status = 'open'").all(g.id, flowRef)) {
        setStatus(g, old, 'cancelled', { closed_at: now });
      }
    }
    const p = {
      id: crypto.randomUUID(), game_id: g.id, day, title, body: typeof body.body === 'string' ? body.body.slice(0, 2000) : '',
      options: JSON.stringify(options), voters: JSON.stringify(voters), flow_ref: flowRef, status: 'open', result: null, created_at: now, closed_at: null,
    };
    db.prepare('INSERT INTO polls (id, game_id, day, title, body, options, voters, flow_ref, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(p.id, p.game_id, p.day, p.title, p.body, p.options, p.voters, p.flow_ref, p.status, p.created_at);
    announce(g, p);
    res.json({ poll: pollView(p, 'host') });
  }));

  r.post('/:pid/vote', handle((req, res, g) => {
    const body = req.body || {};
    const me = identity(req, g, body.as);
    const p = load(g, req.params.pid);
    if (p.status !== 'open') throw new Refuse(409, 'poll_closed');
    if (me === 'host' || !parse(p.voters).includes(me)) throw new Refuse(403, 'not_voter');
    if (!parse(p.options).some((o) => o.id === body.option)) throw new Refuse(400, 'bad_option');
    db.prepare('INSERT INTO ballots (poll_id, seat_id, option_id, at) VALUES (?, ?, ?, ?) ON CONFLICT (poll_id, seat_id) DO UPDATE SET option_id = excluded.option_id, at = excluded.at')
      .run(p.id, me, body.option, Date.now());
    announce(g, p);
    res.json({ poll: pollView(p, me) });
  }));

  r.post('/:pid/close', handle((req, res, g) => {
    if (identity(req, g, (req.body || {}).as) !== 'host') throw new Refuse(403, 'host_only');
    const p = load(g, req.params.pid);
    if (p.status !== 'open') throw new Refuse(409, 'poll_closed');
    setStatus(g, p, 'closed', { closed_at: Date.now() });
    res.json({ poll: pollView(p, 'host') });
  }));

  r.post('/:pid/cancel', handle((req, res, g) => {
    if (identity(req, g, (req.body || {}).as) !== 'host') throw new Refuse(403, 'host_only');
    const p = load(g, req.params.pid);
    if (p.status === 'cancelled' || p.result) throw new Refuse(409, 'poll_closed');
    setStatus(g, p, 'cancelled', { closed_at: p.closed_at || Date.now() });
    res.json({ poll: pollView(p, 'host') });
  }));

  // 采用结果：只能在结束后；平票等情况由主持人在页面上选好再传过来
  r.post('/:pid/adopt', handle((req, res, g) => {
    const body = req.body || {};
    if (identity(req, g, body.as) !== 'host') throw new Refuse(403, 'host_only');
    const p = load(g, req.params.pid);
    if (p.status !== 'closed') throw new Refuse(409, 'poll_not_closed');
    if (!parse(p.options).some((o) => o.id === body.option)) throw new Refuse(400, 'bad_option');
    setStatus(g, p, 'closed', { result: body.option });
    res.json({ poll: pollView(p, 'host') });
  }));

  return r;
}

module.exports = { createPolls };
