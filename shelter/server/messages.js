// 私信：主持人与任一座位、座位与座位之间自由收发。挂在 /api/games/:id/messages（由 games.js 挂载，沿用登录与成员检查）。
//
// 身份不是账户：'host'（主持人）或座位 ID。主导兼角色的人有两个身份，分别在主持人面板和玩家面板里收发（请求里的 as）。
// 主持人看不到玩家之间的私信。座位上的私信跟着座位走：座位被释放后，接手的人继续看到，原来的账户看不到。
// 对局暂停时也能发；招募中（还没有面板）和已结束时不能发。

const crypto = require('node:crypto');
const express = require('express');

const TEXT_MAX = 2000;

function createMessages(db, io, { loadMember, seatOf }) {
  const r = express.Router({ mergeParams: true });

  // 请求者要以哪个身份收发；不是自己的身份时已经回了错误，返回 null
  function identity(req, res, g, as) {
    if (as === 'host') {
      if (g.owner_id === req.user.id && !g.owner_deleted_at) return 'host';
    } else if (as === 'seat') {
      const seat = seatOf(g.id, req.user.id);
      if (seat) return seat.id;
    }
    res.status(403).json({ error: 'bad_identity' });
    return null;
  }

  // 某个身份此刻对应的账户（推送用）：主持人＝主导；座位＝坐在上面的人（空座位没有）
  function userOf(g, who) {
    if (who === 'host') return g.owner_deleted_at ? null : g.owner_id;
    const seat = db.prepare('SELECT user_id FROM seats WHERE id = ? AND game_id = ?').get(who, g.id);
    return seat ? seat.user_id : null;
  }

  const view = (m) => ({ id: m.id, from: m.sender, to: m.recipient, text: m.text, at: m.created_at, readAt: m.read_at });

  r.get('/', (req, res) => {
    const g = loadMember(req, res);
    if (!g) return;
    const me = identity(req, res, g, req.query.as);
    if (!me) return;
    const rows = db.prepare(
      'SELECT * FROM messages WHERE game_id = ? AND (sender = ? OR recipient = ?) ORDER BY created_at, rowid'
    ).all(g.id, me, me);
    res.json({ me, messages: rows.map(view) });
  });

  r.post('/', (req, res) => {
    const g = loadMember(req, res);
    if (!g) return;
    const { as, to } = req.body || {};
    const me = identity(req, res, g, as);
    if (!me) return;
    if (g.status === 'lobby') return res.status(409).json({ error: 'not_started' });
    if (g.status === 'finished') return res.status(409).json({ error: 'game_closed' });
    const text = typeof req.body.text === 'string' ? req.body.text.trim() : '';
    if (!text || text.length > TEXT_MAX) return res.status(400).json({ error: 'bad_text' });
    if (typeof to !== 'string' || to === me) return res.status(400).json({ error: 'bad_recipient' });
    const toUser = userOf(g, to);
    if (!toUser) return res.status(404).json({ error: 'no_recipient' });

    const m = { id: crypto.randomUUID(), game_id: g.id, sender: me, recipient: to, text, created_at: Date.now(), read_at: null };
    db.prepare('INSERT INTO messages (id, game_id, sender, recipient, text, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(m.id, m.game_id, m.sender, m.recipient, m.text, m.created_at);
    // 收件人和发件人（自己的其他设备、主导兼角色的另一个面板）都推一份，页面按 from／to 自己判断归哪个收件箱
    const msg = view(m);
    for (const u of new Set([toUser, req.user.id])) io.to('user:' + u).emit('message:new', { gameId: g.id, message: msg });
    res.json({ message: msg });
  });

  // 把某个对话里对方发给我的都标为已读
  r.post('/read', (req, res) => {
    const g = loadMember(req, res);
    if (!g) return;
    const { as, with: other } = req.body || {};
    const me = identity(req, res, g, as);
    if (!me) return;
    const now = Date.now();
    db.prepare('UPDATE messages SET read_at = ? WHERE game_id = ? AND recipient = ? AND sender = ? AND read_at IS NULL')
      .run(now, g.id, me, String(other));
    io.to('user:' + req.user.id).emit('message:read', { gameId: g.id, me, with: String(other), at: now });
    res.json({ ok: true });
  });

  return r;
}

module.exports = { createMessages };
