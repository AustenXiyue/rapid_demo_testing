// 交接单（物品流转）：挂在 /api/games/:id/transfers（由 games.js 挂载，沿用登录与成员检查）。
//
// 服务器权威：发起时服务端立刻从发起方扣下物品（托管）；对方「接收」才入库，「拒收」或发起方「撤回」原样退回。
// 涉及的存档（发起方、收件方、公共池所在的主持人存档）都由服务端在同一个事务里改，版本号 +1，再推给各自的设备。
// - 身份同私信：'host' 或座位 ID；收件方 'host' 表示交给公共池。
// - 玩家之间可以交易（wants）：接收方在接收时从自己库存里选出对方要的物品，两边同时换手，要么都成、要么都不成。
// - 主持人发出的物品来源：pool 公共池（托管）｜batch 补给批次里已选的那件（拒收时撤回这次选择）｜none 凭空给予。
// - 已确认携带的物品不能转出；只有对局进行中可以发起和处理（暂停时只读）。主持人能看到全部交接记录。

const crypto = require('node:crypto');
const express = require('express');
const C = require('../src/shared/core.js');

const KINDS_FROM_HOST = ['supply', 'opening', 'grant'];
const MAX_LINES = 30;

function createTransfers(db, io, { loadMember, seatOf, pushPublic }) {
  const r = express.Router({ mergeParams: true });

  class Refuse extends Error {
    constructor(status, code, detail) { super(code); this.status = status; this.code = code; this.detail = detail; }
  }

  function identity(req, g, as) {
    if (as === 'host' && g.owner_id === req.user.id && !g.owner_deleted_at) return 'host';
    if (as === 'seat') {
      const seat = seatOf(g.id, req.user.id);
      if (seat) return seat.id;
    }
    throw new Refuse(403, 'bad_identity');
  }

  // ---------------------------------------------------------------- 存档读写

  // docs：本次请求里要改的存档，按身份缓存；最后 saveDocs 一次性写回
  function loadDoc(g, docs, who) {
    if (docs[who]) return docs[who];
    if (who === 'host') {
      const row = db.prepare('SELECT host_state AS state, host_version AS version FROM games WHERE id = ?').get(g.id);
      if (!row || !row.state) throw new Refuse(409, 'not_started');
      docs[who] = { kind: 'host', who, version: row.version, state: JSON.parse(row.state), user: g.owner_deleted_at ? null : g.owner_id };
    } else {
      const row = db.prepare('SELECT state, version, user_id FROM seats WHERE id = ? AND game_id = ?').get(who, g.id);
      if (!row || !row.state) throw new Refuse(404, 'no_recipient');
      docs[who] = { kind: 'seat', who, version: row.version, state: JSON.parse(row.state), user: row.user_id };
    }
    docs[who].changed = false;
    return docs[who];
  }

  function nameOf(g, who) {
    if (who === 'host') return '主持人';
    const row = db.prepare('SELECT s.seat_no, u.username FROM seats s LEFT JOIN users u ON u.id = s.user_id WHERE s.id = ? AND s.game_id = ?').get(who, g.id);
    return row ? (row.username || '座位 ' + row.seat_no) : '（已删除的座位）';
  }

  function log(doc, text) {
    const s = doc.state;
    const entry = doc.kind === 'host'
      ? { id: C.uid('log'), at: Date.now(), day: s.day, phase: s.phase, text, secret: true }
      : { id: C.uid('log'), at: Date.now(), day: s.publicInfo ? s.publicInfo.day : null, text };
    s.log.unshift(entry);
    doc.changed = true;
  }

  // 自定义物品的定义跟着物品走：收件方没有这个定义时补上
  function mergeDefs(state, defs) {
    (defs || []).forEach((d) => { if (!state.customItems.some((x) => x.id === d.id)) state.customItems.push(d); });
  }
  const defsFor = (state, entries) => state.customItems.filter((d) => entries.some((e) => e.defId === d.id));
  const describe = (entries, state, defs) => entries.map((e) => C.describeEntry(e, (state.customItems || []).concat(defs || []))).join('、');

  // 从玩家库存取物品：已确认携带的不能动
  function takeFromInventory(doc, picks) {
    const lo = doc.state.loadout;
    if (lo && lo.confirmed && picks.some((p) => lo.items.some((x) => x.entryId === p.entryId))) throw new Refuse(409, 'in_loadout');
    const out = take(doc.state.inventory, picks);
    C.syncLoadout(doc.state);
    doc.changed = true;
    return out;
  }
  function take(list, picks) {
    try { return C.takeEntries(list, picks); } catch (e) { throw new Refuse(409, 'not_enough', e.message); }
  }

  function receive(doc, entries, defs) {
    if (doc.kind === 'host') {
      mergeDefs(doc.state, defs);
      C.receiveEntries(doc.state.pool, entries, { customItems: doc.state.customItems });
    } else {
      mergeDefs(doc.state, defs);
      C.receiveEntries(doc.state.inventory, entries, { customItems: doc.state.customItems });
    }
    doc.changed = true;
  }

  function saveDocs(g, docs, transferRows) {
    const now = Date.now();
    db.exec('BEGIN');
    try {
      for (const doc of Object.values(docs)) {
        if (!doc.changed) continue;
        doc.state.updatedAt = now;
        doc.version += 1;
        if (doc.kind === 'host') db.prepare('UPDATE games SET host_state = ?, host_version = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(doc.state), doc.version, now, g.id);
        else db.prepare('UPDATE seats SET state = ?, version = ? WHERE id = ?').run(JSON.stringify(doc.state), doc.version, doc.who);
      }
      transferRows();
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
    for (const doc of Object.values(docs)) {
      if (!doc.changed) continue;
      if (doc.user) io.to('user:' + doc.user).emit('state:update', { gameId: g.id, kind: doc.kind, version: doc.version, state: doc.state, reason: 'transfer' });
      if (doc.kind === 'host') pushPublic(g.id, doc.state);
    }
  }

  // ---------------------------------------------------------------- 交接单

  const parse = (s) => (s ? JSON.parse(s) : null);
  function view(t) {
    return {
      id: t.id, from: t.sender, to: t.recipient, kind: t.kind, source: t.source.split(':')[0],
      items: parse(t.items), wants: parse(t.wants), given: parse(t.given), defs: parse(t.defs) || [], note: t.note || '',
      status: t.status, at: t.created_at, resolvedAt: t.resolved_at, resolvedBy: t.resolved_by,
    };
  }

  // 交接单变化推给：发起方、收件方、主持人（主持人能看到全部记录）
  function announce(g, t) {
    const users = new Set([g.owner_deleted_at ? null : g.owner_id]);
    for (const who of [t.sender, t.recipient]) {
      if (who === 'host') continue;
      const seat = db.prepare('SELECT user_id FROM seats WHERE id = ?').get(who);
      if (seat) users.add(seat.user_id);
    }
    const v = view(t);
    for (const u of users) if (u) io.to('user:' + u).emit('transfer:update', { gameId: g.id, transfer: v });
    return v;
  }

  function lines(list, field) {
    if (!Array.isArray(list) || !list.length || list.length > MAX_LINES) return null;
    for (const x of list) if (!x || !Number.isInteger(x.qty) || x.qty <= 0 || typeof x[field] !== 'string' || !x[field]) return null;
    return list.map((x) => ({ [field]: x[field], qty: x.qty }));
  }

  // 统一处理：检查对局、身份，出错时按 Refuse 回应
  function handle(fn) {
    return (req, res) => {
      const g = loadMember(req, res);
      if (!g) return;
      try {
        if (g.status !== 'active') throw new Refuse(409, 'read_only');
        fn(req, res, g);
      } catch (e) {
        if (!(e instanceof Refuse)) throw e;
        res.status(e.status).json({ error: e.code, detail: e.detail });
      }
    };
  }

  r.get('/', (req, res) => {
    const g = loadMember(req, res);
    if (!g) return;
    let me;
    try { me = identity(req, g, req.query.as); } catch (e) { return res.status(e.status).json({ error: e.code }); }
    const rows = me === 'host'
      ? db.prepare('SELECT * FROM transfers WHERE game_id = ? ORDER BY created_at, rowid').all(g.id)
      : db.prepare('SELECT * FROM transfers WHERE game_id = ? AND (sender = ? OR recipient = ?) ORDER BY created_at, rowid').all(g.id, me, me);
    res.json({ me, transfers: rows.map(view) });
  });

  r.post('/', handle((req, res, g) => {
    const body = req.body || {};
    const me = identity(req, g, body.as);
    const to = body.to;
    if (typeof to !== 'string' || to === me) throw new Refuse(400, 'bad_recipient');
    if (to !== 'host') {
      const seat = db.prepare('SELECT user_id FROM seats WHERE id = ? AND game_id = ?').get(to, g.id);
      if (!seat || !seat.user_id) throw new Refuse(404, 'no_recipient');
    }
    const note = typeof body.note === 'string' ? body.note.trim().slice(0, 500) : '';
    const docs = {};
    const from = loadDoc(g, docs, me);
    let items; let kind; let source; let wants = null;

    if (me !== 'host') {
      const give = lines(body.give, 'entryId');
      if (!give) throw new Refuse(400, 'bad_items');
      if (body.wants != null) {
        wants = lines(body.wants, 'defId');
        if (!wants || to === 'host') throw new Refuse(400, 'bad_wants');
      }
      items = takeFromInventory(from, give);
      kind = to === 'host' ? (body.kind === 'scavenge' ? 'scavenge' : 'pool') : wants ? 'trade' : 'gift';
      source = 'inventory';
    } else {
      kind = KINDS_FROM_HOST.includes(body.kind) ? body.kind : 'grant';
      if (body.source === 'pool') {
        const give = lines(body.give, 'defId') || lines(body.give, 'entryId');
        if (!give) throw new Refuse(400, 'bad_items');
        items = take(from.state.pool, give);
        from.changed = true;
        source = 'pool';
      } else if (body.source === 'none') {
        const grant = lines(body.give, 'defId');
        if (!grant) throw new Refuse(400, 'bad_items');
        items = [];
        grant.forEach((x) => C.addItem(items, x.defId, x.qty, { customItems: from.state.customItems, rules: from.state.rules }));
        source = 'none';
      } else if (body.source === 'batch') {
        // 补给批次里已经记录的选择：物品在主持人记录选择时已经离开公共池，这里只登记，不重复扣
        const batch = (from.state.batches || []).find((b) => b.id === body.batchId);
        const pick = batch && batch.picks.find((p) => p.playerId === to && p.piece.id === body.pieceId);
        if (!pick) throw new Refuse(404, 'no_pick');
        const dup = db.prepare("SELECT 1 FROM transfers WHERE game_id = ? AND source = ? AND status IN ('pending', 'accepted') AND items LIKE ?")
          .get(g.id, 'batch:' + batch.id, '%"' + pick.piece.id + '"%');
        if (dup) throw new Refuse(409, 'already_sent');
        items = [C.clone(pick.piece)];
        source = 'batch:' + batch.id;
      } else {
        throw new Refuse(400, 'bad_source');
      }
    }

    const t = {
      id: crypto.randomUUID(), game_id: g.id, sender: me, recipient: to, kind, source,
      items: JSON.stringify(items), wants: wants ? JSON.stringify(wants) : null, given: null,
      defs: JSON.stringify(defsFor(from.state, items)), note, status: 'pending', created_at: Date.now(), resolved_at: null, resolved_by: null,
    };
    log(from, '发出交接（待 ' + nameOf(g, to) + (to === 'host' ? '・公共池' : '') + ' 确认）：' + describe(items, from.state) + (wants ? '；换取 ' + C.formatItemList(wants, from.state.customItems) : ''));
    saveDocs(g, docs, () => {
      db.prepare(`INSERT INTO transfers (id, game_id, sender, recipient, kind, source, items, wants, given, defs, note, status, created_at)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(t.id, t.game_id, t.sender, t.recipient, t.kind, t.source, t.items, t.wants, t.given, t.defs, t.note, t.status, t.created_at);
    });
    res.json({ transfer: announce(g, t) });
  }));

  function loadPending(g, tid) {
    const t = db.prepare('SELECT * FROM transfers WHERE id = ? AND game_id = ?').get(tid, g.id);
    if (!t) throw new Refuse(404, 'not_found');
    if (t.status !== 'pending') throw new Refuse(409, 'already_resolved');
    return t;
  }

  function finish(g, docs, t, status, me, extra = {}) {
    Object.assign(t, { status, resolved_at: Date.now(), resolved_by: me }, extra);
    saveDocs(g, docs, () => {
      db.prepare('UPDATE transfers SET status = ?, resolved_at = ?, resolved_by = ?, given = ? WHERE id = ?')
        .run(t.status, t.resolved_at, t.resolved_by, t.given, t.id);
    });
    return announce(g, t);
  }

  r.post('/:tid/accept', handle((req, res, g) => {
    const body = req.body || {};
    const me = identity(req, g, body.as);
    const t = loadPending(g, req.params.tid);
    if (t.recipient !== me) throw new Refuse(403, 'not_recipient');
    const docs = {};
    const items = parse(t.items);
    const defs = parse(t.defs);
    const to = loadDoc(g, docs, me);
    let given = null;
    if (t.wants) {
      // 交易：接收方交出对方要的物品（种类和数量要对得上），两边同时换手
      const give = lines(body.give, 'entryId');
      if (!give) throw new Refuse(400, 'bad_items');
      given = takeFromInventory(to, give);
      const sum = (list) => list.reduce((m, x) => Object.assign(m, { [x.defId]: (m[x.defId] || 0) + x.qty }), {});
      const want = sum(parse(t.wants));
      const got = sum(given);
      if (Object.keys(want).length !== Object.keys(got).length || Object.keys(want).some((k) => want[k] !== got[k])) throw new Refuse(409, 'wants_mismatch');
      const back = loadDoc(g, docs, t.sender);
      receive(back, given, defsFor(to.state, given));
      log(back, '交易完成：从 ' + nameOf(g, me) + ' 换来 ' + describe(given, back.state));
    }
    receive(to, items, defs);
    log(to, (t.recipient === 'host' ? '接收入池（来自 ' : '接收（来自 ') + nameOf(g, t.sender) + '）：' + describe(items, to.state, defs) + (given ? '；交出 ' + describe(given, to.state) : ''));
    res.json({ transfer: finish(g, docs, t, 'accepted', me, { given: given ? JSON.stringify(given) : null }) });
  }));

  // 拒收与撤回：物品退回来源
  function giveBack(g, docs, t) {
    const items = parse(t.items);
    const [source, batchId] = t.source.split(':');
    if (source === 'inventory') {
      const back = loadDoc(g, docs, t.sender);
      receive(back, items, parse(t.defs));
      log(back, '交接未成（' + nameOf(g, t.recipient) + '）：物品退回库存：' + describe(items, back.state));
    } else if (source === 'pool' || source === 'batch') {
      const host = loadDoc(g, docs, 'host');
      const batch = source === 'batch' && host.state.batches.find((b) => b.id === batchId);
      const pick = batch && batch.status === 'open' && batch.picks.find((p) => p.playerId === t.recipient && p.piece.id === items[0].id);
      if (pick) {
        // 补给批次还开着：撤回这次选择，物品回到本批候选，玩家可以重新选
        C.unpickFromBatch(batch, t.recipient);
        log(host, '补给未领取（' + nameOf(g, t.recipient) + '）：撤回选择，物品回到 ' + batch.label + ' 的候选');
      } else {
        receive(host, items, parse(t.defs));
        log(host, '交接未成（' + nameOf(g, t.recipient) + '）：物品回到公共池：' + describe(items, host.state));
      }
    }
  }

  r.post('/:tid/reject', handle((req, res, g) => {
    const me = identity(req, g, (req.body || {}).as);
    const t = loadPending(g, req.params.tid);
    if (t.recipient !== me) throw new Refuse(403, 'not_recipient');
    const docs = {};
    giveBack(g, docs, t);
    res.json({ transfer: finish(g, docs, t, 'rejected', me) });
  }));

  r.post('/:tid/cancel', handle((req, res, g) => {
    const me = identity(req, g, (req.body || {}).as);
    const t = loadPending(g, req.params.tid);
    if (t.sender !== me) throw new Refuse(403, 'not_sender');
    const docs = {};
    giveBack(g, docs, t);
    res.json({ transfer: finish(g, docs, t, 'cancelled', me) });
  }));

  return r;
}

module.exports = { createTransfers };
