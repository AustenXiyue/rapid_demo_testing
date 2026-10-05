// 共享核心的单元测试：对照说明第15页「必须通过的功能验收」里与逻辑相关的条目。
// 运行：node --test shelter/tests/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const C = require('../src/shared/core.js');

function hostWithPlayers(ids) {
  const s = C.newHostState();
  s.players = ids.map((id) => ({ id, name: id, alive: true }));
  s.seatOrder = ids.slice();
  s.started = true;
  s.day = 1;
  s.phase = 'night';
  return s;
}

test('物品字典：占位以 ticks 保存，1 tick = 0.5 单位', () => {
  assert.equal(C.getDef('water').capacityTicks, 1);
  assert.equal(C.getDef('medkit').capacityTicks, 2);
  assert.equal(C.getDef('painting').capacityTicks, 4);
  assert.equal(C.fmtUnits(7), '3.5');
  assert.equal(C.fmtUnits(20), '10');
  assert.equal(C.fmtUnits(null), '待配置');
});

test('6人抽6件，不是6单位；选择后不能再次选同一件；公共池总量正确', () => {
  const pool = [];
  C.addItem(pool, 'painting', 3); // 每件2单位
  C.addItem(pool, 'bread', 5);
  C.addItem(pool, 'energy_bar', 2);
  const before = C.countPieces(pool);
  assert.equal(before, 10);
  const ids = ['A', 'B', 'C', 'D', 'E', 'F'];
  const res = C.createBatch(pool, { participantIds: ids, seatOrder: ids, rng: C.seededRng(7) });
  assert.ok(res.ok);
  assert.equal(res.batch.items.length, 6, '按件数抽 6 件');
  assert.equal(C.countPieces(pool), before - 6, '抽到的物品从公共池扣除');

  const first = res.batch.items[0].id;
  assert.ok(C.pickFromBatch(res.batch, 'A', first).ok);
  const again = C.pickFromBatch(res.batch, 'B', first);
  assert.equal(again.ok, false, '被选走的物品不能再被选');
  assert.equal(C.pickFromBatch(res.batch, 'A', res.batch.items[0].id).ok, false, '同一人不能领两次');

  const inBatch = res.batch.items.length + res.batch.picks.length;
  assert.equal(C.countPieces(pool) + inBatch, before, '池 + 批次候选 + 已领取 = 原总量');
});

test('公共池不足时不生成不存在的物资', () => {
  const pool = [];
  C.addItem(pool, 'water', 2);
  const res = C.createBatch(pool, { participantIds: ['A', 'B', 'C'] });
  assert.equal(res.ok, false);
  assert.equal(res.available, 2);
  assert.equal(C.countPieces(pool), 2, '失败时公共池不变');
});

test('撤销整个分配批次：准确归还，含已领取的件，并列出需手动撤销的人', () => {
  const pool = [];
  C.addItem(pool, 'bread', 2);
  C.addItem(pool, 'energy_bar', 1);
  pool.find((e) => e.defId === 'energy_bar').uses = 1;
  const snapshot = JSON.stringify(pool.map((e) => [e.defId, e.qty, e.uses]).sort());
  const res = C.createBatch(pool, { participantIds: ['A', 'B', 'C'], rng: C.seededRng(1) });
  C.pickFromBatch(res.batch, 'A', res.batch.items[0].id);
  const undo = C.undoBatch(pool, res.batch);
  assert.ok(undo.ok);
  assert.deepEqual(undo.takers.map((t) => t.playerId), ['A']);
  assert.equal(JSON.stringify(pool.map((e) => [e.defId, e.qty, e.uses]).sort()), snapshot, '能量棒的剩余次数原样归还');
  assert.equal(C.undoBatch(pool, res.batch).ok, false, '不能重复撤销');
});

test('默认按每件等概率；权重可改', () => {
  const pool = [];
  C.addItem(pool, 'bread', 1);
  C.addItem(pool, 'water', 1);
  const res = C.drawPieces(pool, 1, { weights: { bread: 0 }, rng: C.seededRng(3) });
  assert.ok(res.ok);
  assert.equal(res.pieces[0].defId, 'water');
});

test('10单位个人库存与4单位搜刮保留分别计算；旧库存不被强制压到4', () => {
  const rules = C.defaultRules();
  assert.equal(rules.inventoryCapacityTicks, 20);
  assert.equal(rules.scavengeKeepTicks, 8);
  const inv = [];
  C.addItem(inv, 'painting', 2); // 4单位
  C.addItem(inv, 'medkit', 1); // 1单位
  const invTicks = C.listTicks(inv, [], rules);
  assert.equal(invTicks, 10, '旧库存5单位，超过4也不受影响');
  const ok = C.checkScavengeKeep([{ defId: 'axe', qty: 2 }, { defId: 'medkit', qty: 2 }], invTicks, 0, rules, []);
  assert.equal(ok.keepTicks, 8);
  assert.equal(ok.keepOver, false, '自留恰好4单位');
  assert.equal(ok.inventoryOver, false);
  const over = C.checkScavengeKeep([{ defId: 'axe', qty: 2 }, { defId: 'medkit', qty: 2 }, { defId: 'bread', qty: 1 }], invTicks, 0, rules, []);
  assert.equal(over.keepOver, true, '自留超过4单位');
  const full = C.checkScavengeKeep([{ defId: 'painting', qty: 2 }], 18, 0, rules, []);
  assert.equal(full.keepOver, false);
  assert.equal(full.inventoryOver, true, '总库存单独检查');
  const transfer = C.checkScavengeKeep([{ defId: 'painting', qty: 2 }], 18, 6, rules, []);
  assert.equal(transfer.inventoryOver, false, '旧物品转出只减少库存占用');
  assert.equal(transfer.keepTicks, 8, '旧物品不算进本次所得');
});

test('能量棒：实例独立，1次与3次剩余不会合并；整件未用完仍占0.5', () => {
  const inv = [];
  const [a] = C.addItem(inv, 'energy_bar', 1);
  const [b] = C.addItem(inv, 'energy_bar', 1);
  a.uses = 1;
  assert.equal(inv.length, 2);
  assert.equal(b.uses, 3);
  assert.equal(C.listTicks(inv, [], C.defaultRules()), 2);
  C.addItem(inv, 'bread', 1);
  C.addItem(inv, 'bread', 2);
  assert.equal(inv.filter((e) => e.defId === 'bread').length, 1, '普通同类物品叠加');
});

test('地图笔记、水壶水量、背心状态在导出导入后完整恢复', () => {
  const s = C.newPlayerState();
  const [map] = C.addItem(s.inventory, 'map', 1);
  map.notes.push({ text: '北门有补给车', day: 2 });
  const [canteen] = C.addItem(s.inventory, 'canteen', 1);
  canteen.water = 2;
  const [vest] = C.addItem(s.inventory, 'vest', 1);
  vest.condition = 'damaged';
  const restored = JSON.parse(JSON.stringify(s));
  assert.ok(C.validateSave(restored, 'shelter-player').ok);
  const n = C.normalizeSave(restored, 'shelter-player');
  assert.equal(n.inventory.find((e) => e.defId === 'map').notes[0].text, '北门有补给车');
  assert.equal(n.inventory.find((e) => e.defId === 'canteen').water, 2);
  assert.equal(n.inventory.find((e) => e.defId === 'vest').condition, 'damaged');
});

test('水壶内的水：未配置占位时容量计算标为待定', () => {
  const rules = C.defaultRules();
  const inv = [];
  const [c] = C.addItem(inv, 'canteen', 1);
  assert.equal(C.canteenCapacityPending(inv, rules), false);
  c.water = 1;
  assert.equal(C.canteenCapacityPending(inv, rules), true);
  assert.equal(C.listTicks(inv, [], rules), 2, '未配置时只算水壶本身');
  rules.canteenWaterTicks = 1;
  assert.equal(C.listTicks(inv, [], rules), 3);
  assert.equal(C.canteenCapacityPending(inv, rules), false);
});

test('每日轮换只执行一次：末位移到首位', () => {
  const s = hostWithPlayers(['A', 'B', 'C', 'D', 'E', 'F']);
  assert.ok(C.applyRotation(s).ok);
  assert.deepEqual(s.seatOrder, ['F', 'A', 'B', 'C', 'D', 'E']);
  assert.equal(C.applyRotation(s).ok, false);
  assert.deepEqual(s.seatOrder, ['F', 'A', 'B', 'C', 'D', 'E']);
});

test('说明里的例子：A 与 E 换位只改 seatOrder，行动仍按 actionOrder，拍板者变成 A', () => {
  const s = hostWithPlayers(['A', 'B', 'C', 'D', 'E', 'F']);
  C.applyRotation(s);
  C.beginActions(s);
  assert.deepEqual(s.today.actionOrder, ['F', 'A', 'B', 'C', 'D', 'E']);
  C.recordAction(s, 'F', { type: 'pass' });
  const r = C.requestSwap(s, { fromId: 'A', toId: 'E', accepted: true, ends: true });
  assert.ok(r.ok);
  assert.deepEqual(s.seatOrder, ['F', 'E', 'B', 'C', 'D', 'A']);
  assert.deepEqual(s.today.actionOrder, ['F', 'A', 'B', 'C', 'D', 'E'], 'actionOrder 不变');
  assert.equal(C.nextActor(s.today.actionOrder, s.today.actedIds), 'B', '不会让人重复行动或漏行动');
  assert.equal(C.lastSeat(s.seatOrder), 'A', '最终名单决定者取 seatOrder 末位');
});

test('换位请求上限3次，主持人可覆盖；拒绝不改座次；被请求者是否耗行动须显式指定', () => {
  const s = hostWithPlayers(['A', 'B', 'C']);
  C.beginActions(s);
  for (let i = 0; i < 3; i++) {
    const r = C.requestSwap(s, { fromId: 'A', toId: 'B', accepted: false, ends: false });
    assert.ok(r.ok);
  }
  assert.deepEqual(s.seatOrder, ['A', 'B', 'C'], '被拒绝不换位');
  assert.equal(s.today.actedIds.includes('A'), false, '失败是否耗行动由主持人决定');
  const fourth = C.requestSwap(s, { fromId: 'A', toId: 'C', accepted: true, ends: true });
  assert.equal(fourth.ok, false);
  assert.equal(fourth.limitReached, true);
  const forced = C.requestSwap(s, { fromId: 'A', toId: 'C', accepted: true, ends: true, override: true });
  assert.ok(forced.ok);
  assert.equal(s.today.actedIds.includes('C'), false, '默认不扣被请求者的行动');
});

test('回退再进入个人行动时，已有人行动则保留原 actionOrder', () => {
  const s = hostWithPlayers(['A', 'B', 'C']);
  C.beginActions(s);
  C.recordAction(s, 'A', { type: 'other' });
  s.seatOrder = ['C', 'B', 'A'];
  const again = C.beginActions(s);
  assert.equal(again.kept, true);
  assert.deepEqual(s.today.actionOrder, ['A', 'B', 'C']);
});

test('换位请求后（行动未结束）回退再进入个人行动，也不按新座次重排', () => {
  const s = hostWithPlayers(['A', 'B', 'C']);
  C.beginActions(s);
  C.requestSwap(s, { fromId: 'A', toId: 'C', accepted: true, ends: false });
  assert.deepEqual(s.seatOrder, ['C', 'B', 'A']);
  assert.equal(C.beginActions(s).kept, true);
  assert.deepEqual(s.today.actionOrder, ['A', 'B', 'C']);
});

test('计划者与技能使用者按当日记录；仅拍板不算计划者；新的一天清空，昨夜结果保留', () => {
  const s = hostWithPlayers(['A', 'B', 'C', 'D']);
  C.beginActions(s);
  C.recordAction(s, 'A', { type: 'plan' });
  C.recordAction(s, 'B', { type: 'skill' });
  assert.deepEqual(s.today.plannerIds, ['A']);
  assert.deepEqual(s.today.skillUserIds, ['B']);
  assert.equal(C.lastSeat(s.seatOrder), 'D');
  assert.equal(s.today.plannerIds.includes('D'), false, '末位只拍板，不算计划者');
  s.pendingNightResult = { id: 'n1', day: 1, text: '平安无事', publishedDay: null };
  C.advanceDay(s);
  assert.equal(s.day, 2);
  assert.deepEqual(s.today.plannerIds, []);
  assert.deepEqual(s.today.skillUserIds, []);
  assert.equal(s.today.rotationDone, false);
  assert.equal(s.pendingNightResult.text, '平安无事', '昨夜结果次日仍能公布');
  assert.equal(s.history.length, 1);
  assert.ok(C.retreatDay(s));
  assert.equal(s.day, 1);
  assert.deepEqual(s.today.plannerIds, ['A'], '跨日回退恢复当日记录');
});

test('守夜：0／1／多份提交走不同处理，空提交不读空数组', () => {
  assert.equal(C.watchMode(0), 'random');
  assert.equal(C.watchMode(undefined), 'random');
  assert.equal(C.watchMode(1), 'single');
  assert.equal(C.watchMode(3), 'decider');
  const today = C.newToday();
  assert.deepEqual(C.submittedCandidates(today), []);
});

test('守夜候选：两份随机名单，「指定两人」生成时即抽定；按行为选人的名单从当日记录解析', () => {
  const rng = C.seededRng(42);
  const templates = C.defaultWatchTemplates();
  const opts = C.drawWatchOptions(templates, ['A', 'B', 'C', 'D'], rng, 2);
  assert.equal(opts.length, 2);
  assert.notEqual(opts[0].templateId, opts[1].templateId, '两份名单来自不同模板');

  const designated = C.makeWatchOption(templates.find((t) => t.id === 'wt_designated'), ['A', 'B', 'C', 'D'], C.seededRng(5), 2);
  assert.equal(designated.designatedIds.length, 2);
  const frozen = JSON.stringify(designated.designatedIds);
  const res1 = C.resolveWatchOption(designated, { plannerIds: [], skillUserIds: [], aliveIds: ['A', 'B', 'C', 'D'] });
  assert.equal(JSON.stringify(res1.memberIds), frozen, '刷新／重算不变');

  const planners = C.makeWatchOption(templates.find((t) => t.id === 'wt_planners'), ['A', 'B', 'C', 'D'], rng, 2);
  const res2 = C.resolveWatchOption(planners, { plannerIds: ['B', 'C'], skillUserIds: [], aliveIds: ['A', 'B', 'C', 'D'] });
  assert.deepEqual(res2.memberIds, ['B', 'C']);

  const danger = C.makeWatchOption(templates.find((t) => t.id === 'wt_danger'), ['A', 'B'], rng, 2);
  const res3 = C.resolveWatchOption(danger, { plannerIds: [], skillUserIds: [], aliveIds: ['A', 'B'] });
  assert.equal(res3.needsHost, true, '只有倾向的名单需要主持人指定人员');
  assert.deepEqual(res3.tendencies, ['danger']);
});

test('多条目名单不擅自混合：组合方式未定时要求主持人确认', () => {
  const t = { id: 'x', name: '混合', entries: [{ kind: 'planners' }, { kind: 'skillUsers' }], combine: 'pending', weight: 1, enabled: true };
  const opt = C.makeWatchOption(t, ['A', 'B', 'C'], C.seededRng(1), 2);
  const res = C.resolveWatchOption(opt, { plannerIds: ['A'], skillUserIds: ['B'], aliveIds: ['A', 'B', 'C'] });
  assert.equal(res.needsHost, true);
  t.combine = 'union';
  const res2 = C.resolveWatchOption(C.makeWatchOption(t, ['A', 'B', 'C'], C.seededRng(1), 2), { plannerIds: ['A'], skillUserIds: ['B'], aliveIds: ['A', 'B', 'C'] });
  assert.equal(res2.needsHost, false);
  assert.deepEqual(res2.memberIds, ['A', 'B']);
});

test('公共事件：80% 只控制触发；分支概率单独计算，合计100%才允许自动抽签', () => {
  let triggered = 0;
  const rng = C.seededRng(99);
  for (let i = 0; i < 2000; i++) if (C.rollEventTrigger(80, rng).triggered) triggered++;
  assert.ok(triggered > 1500 && triggered < 1700, '约80%触发：' + triggered);
  const op = C.newOption('参与');
  op.outcomes = [Object.assign(C.newOutcome(), { probability: 60 }), Object.assign(C.newOutcome(), { probability: null })];
  assert.equal(C.probabilityStatus(op).complete, false);
  assert.equal(C.drawOutcome(op, rng), null, '概率未配齐不自动抽签');
  op.outcomes[1].probability = 30;
  assert.equal(C.probabilityStatus(op).complete, false, '合计90%不行');
  op.outcomes[1].probability = 40;
  assert.ok(C.probabilityStatus(op).complete);
  const d = C.drawOutcome(op, rng);
  assert.ok(op.outcomes.some((o) => o.id === d.outcomeId));
});

test('事件效果：公共池不足不静默扣成负数；收益不算执行前必需；回滚精确', () => {
  const pool = [];
  C.addItem(pool, 'bread', 1);
  C.addItem(pool, 'energy_bar', 1);
  pool.find((e) => e.defId === 'energy_bar').uses = 2;
  const short = C.poolShortages(pool, [{ defId: 'bread', qty: -2 }, { defId: 'water', qty: 5 }]);
  assert.deepEqual(short, [{ defId: 'bread', need: 2, have: 1 }]);
  const before = JSON.stringify(pool.map((e) => [e.defId, e.qty, e.uses]).sort());
  const changes = C.applyPoolDelta(pool, [{ defId: 'water', qty: 2 }, { defId: 'energy_bar', qty: -1 }]);
  assert.equal(C.countDef(pool, 'water'), 2);
  assert.equal(C.countDef(pool, 'energy_bar'), 0);
  const rev = C.revertPoolChanges(pool, changes);
  assert.ok(rev.ok);
  assert.equal(JSON.stringify(pool.map((e) => [e.defId, e.qty, e.uses]).sort()), before);
});

test('财富计分：钞票×1 + 名画×6 + 珠宝查表；超过5件需主持人计分；死亡后为0', () => {
  assert.deepEqual([0, 1, 2, 3, 4, 5].map(C.jewelScore), [0, 1, 4, 8, 11, 15]);
  assert.equal(C.jewelScore(6), null);
  assert.equal(C.wealthScore({ cash: 3, painting: 1, jewel: 2 }).score, 3 + 6 + 4);
  const big = C.wealthScore({ cash: 1, painting: 0, jewel: 6 });
  assert.equal(big.score, null);
  assert.equal(big.pending, true);
  assert.equal(C.wealthScore({ cash: 9, painting: 9, jewel: 1 }, true).score, 0);
});

test('结算：存在未定项时显示部分分数，不当作0分', () => {
  const partial = C.settlementTotal({ wealth: 10, map: 2, loveHate: null, survival: null, task: 3, adjust: 1 });
  assert.equal(partial.partial, true);
  assert.equal(partial.total, 16);
  const full = C.settlementTotal({ wealth: 10, map: 2, loveHate: 0, survival: 5, task: 3, adjust: null });
  assert.equal(full.partial, false);
  assert.equal(full.total, 20);
});

test('未配置的饥饿阈值不自动判定；配置后才分三区间', () => {
  const rules = C.defaultRules();
  assert.equal(C.hungerZone(5, rules), null);
  rules.hungerFullAt = 8;
  rules.hungerHungryAt = 3;
  assert.equal(C.hungerZone(9, rules), '充盈');
  assert.equal(C.hungerZone(5, rules), '普通');
  assert.equal(C.hungerZone(3, rules), '饥饿');
});

test('配置未完成项：未定值为 null 时列出', () => {
  const items = C.pendingConfigItems(C.defaultRules()).map((i) => i.key);
  for (const k of ['hpMax', 'eventPosition', 'watchCarryTicks', 'rescueTarget', 'scoreSurvival', 'itemUses.ammo']) {
    assert.ok(items.includes(k), k);
  }
  assert.ok(!items.includes('inventoryCapacityTicks'));
});

test('战斗力：基础=当前生命；步枪无弹不给+6；多武器不擅自叠加', () => {
  const noAmmo = C.combatSummary(5, [{ defId: 'rifle' }, { defId: 'knife' }], []);
  assert.equal(noAmmo.weapons.find((w) => w.name === '军用步枪').bonus, 0);
  assert.equal(noAmmo.base, 5);
  const withAmmo = C.combatSummary(4, [{ defId: 'rifle' }, { defId: 'ammo' }, { defId: 'axe' }], []);
  assert.equal(withAmmo.stacked, 4 + 6 + 2);
  assert.equal(withAmmo.bestOnly, 4 + 6);
  assert.equal(withAmmo.multiple, true);
});

test('搜刮：3轮、每轮3选项、7秒截止；超时选默认第一项；刷新不多领一轮', () => {
  const rules = C.defaultRules();
  const tpl = C.defaultScavengeTemplate();
  const rng = C.seededRng(11);
  const t0 = 1_000_000;
  const s = C.startScavenge(tpl, rules, [], t0, rng);
  assert.equal(s.rounds.length, 1);
  assert.equal(s.rounds[0].options.length, 3);
  assert.equal(s.rounds[0].deadline, t0 + 7000);
  for (const combo of s.rounds[0].options) {
    const ticks = C.comboTicks(combo, []);
    assert.ok(ticks >= 3 && ticks <= 4, '每组 1.5～2 单位：' + ticks);
  }
  // 第1轮在 2 秒时选第3项
  assert.ok(C.chooseScavenge(s, 0, 2, t0 + 2000, [], rng).ok);
  assert.equal(s.rounds.length, 2);
  assert.equal(s.rounds[1].deadline, t0 + 9000, '下一轮从选择时刻起算');
  // 页面关掉很久后再打开：剩余回合全部按截止时间超时、选默认项
  const optionsSnapshot = JSON.stringify(s.rounds[1].options);
  C.settleScavenge(s, t0 + 60_000, [], rng);
  assert.equal(s.status, 'organize');
  assert.equal(s.rounds.length, 3, '总共只有3轮');
  assert.equal(JSON.stringify(s.rounds[1].options), optionsSnapshot, '已存档的候选不重抽');
  assert.equal(s.rounds[1].choice, 0);
  assert.equal(s.rounds[1].auto, true);
  assert.equal(s.rounds[2].startedAt, s.rounds[1].deadline, '第3轮从第2轮截止时刻起算');
  // 已超时回合的点击被拒绝
  assert.equal(C.chooseScavenge(s, 2, 1, t0 + 61_000, [], rng).ok, false);
  const again = C.settleScavenge(s, t0 + 120_000, [], rng);
  assert.equal(again, false, '再次结算不会产生新回合');
  const gains = C.scavengeGains(s);
  assert.ok(gains.length > 0);
});

test('搜刮组合：补给外不重复、同类少见、装备与能量棒奶油汤更少、不超出上限', () => {
  const tpl = C.defaultScavengeTemplate();
  const rng = C.seededRng(2024);
  const N = 3000;
  const seen = {};
  let sameCatPairs = 0;
  let weaponPairs = 0;
  for (let i = 0; i < N; i++) {
    const combo = C.generateCombo(tpl, [], 4, rng);
    const ticks = C.comboTicks(combo, []);
    assert.ok(ticks >= 3 && ticks <= 4, '每组 1.5～2 单位，不超出：' + ticks);
    const cats = {};
    for (const it of combo) {
      const def = C.getDef(it.defId, []);
      if (def.category !== 'supply') assert.equal(it.qty, 1, '补给之外的物品最多一件：' + def.name + '×' + it.qty);
      seen[it.defId] = (seen[it.defId] || 0) + 1;
      if (def.category !== 'supply') {
        if (cats[def.category]) sameCatPairs++;
        cats[def.category] = true;
      }
    }
    const weapons = combo.filter((it) => (C.getDef(it.defId, []).tags || []).includes('武器')).length;
    if (weapons >= 2) weaponPairs++;
  }
  assert.ok(sameCatPairs / N < 0.08, '同类（补给外）同组的比例很低：' + sameCatPairs / N);
  assert.ok(weaponPairs / N < 0.02, '武器＋武器很少见：' + weaponPairs / N);
  assert.ok(seen.energy_bar < seen.bread / 2 && seen.cream_soup < seen.bread / 2, '能量棒、奶油汤明显比面包少');
  const gear = ['knife', 'axe', 'rifle', 'ammo', 'vest'].reduce((n, id) => n + (seen[id] || 0), 0);
  assert.ok(gear < (seen.bread + seen.water) / 2, '装备整体少于基础补给');
  assert.ok((seen.axe || 0) < (seen.knife || 0), '消防斧比折刀少');
});

test('规则第2版：旧存档里的搜刮默认值随之更新，手动改过的保留；没改过的示例模板换成新权重', () => {
  const old = Object.assign(C.defaultRules(), { scavengeSeconds: 5, scavengeComboTicks: 6 });
  delete old.rulesRev;
  const r = C.normalizeRules(old);
  assert.equal(r.scavengeSeconds, 7);
  assert.equal(r.scavengeComboTicks, 4);
  const custom = Object.assign(C.defaultRules(), { scavengeSeconds: 10, scavengeComboTicks: 6 });
  delete custom.rulesRev;
  assert.equal(C.normalizeRules(custom).scavengeSeconds, 10, '手动改过的秒数保留');
  assert.equal(C.normalizeRules(Object.assign(C.defaultRules(), { scavengeComboTicks: 6 })).scavengeComboTicks, 6, '新版存档里改成6的也保留');
  const p = C.newPlayerState();
  p.scavengeTemplate = { id: 'st_example', name: '示例搜刮模板', isExample: true, items: [{ defId: 'axe', weight: 1 }] };
  assert.equal(C.normalizeSave(JSON.parse(JSON.stringify(p)), 'shelter-player').scavengeTemplate.rev, 2);
  p.scavengeTemplate = { id: 'x', name: '自定义', isExample: false, items: [{ defId: 'axe', weight: 9 }] };
  assert.equal(C.normalizeSave(JSON.parse(JSON.stringify(p)), 'shelter-player').scavengeTemplate.items[0].weight, 9);
});

test('搜刮：截止前一刻点击有效，截止时刻点击视为超时', () => {
  const rules = C.defaultRules();
  const rng = C.seededRng(3);
  const s = C.startScavenge(C.defaultScavengeTemplate(), rules, [], 0, rng);
  assert.ok(C.chooseScavenge(s, 0, 1, 6999, [], rng).ok);
  const r1 = s.rounds[1];
  assert.equal(C.chooseScavenge(s, 1, 1, r1.deadline, [], rng).ok, false);
  assert.equal(s.rounds[1].choice, 0);
  assert.equal(s.rounds[1].auto, true);
});

test('存档校验：类型不符、版本过新、负数量都会被拒绝', () => {
  const host = C.newHostState();
  assert.ok(C.validateSave(JSON.parse(JSON.stringify(host)), 'shelter-host').ok);
  assert.equal(C.validateSave(host, 'shelter-player').ok, false);
  const future = Object.assign({}, host, { schemaVersion: C.SCHEMA_VERSION + 1 });
  assert.equal(C.validateSave(future, 'shelter-host').ok, false);
  const p = C.newPlayerState();
  p.inventory.push({ id: 'x', defId: 'bread', qty: -1 });
  assert.equal(C.validateSave(p, 'shelter-player').ok, false);
  const badSeat = C.newHostState();
  badSeat.seatOrder = ['ghost'];
  assert.equal(C.validateSave(badSeat, 'shelter-host').ok, false);
  assert.equal(C.validateSave('{"oops"', 'shelter-host').ok, false);
});

test('首次开启不自动生成开局物资', () => {
  assert.equal(C.newPlayerState().inventory.length, 0);
  assert.equal(C.newHostState().pool.length, 0);
  assert.equal(C.newHostState().events.length, 0, '正式事件库可为空');
  assert.equal(C.newHostState().nightLibrary.length, 0);
});

test('批量录入解析：名称或 id，支持正负号与 ×', () => {
  const { items, errors } = C.parseItemList('面包+2，子弹-1、普通水×3\nenergy_bar 2，绷带', []);
  assert.deepEqual(errors, []);
  assert.deepEqual(items, [
    { defId: 'bread', qty: 2 },
    { defId: 'ammo', qty: -1 },
    { defId: 'water', qty: 3 },
    { defId: 'energy_bar', qty: 2 },
    { defId: 'bandage', qty: 1 }
  ]);
  assert.deepEqual(C.parseItemList('火箭筒×1', []).errors, ['未知物品：「火箭筒」']);
});

test('库存扣减不会变成负数', () => {
  const inv = [];
  const [e] = C.addItem(inv, 'bread', 2);
  assert.throws(() => C.removeQty(inv, e.id, 3), /数量不足/);
  assert.throws(() => C.addItem(inv, 'bread', -1), /正整数/);
  C.removeQty(inv, e.id, 2);
  assert.equal(inv.length, 0);
});

test('玩家总览提醒：按严重程度排序，只汇总已记录的事实', () => {
  const s = C.newPlayerState();
  s.publicInfo.day = 3;
  s.action = { day: 3, used: true, note: '' };
  assert.deepEqual(C.playerAlerts(s), [], '健康、已行动：没有提醒');
  s.hp = 0;
  s.thirst = '口渴';
  s.statuses.push({ id: 'b', statusId: 'bleeding', name: '流血伤口', startDay: 1, nextDay: 3 });
  C.addItem(s.inventory, 'painting', 6); // 12 单位，超出 10
  const alerts = C.playerAlerts(s);
  assert.deepEqual(alerts.map((a) => a.level), ['critical', 'warning', 'warning', 'warning']);
  assert.ok(alerts[0].text.includes('生命为 0'));
  assert.ok(alerts.some((a) => a.tab === 'inventory' && a.text.includes('2 单位')));
  assert.ok(alerts.some((a) => a.text.includes('流血伤口第 3 天到期')));
  s.publicInfo.day = 4;
  assert.ok(C.playerAlerts(s).some((a) => a.level === 'info' && a.tab === 'action'), '新的一天行动未用');
});

test('饥荒：手动可选；填了饥荒阈值才自动判定；提醒为严重', () => {
  const rules = Object.assign(C.defaultRules(), { hungerFullAt: 8, hungerHungryAt: 3 });
  assert.equal(C.hungerZone(1, rules), '饥饿', '没填饥荒阈值时最多判到饥饿');
  rules.hungerFamineAt = 1;
  assert.equal(C.hungerZone(1, rules), '饥荒');
  assert.equal(C.hungerZone(2, rules), '饥饿');
  assert.ok(C.pendingConfigItems(C.defaultRules()).some((p) => p.key === 'hungerFamineAt'), '饥荒阈值是待配置项');
  const s = C.newPlayerState();
  assert.equal(s.hungerManual, '普通', '新玩家默认普通，不再显示「未记录」');
  s.hungerManual = '饥荒';
  s.action = { day: 1, used: true, note: '' };
  const a = C.playerAlerts(s);
  assert.equal(a[0].level, 'critical');
  assert.ok(a[0].text.startsWith('饥荒'));
});

test('总览提醒：搜刮与携带；占位按分类汇总', () => {
  const s = C.newPlayerState();
  s.action = { day: 1, used: true, note: '' };
  const [axe] = C.addItem(s.inventory, 'axe', 1);
  C.addItem(s.inventory, 'bread', 3);
  s.loadout = { context: 'event', label: '', day: 1, limitTicks: 1, items: [{ entryId: axe.id, qty: 1 }], confirmed: true };
  assert.equal(C.loadoutTicks(s), 2);
  const levels = C.playerAlerts(s).map((a) => a.tab + ':' + a.level);
  assert.deepEqual(levels, ['inventory:warning', 'inventory:info'], '携带超限只警告，携带中有提示（携带已并入库存页）');
  s.loadout.confirmed = false;
  assert.ok(C.playerAlerts(s).some((a) => a.text.includes('确认后才生效')), '挑选中的携带有单独提示');
  s.scavenge = { status: 'organize', rounds: [], cfg: { rounds: 3 } };
  assert.ok(C.playerAlerts(s).some((a) => a.tab === 'scavenge'));
  const comp = C.capacityByCategory(s.inventory, [], s.rules);
  assert.deepEqual(comp.map((c) => [c.id, c.ticks, c.pieces]), [['supply', 3, 3], ['equipment', 2, 1]]);
});

test('主持台待办：按阶段提示下一步，只用公开信息', () => {
  const fresh = C.newHostState();
  const notConfig = (a) => !a.text.includes('配置未完成');
  assert.deepEqual(C.hostAlerts(fresh).filter(notConfig).map((a) => a.tab + ':' + a.level), ['settings:critical'], '没登记玩家');
  assert.ok(C.hostAlerts(fresh).some((a) => a.tab === 'settings' && a.text.includes('配置未完成')), '规则未配完给提示');

  const s = hostWithPlayers(['A', 'B', 'C']);
  const own = () => C.hostAlerts(s).filter(notConfig);
  assert.deepEqual(own(), [], '首日阶段1没有待公布结果：没有待办');

  s.phase = 'rotation';
  assert.deepEqual(own().map((a) => a.tab + ':' + a.level), ['flow:warning'], '未轮换');
  C.applyRotation(s);
  assert.deepEqual(own(), []);

  s.phase = 'actions';
  C.beginActions(s);
  assert.ok(own()[0].text.includes('轮到 C 行动（还剩 3 人）'), '轮换后末位先行动');
  s.today.actedIds = ['C', 'A', 'B'];
  assert.deepEqual(own(), []);

  s.batches.push({ id: 'b1', label: '第1天补给', status: 'open', pickOrder: ['A', 'B'], picks: [{ playerId: 'A' }], items: [] });
  assert.ok(own().some((a) => a.tab === 'supply' && a.level === 'warning' && a.text.includes('还有 1 人')));
  s.batches[0].status = 'closed';

  s.phase = 'watch';
  assert.deepEqual(own().map((a) => a.tab + ':' + a.level), ['watch:warning'], '名单未确认');
  s.today.finalWatch = { id: 'fw', members: ['A'], published: false };
  assert.deepEqual(own().map((a) => a.tab + ':' + a.level), ['watch:info', 'watch:info'], '未公开、未存草稿');
  s.today.finalWatch.published = true;
  s.pendingNightResult = { id: 'n1', day: 1, text: '平安', publishedDay: null };
  assert.deepEqual(own(), [], '当天保存的草稿不算待公布');
  C.advanceDay(s);
  assert.equal(s.phase, 'night');
  assert.deepEqual(own().map((a) => a.tab + ':' + a.level), ['flow:warning'], '次日阶段1提醒公布');

  s.players[1].alive = false;
  assert.ok(own().some((a) => a.level === 'info' && a.text.includes('已死亡仍在座次：B')));
  s.rules.rescueTarget = 2;
  s.rescueProgress = 2;
  assert.ok(own().some((a) => a.tab === 'records'), '到达阈值提醒结算，但不自动结束');

  const levels = own().map((a) => a.level);
  assert.deepEqual(levels, levels.slice().sort((x, y) => ['critical', 'warning', 'info'].indexOf(x) - ['critical', 'warning', 'info'].indexOf(y)), '按严重度排序');
});

test('主持台待办：公共事件从判定到公开逐步提示', () => {
  const s = hostWithPlayers(['A', 'B']);
  s.rules.eventPosition = 'afterWatch';
  s.phase = 'event';
  const evAlert = () => C.hostAlerts(s).filter((a) => a.tab === 'events').map((a) => a.text);
  assert.deepEqual(evAlert(), ['今日事件尚未判定']);
  s.today.eventCheck = { roll: 10, chance: 80, triggered: false };
  assert.deepEqual(evAlert(), [], '无事件：没有待办');
  s.today.eventCheck.triggered = true;
  assert.deepEqual(evAlert(), ['今日触发了公共事件，尚未选择事件']);
  s.today.eventFlow = { id: 'f', event: { name: '秘密事件名' }, published: false, resolutionId: null };
  assert.deepEqual(evAlert(), ['事件已选定，尚未公布到公开页']);
  s.today.eventFlow.published = true;
  assert.deepEqual(evAlert(), ['事件已公布，等待录入投票并结算']);
  s.resolutions.push({ id: 'r1', public: false });
  s.today.eventFlow.resolutionId = 'r1';
  assert.deepEqual(evAlert(), ['事件已结算，结果尚未公开']);
  s.resolutions[0].public = true;
  assert.deepEqual(evAlert(), []);
  assert.ok(!JSON.stringify(C.hostAlerts(s)).includes('秘密事件名'), '待办不带事件内容');
});

test('事件导入规范化：缺字段补齐，id 冲突换新', () => {
  const ev = C.normalizeEvent({ id: 'dup', name: '断电', options: [{ label: '参与', outcomes: [{ text: '无事', probability: 100 }] }] }, ['dup']);
  assert.notEqual(ev.id, 'dup');
  assert.equal(ev.isDraft, true);
  assert.ok(C.probabilityStatus(ev.options[0]).complete);
  assert.deepEqual(C.validateEvent(ev), []);
});
