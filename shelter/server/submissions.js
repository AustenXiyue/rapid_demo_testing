// 玩家提交：挂在 /api/games/:id/submissions（由 games.js 挂载，沿用登录与成员检查）。
//
// 系统只负责送达，主持人「采用」才算数：主持人页面用现有的对话框写自己的存档，再把提交标为 adopted。
// - action  玩家 → 主持人：今天的行动（计划守夜／技能／其他／放弃）。同一天只留最新一份；主持人采用后当天不能再交。
// - watch   玩家 → 主持人：选中的守夜卡片（卡面原样，主持人看到的和玩家选的一样）。同一天只留最新一份。
// - swap    玩家 → 被请求的玩家 → 主持人：换位请求，先由被请求者回答同意／拒绝（asking），再等主持人（pending）。可以有多份。
// - decide  主持人 → 末位：从几份守夜名单里选一份（asking），末位回答后等主持人（pending）。同一天只留最新一份。
// - score   玩家 → 主持人：分数上报（钞票、名画、珠宝件数等）。只留最新一份。
// 天数以主持人存档为准。暂停时只读；主持人能看到全部提交，玩家只看到自己发的和发给自己的。

const crypto = require('node:crypto');
const express = require('express');
const { Refuse, identityOf, guarded, usersOf } = require('./scope');

const ACTION_TYPES = ['plan', 'skill', 'other', 'pass'];
const SINGLE = ['action', 'watch', 'decide', 'score']; // 同一天（同一个发起人）只留最新一份的类型
const OPEN = ['asking', 'pending'];

function createSubmissions(db, io, { loadMember, seatOf }) {
  const r = express.Router({ mergeParams: true });
  const identity = (req, g, as) => identityOf(seatOf, req, g, as);
  const handle = (fn) => guarded(loadMember, fn);

  const parse = (s) => (s ? JSON.parse(s) : null);
  const view = (x) => ({
    id: x.id, from: x.sender, to: x.recipient, kind: x.kind, day: x.day, payload: parse(x.payload), answer: parse(x.answer),
    note: x.note || '', status: x.status, at: x.created_at, answeredAt: x.answered_at, resolvedAt: x.resolved_at,
  });

  // 推给：发起方、对方、主持人（主持人能看到全部）
  function announce(g, x) {
    const v = view(x);
    for (const u of usersOf(db, g, [x.sender, x.recipient])) io.to('user:' + u).emit('submission:update', { gameId: g.id, submission: v });
    return v;
  }

  function hostDay(g) {
    const row = db.prepare('SELECT host_state FROM games WHERE id = ?').get(g.id);
    if (!row || !row.host_state) throw new Refuse(409, 'not_started');
    return JSON.parse(row.host_state).day || 0;
  }

  function setStatus(g, x, status, extra = {}) {
    Object.assign(x, { status }, extra);
    db.prepare('UPDATE submissions SET status = ?, answer = ?, note = ?, answered_at = ?, resolved_at = ? WHERE id = ?')
      .run(x.status, x.answer, x.note, x.answered_at, x.resolved_at, x.id);
    return announce(g, x);
  }

  function occupied(g, seatId) {
    const seat = db.prepare('SELECT user_id FROM seats WHERE id = ? AND game_id = ?').get(seatId, g.id);
    return !!(seat && seat.user_id);
  }

  r.get('/', guarded(loadMember, (req, res, g) => {
    const me = identity(req, g, req.query.as);
    const rows = me === 'host'
      ? db.prepare('SELECT * FROM submissions WHERE game_id = ? ORDER BY created_at, rowid').all(g.id)
      : db.prepare('SELECT * FROM submissions WHERE game_id = ? AND (sender = ? OR recipient = ?) ORDER BY created_at, rowid').all(g.id, me, me);
    res.json({ me, submissions: rows.map(view) });
  }, { active: false }));

  r.post('/', handle((req, res, g) => {
    const body = req.body || {};
    const me = identity(req, g, body.as);
    const kind = body.kind;
    const p = body.payload && typeof body.payload === 'object' ? body.payload : {};
    const day = hostDay(g);
    let to = 'host';
    let status = 'pending';
    let payload;
    if (kind === 'decide') {
      if (me !== 'host') throw new Refuse(403, 'host_only');
      if (typeof body.to !== 'string' || !occupied(g, body.to)) throw new Refuse(404, 'no_recipient');
      if (!Array.isArray(p.options) || p.options.length < 2 || p.options.length > 20 || !Array.isArray(p.candidateIds) || p.candidateIds.length !== p.options.length) throw new Refuse(400, 'bad_payload');
      payload = { options: p.options.map((o) => String(o).slice(0, 500)), candidateIds: p.candidateIds.map(String) };
      to = body.to;
      status = 'asking';
    } else {
      if (me === 'host') throw new Refuse(403, 'seat_only');
      if (kind === 'action') {
        if (!ACTION_TYPES.includes(p.type)) throw new Refuse(400, 'bad_payload');
        const adopted = db.prepare("SELECT 1 FROM submissions WHERE game_id = ? AND sender = ? AND kind = 'action' AND day = ? AND status = 'adopted'").get(g.id, me, day);
        if (adopted) throw new Refuse(409, 'already_adopted');
        payload = { type: p.type, note: typeof p.note === 'string' ? p.note.slice(0, 200) : '' };
      } else if (kind === 'watch') {
        if (!p.card || typeof p.card !== 'object' || JSON.stringify(p.card).length > 5000) throw new Refuse(400, 'bad_payload');
        payload = { card: p.card, from: typeof p.from === 'string' ? p.from.slice(0, 40) : '' };
      } else if (kind === 'swap') {
        if (typeof body.to !== 'string' || body.to === me || !occupied(g, body.to)) throw new Refuse(404, 'no_recipient');
        to = body.to;
        status = 'asking';
        payload = {};
      } else if (kind === 'score') {
        const n = (v) => (Number.isInteger(v) && v >= 0 ? v : null);
        payload = { cash: n(p.cash), painting: n(p.painting), jewel: n(p.jewel), mapNotes: n(p.mapNotes), text: typeof p.text === 'string' ? p.text.slice(0, 1000) : '' };
      } else {
        throw new Refuse(400, 'bad_kind');
      }
    }
    const now = Date.now();
    // 同一天只留最新一份：旧的（还没被处理的）自动撤回
    if (SINGLE.includes(kind)) {
      const old = db.prepare(`SELECT * FROM submissions WHERE game_id = ? AND sender = ? AND kind = ? AND status IN ('asking', 'pending')${kind === 'score' ? '' : ' AND day = ?'}`)
        .all(...(kind === 'score' ? [g.id, me, kind] : [g.id, me, kind, day]));
      old.forEach((x) => setStatus(g, x, 'withdrawn', { resolved_at: now }));
    }
    const x = {
      id: crypto.randomUUID(), game_id: g.id, sender: me, recipient: to, kind, day, payload: JSON.stringify(payload),
      answer: null, note: null, status, created_at: now, answered_at: null, resolved_at: null,
    };
    db.prepare(`INSERT INTO submissions (id, game_id, sender, recipient, kind, day, payload, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(x.id, x.game_id, x.sender, x.recipient, x.kind, x.day, x.payload, x.status, x.created_at);
    res.json({ submission: announce(g, x) });
  }));

  function load(g, sid) {
    const x = db.prepare('SELECT * FROM submissions WHERE id = ? AND game_id = ?').get(sid, g.id);
    if (!x) throw new Refuse(404, 'not_found');
    if (!OPEN.includes(x.status)) throw new Refuse(409, 'already_resolved');
    return x;
  }

  // 对方回答：换位同意／拒绝；末位选第几份
  r.post('/:sid/answer', handle((req, res, g) => {
    const body = req.body || {};
    const me = identity(req, g, body.as);
    const x = load(g, req.params.sid);
    if (x.recipient !== me || x.status !== 'asking') throw new Refuse(403, 'not_recipient');
    let answer;
    if (x.kind === 'swap') {
      if (typeof body.accepted !== 'boolean') throw new Refuse(400, 'bad_answer');
      answer = { accepted: body.accepted };
    } else {
      const n = parse(x.payload).options.length;
      if (!Number.isInteger(body.index) || body.index < 0 || body.index >= n) throw new Refuse(400, 'bad_answer');
      answer = { index: body.index };
    }
    res.json({ submission: setStatus(g, x, 'pending', { answer: JSON.stringify(answer), answered_at: Date.now() }) });
  }));

  // 主持人采用（页面已经把它写进了主持人存档）或忽略（可附一句话）；对方还没回答时主持人也可以直接处理
  for (const [path, status] of [['adopt', 'adopted'], ['dismiss', 'dismissed']]) {
    r.post('/:sid/' + path, handle((req, res, g) => {
      const body = req.body || {};
      if (identity(req, g, body.as) !== 'host') throw new Refuse(403, 'host_only');
      const x = load(g, req.params.sid);
      const note = typeof body.note === 'string' ? body.note.trim().slice(0, 500) : x.note;
      res.json({ submission: setStatus(g, x, status, { note, resolved_at: Date.now() }) });
    }));
  }

  r.post('/:sid/withdraw', handle((req, res, g) => {
    const me = identity(req, g, (req.body || {}).as);
    const x = load(g, req.params.sid);
    if (x.sender !== me) throw new Refuse(403, 'not_sender');
    res.json({ submission: setStatus(g, x, 'withdrawn', { resolved_at: Date.now() }) });
  }));

  return r;
}

module.exports = { createSubmissions };
