// 交接单、玩家提交、投票共用的小工具：错误、身份、对局状态检查、推送对象。
//
// 身份不是账户：'host'（主持人）或座位 ID。请求里用 as 说明以哪个身份操作（主导兼角色的人两个身份都有）。

class Refuse extends Error {
  constructor(status, code, detail) {
    super(code);
    this.status = status;
    this.code = code;
    this.detail = detail;
  }
}

/** 请求者以 as 身份操作：主持人＝主导（且没删除对局）；seat＝自己的座位。不是自己的身份时抛 Refuse。 */
function identityOf(seatOf, req, g, as) {
  if (as === 'host' && g.owner_id === req.user.id && !g.owner_deleted_at) return 'host';
  if (as === 'seat') {
    const seat = seatOf(g.id, req.user.id);
    if (seat) return seat.id;
  }
  throw new Refuse(403, 'bad_identity');
}

/**
 * 路由包装：先确认是成员（loadMember 已回应 404 时直接结束），默认还要求对局进行中（暂停时只读）；
 * fn 里抛出的 Refuse 统一回应成 { error, detail }，其他错误照常交给 Express。
 */
function guarded(loadMember, fn, { active = true } = {}) {
  return (req, res) => {
    const g = loadMember(req, res);
    if (!g) return;
    try {
      if (active && g.status !== 'active') throw new Refuse(409, 'read_only');
      fn(req, res, g);
    } catch (e) {
      if (!(e instanceof Refuse)) throw e;
      res.status(e.status).json({ error: e.code, detail: e.detail });
    }
  };
}

/** 这些身份此刻对应的账户，加上主持人（主持人能看到全部记录）。 */
function usersOf(db, g, whos) {
  const users = new Set();
  if (!g.owner_deleted_at) users.add(g.owner_id);
  for (const who of whos) {
    if (who === 'host') continue;
    const seat = db.prepare('SELECT user_id FROM seats WHERE id = ?').get(who);
    if (seat && seat.user_id) users.add(seat.user_id);
  }
  return users;
}

module.exports = { Refuse, identityOf, guarded, usersOf };
