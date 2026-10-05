/*
 * 避难所 Playtest · 共享核心
 *
 * 物品字典、职业／任务草案、规则配置默认值，以及两端共用的纯逻辑。
 * 构建时内联进 host.html 与 player.html；Node 测试直接 require 本文件。
 *
 * 约定：
 * - 这里不碰 DOM。需要随机数的函数都接受可注入的 rng，测试可复现。
 * - 容量一律用半格整数 ticks 保存：1 tick = 0.5 单位，避免把数量和容量混在一起。
 * - 规则里没确定的数值保持 null，界面显示「待配置／主持人裁定」，不悄悄补值。
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ShelterCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var SCHEMA_VERSION = 1;
  var PENDING_TEXT = '待配置／主持人裁定';

  // ---------------------------------------------------------------- 工具

  function uid(prefix) {
    return (prefix || 'id') + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  function clone(value) {
    return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
  }

  function isInt(n) {
    return typeof n === 'number' && Number.isInteger(n);
  }

  function isNum(n) {
    return typeof n === 'number' && isFinite(n);
  }

  /** 可复现的伪随机数（测试用）。 */
  function seededRng(seed) {
    var a = seed >>> 0;
    return function () {
      a = (a + 0x6d2b79f5) >>> 0;
      var t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /** ticks → 「3.5」这样的单位文本；null 表示待配置。 */
  function fmtUnits(ticks) {
    if (ticks == null) return '待配置';
    var u = ticks / 2;
    return Number.isInteger(u) ? String(u) : u.toFixed(1);
  }

  /** 按权重抽一个下标；权重全为 0 时返回 -1。 */
  function weightedIndex(list, weightOf, rng) {
    var total = 0;
    var weights = list.map(function (item) {
      var w = weightOf(item);
      w = isNum(w) && w > 0 ? w : 0;
      total += w;
      return w;
    });
    if (total <= 0) return -1;
    var r = (rng || Math.random)() * total;
    for (var i = 0; i < weights.length; i++) {
      if (r < weights[i]) return i;
      r -= weights[i];
    }
    for (var j = weights.length - 1; j >= 0; j--) if (weights[j] > 0) return j;
    return -1;
  }

  /** 无放回抽 n 个。 */
  function sample(list, n, rng) {
    var pool = list.slice();
    var out = [];
    while (out.length < n && pool.length) {
      var i = Math.floor((rng || Math.random)() * pool.length);
      out.push(pool.splice(i, 1)[0]);
    }
    return out;
  }

  // ---------------------------------------------------------------- 规则标记

  var RULE_STATUS = {
    confirmed: '已确认',
    tentative: '暂定',
    pending: '待定',
    impl: '实现建议',
    draft: '草案',
    custom: '自定义'
  };

  // ---------------------------------------------------------------- 物品字典

  var CATEGORIES = [
    { id: 'supply', name: '补给' },
    { id: 'medical', name: '医疗' },
    { id: 'wealth', name: '财富' },
    { id: 'equipment', name: '装备' },
    { id: 'special', name: '特殊' },
    { id: 'custom', name: '自定义' }
  ];

  /*
   * capacityTicks：占位（1 tick = 0.5 单位）。
   * instance：需要独立保存的实例字段——uses 剩余次数 / notes 地图笔记 / water 储水 / condition 完好破损。
   * use：玩家端「使用」按钮的处理方式；没有 use 的物品不提供使用按钮。
   * pending：效果里尚未确定的部分，界面显示为待定，不推导额外规则。
   */
  var ITEMS = [
    { id: 'water', name: '普通水', category: 'supply', capacityTicks: 1, ruleStatus: 'confirmed',
      effectText: '补水；恢复多少档待定。', pending: ['补水幅度待定'], use: 'drink', tags: ['补水'] },
    { id: 'energy_drink', name: '功能饮料', category: 'supply', capacityTicks: 1, ruleStatus: 'confirmed',
      effectText: '补水；下一次行动判定视为充盈，实际饥饿值不填满。', pending: ['补水幅度待定'], use: 'energyDrink', tags: ['补水'] },
    { id: 'bread', name: '面包', category: 'supply', capacityTicks: 1, ruleStatus: 'confirmed',
      effectText: '恢复饥饿值，恢复量待定。', pending: ['恢复量待定'], use: 'eat', tags: ['食物', '普通食物'] },
    { id: 'cream_soup', name: '奶油汤', category: 'supply', capacityTicks: 1, ruleStatus: 'confirmed',
      effectText: '恢复饥饿值并补水，数值待定。', pending: ['恢复量待定', '补水幅度待定'], use: 'eatDrink', tags: ['食物', '补水'] },
    { id: 'energy_bar', name: '能量棒', category: 'supply', capacityTicks: 1, ruleStatus: 'confirmed',
      effectText: '使用3次，每次约等于普通食物／面包；整个实例未用完仍占0.5。', instance: 'uses', defaultUses: 3,
      pending: ['每次恢复量同面包，待定'], use: 'eatMulti', tags: ['食物'] },
    { id: 'bandage', name: '绷带', category: 'medical', capacityTicks: 1, ruleStatus: 'confirmed',
      effectText: '止血或恢复1生命，二选一。', use: 'bandage', tags: ['医疗'] },
    { id: 'medkit', name: '医疗箱', category: 'medical', capacityTicks: 2, ruleStatus: 'confirmed',
      effectText: '清除伤病类负面状态，并恢复2生命；不处理饥饿、口渴及脱水昏迷。', use: 'medkit', tags: ['医疗'] },
    { id: 'cash', name: '钞票', category: 'wealth', capacityTicks: 1, ruleStatus: 'confirmed',
      effectText: '每件1分。', tags: ['财富'] },
    { id: 'painting', name: '名画', category: 'wealth', capacityTicks: 4, ruleStatus: 'confirmed',
      effectText: '每件6分。', tags: ['财富'] },
    { id: 'jewel', name: '珠宝', category: 'wealth', capacityTicks: 2, ruleStatus: 'confirmed',
      effectText: '1～5件总分依次1、4、8、11、15；0件0分，超过5件未定。', pending: ['超过5件的计分未定'], tags: ['财富'] },
    { id: 'knife', name: '军用折刀', category: 'equipment', capacityTicks: 1, ruleStatus: 'confirmed',
      effectText: '攻击力+1；切绳、内藏铁丝开锁。', attack: 1, tags: ['武器', '切绳', '开锁'] },
    { id: 'axe', name: '消防斧', category: 'equipment', capacityTicks: 2, ruleStatus: 'confirmed',
      effectText: '攻击力+2；破门、清除封锁道路。', attack: 2, tags: ['武器', '破门', '清障'] },
    { id: 'rifle', name: '军用步枪', category: 'equipment', capacityTicks: 2, ruleStatus: 'confirmed',
      effectText: '需携带子弹才能发挥+6攻击力；无弹仍可恐吓。', attack: 6, needsAmmo: true,
      pending: ['多武器是否叠加未定', '子弹何时扣除未定'], tags: ['武器', '恐吓'] },
    { id: 'ammo', name: '子弹', category: 'equipment', capacityTicks: 1, ruleStatus: 'confirmed',
      effectText: '支持步枪；部分交易事件有额外价值。每份使用次数未定。', pending: ['每份使用次数未定'], use: 'record', tags: ['弹药', '交易'] },
    { id: 'vest', name: '防弹背心', category: 'equipment', capacityTicks: 2, ruleStatus: 'confirmed',
      effectText: '防止任务中一次负面状态或生命损失；损坏时点、伤害范围待定。', instance: 'condition',
      pending: ['损坏时点待定', '伤害范围待定'], use: 'vest', tags: ['防护'] },
    { id: 'checkers', name: '跳棋', category: 'special', capacityTicks: 1, ruleStatus: 'confirmed',
      effectText: '外交、娱乐；特定售货机事件中冒充硬币，获得食物或水。', pending: ['使用次数未定'], use: 'record', tags: ['外交', '娱乐', '售货机'] },
    { id: 'map', name: '地图', category: 'special', capacityTicks: 2, ruleStatus: 'confirmed',
      effectText: '提供地点、时间与可能回报信息；降低队伍探路危险；携带参加一次任务加1笔记，每笔记1分；可能损坏。',
      instance: 'notes', pending: ['转移后笔记归属、损坏后及死亡后的地图分数由主持人裁定'], use: 'map', tags: ['探路'] },
    { id: 'canteen', name: '军用水壶', category: 'special', capacityTicks: 2, ruleStatus: 'confirmed',
      effectText: '水源或下雨条件下可获得1份水，最多储存2份。', instance: 'water', maxWater: 2,
      pending: ['内部水是否额外占容量未定', '饮用后是否生成普通水物品未定', '取水频率未定'], use: 'canteen', tags: ['补水'] },
    { id: 'liquor', name: '酒', category: 'special', capacityTicks: 1, ruleStatus: 'confirmed',
      effectText: '事件中使用：临时攻击力+2，并承担一次口渴消耗。', use: 'liquor', tags: ['事件'] },
    { id: 'flare', name: '信号枪', category: 'special', capacityTicks: 2, ruleStatus: 'confirmed',
      effectText: '适当地点与时机推进营救；其他事件中使用获得随机军方补给。', pending: ['使用次数未定'], use: 'record', tags: ['营救'] }
  ];

  var ITEM_INDEX = {};
  ITEMS.forEach(function (d) { ITEM_INDEX[d.id] = d; });

  function getDef(defId, customItems) {
    if (ITEM_INDEX[defId]) return ITEM_INDEX[defId];
    var list = customItems || [];
    for (var i = 0; i < list.length; i++) if (list[i].id === defId) return list[i];
    return { id: defId, name: defId + '（未知物品）', category: 'custom', capacityTicks: 0, ruleStatus: 'custom',
      effectText: '字典里找不到这个物品：可能是已删除的自定义物品。', unknown: true };
  }

  function allDefs(customItems) {
    return ITEMS.concat(customItems || []);
  }

  /** 按名称或 id 找物品（批量录入用）。 */
  function findDefByName(text, customItems) {
    var key = String(text || '').trim();
    if (!key) return null;
    var defs = allDefs(customItems);
    for (var i = 0; i < defs.length; i++) {
      if (defs[i].id === key || defs[i].name === key) return defs[i];
    }
    var lower = key.toLowerCase();
    for (var j = 0; j < defs.length; j++) if (defs[j].id.toLowerCase() === lower) return defs[j];
    return null;
  }

  function newCustomItem(fields) {
    return {
      id: uid('custom'),
      name: String(fields.name || '').trim() || '未命名物品',
      category: fields.category || 'custom',
      capacityTicks: isInt(fields.capacityTicks) && fields.capacityTicks >= 0 ? fields.capacityTicks : 1,
      effectText: String(fields.effectText || '').trim() || '主持人自定义物品，效果见备注。',
      ruleStatus: 'custom',
      pending: [],
      tags: ['自定义']
    };
  }

  // ---------------------------------------------------------------- 状态、职业、任务

  /* injury: true 表示属于伤病类，医疗箱可清除；null 表示是否属于伤病类未被确认。 */
  var STATUSES = [
    { id: 'bleeding', name: '流血伤口', ruleStatus: 'confirmed', injury: true, tracked: true,
      effectText: '每两个回合失去1生命，直到清除。', pending: ['获得当天是否计入两回合待定', '重复流血是否叠加待定'] },
    { id: 'infection', name: '感染', ruleStatus: 'draft', injury: null, effectText: '候选状态，效果未被确认。' },
    { id: 'diarrhea', name: '腹泻', ruleStatus: 'draft', injury: null, effectText: '候选状态，效果未被确认。' },
    { id: 'weakness', name: '虚弱', ruleStatus: 'draft', injury: null, effectText: '候选状态，效果未被确认。' },
    { id: 'strain', name: '拉伤', ruleStatus: 'draft', injury: null, effectText: '候选状态，效果未被确认。' },
    { id: 'dizziness', name: '眩晕', ruleStatus: 'draft', injury: null, effectText: '候选状态，效果未被确认。' }
  ];

  function getStatusDef(statusId) {
    for (var i = 0; i < STATUSES.length; i++) if (STATUSES[i].id === statusId) return STATUSES[i];
    return null;
  }

  var PROFESSIONS = [
    { id: 'doctor', name: '医生', text: '用医疗箱治疗别人，消耗医疗箱并获得1份绷带；绷带可不消耗。',
      pending: '是否能自疗、技能具体作用范围未定。' },
    { id: 'soldier', name: '军人', text: '持枪用两个回合制造1份子弹；用两个回合修复破损背心。可为他人服务，所需物品先交给军人。',
      pending: '两回合是否各耗行动未定。' },
    { id: 'backpacker', name: '背包客', text: '帮助他人整理：携带／带回额度+1，或保护一件物品在下一事件不损坏。',
      pending: '加成范围、持续时间和叠加未定。' },
    { id: 'chef', name: '厨师', text: '一次行动将0.5普通食物加工成0.5料理，恢复量相同；选择下次行动免一次负面、免一次伤害或减少饥饿消耗。',
      pending: '具体触发未定。' }
  ];

  var TASKS = [
    { id: 'adventurer', name: '冒险家', text: '亲自参与至少7件不同公共事件。', target: 7, progress: 'events' },
    { id: 'saint', name: '圣母', text: '营救结算时死亡人数不超过初始人数的三分之二；6人即最多4人死亡。', target: null, progress: 'settlement' },
    { id: 'hoarder', name: '囤积者', text: '持有3件相同物品时秘密消耗1件记进度，面包和普通水除外；累计3次。', target: 3, progress: 'counter' },
    { id: 'liaison', name: '联络员', text: '以任意形式亲自参与推进游戏进程3次。', target: 3, progress: 'counter' },
    { id: 'misanthrope', name: '厌世者', text: '累计有3人死亡。无爱人、继承仇恨等早期规则不自动加入。', target: 3, progress: 'counter' }
  ];

  /* 只作展示，不能被选中生效：「不能让已淘汰版本悄悄生效」。 */
  var RETIRED_DRAFTS = [
    { id: 'wealth_lover', name: '爱财者（旧版）', text: '旧版财富额外加分尚未完成改写，置于停用草案，不可选择。' }
  ];

  function getProfession(id) {
    for (var i = 0; i < PROFESSIONS.length; i++) if (PROFESSIONS[i].id === id) return PROFESSIONS[i];
    return null;
  }

  function getTask(id) {
    for (var i = 0; i < TASKS.length; i++) if (TASKS[i].id === id) return TASKS[i];
    return null;
  }

  // ---------------------------------------------------------------- 规则配置

  function defaultRules() {
    return {
      playerCount: 6,
      inventoryCapacityTicks: 20,
      scavengeKeepTicks: 8,
      eventCarryTicks: null,
      watchCarryTicks: null,
      canteenWaterTicks: null,
      hpInitial: 5,
      hpMax: null,
      hpZeroRule: null,
      hungerMax: null,
      hungerFullAt: null,
      hungerHungryAt: null,
      hungerFamineAt: null,
      hungerInitial: null,
      eventChance: 80,
      eventPosition: null,
      watchSize: 2,
      swapRequestLimit: 3,
      rescueTarget: null,
      scoreSurvival: null,
      scoreLove: null,
      scoreHate: null,
      scoreTaskReward: null,
      professionsEnabled: false,
      tasksEnabled: false,
      draftStatusesEnabled: false,
      itemUses: { energy_bar: 3, ammo: null, checkers: null, flare: null },
      scavengeRounds: 3,
      scavengeOptions: 3,
      scavengeSeconds: 7,
      scavengeComboTicks: 4,
      rulesRev: 2
    };
  }

  /* 设置页的表单描述。status 对应说明里的阅读约定。 */
  var RULE_FIELDS = [
    { key: 'playerCount', label: '计划人数', type: 'int', min: 1, status: 'confirmed', note: '约6人，可配置' },
    { key: 'inventoryCapacityTicks', label: '个人总库存上限', type: 'units', status: 'tentative', note: '10单位（暂定）；超出只警告' },
    { key: 'scavengeKeepTicks', label: '每次搜刮自留额度', type: 'units', status: 'confirmed', note: '4单位；与总库存分开计算' },
    { key: 'eventCarryTicks', label: '事件携带上限（默认值）', type: 'units', nullable: true, status: 'confirmed', note: '由具体事件规定，一般1～2单位；不是个人总库存' },
    { key: 'watchCarryTicks', label: '守夜携带上限', type: 'units', nullable: true, status: 'pending', note: '待定；不会默认沿用事件上限' },
    { key: 'canteenWaterTicks', label: '水壶内每份水额外占位', type: 'units', nullable: true, status: 'pending', note: '未定时只独立显示水量' },
    { key: 'hpInitial', label: '初始生命', type: 'int', min: 0, status: 'confirmed', note: '基础战斗力＝当前生命' },
    { key: 'hpMax', label: '生命上限', type: 'int', nullable: true, min: 1, status: 'pending' },
    { key: 'hpZeroRule', label: '0生命处理与死亡时点', type: 'text', nullable: true, status: 'pending' },
    { key: 'hungerMax', label: '饥饿值上限', type: 'int', nullable: true, min: 1, status: 'pending' },
    { key: 'hungerFullAt', label: '充盈阈值（≥）', type: 'int', nullable: true, status: 'pending', note: '与饥饿阈值都填写后才启用自动判定' },
    { key: 'hungerHungryAt', label: '饥饿阈值（≤）', type: 'int', nullable: true, status: 'pending' },
    { key: 'hungerFamineAt', label: '饥荒阈值（≤）', type: 'int', nullable: true, status: 'pending', note: '填写后低于等于此值自动判为饥荒；未填时饥荒只能手动选择' },
    { key: 'hungerInitial', label: '初始饥饿值', type: 'int', nullable: true, status: 'pending' },
    { key: 'eventChance', label: '每日事件触发概率（%）', type: 'int', min: 0, max: 100, status: 'confirmed', note: '80%有事件、20%无；只控制是否触发' },
    { key: 'eventPosition', label: '公共事件位置', type: 'select', nullable: true, status: 'pending',
      options: [['beforeSupply', '阶段2（资源补给）之前'], ['afterWatch', '阶段6（确认守夜）之后']], note: '未选时由主持人手动触发' },
    { key: 'watchSize', label: '守夜人数（「指定N人」）', type: 'int', min: 1, status: 'confirmed', note: '6人局通常2人，特殊条件可改' },
    { key: 'swapRequestLimit', label: '每人换位请求上限', type: 'int', min: 0, status: 'confirmed', note: '最多3次；主持人可覆盖' },
    { key: 'rescueTarget', label: '营救阈值', type: 'int', nullable: true, status: 'pending', note: '阈值未知：不自动结束，主持人点击结算' },
    { key: 'scoreSurvival', label: '基础生存分', type: 'int', nullable: true, status: 'pending' },
    { key: 'scoreLove', label: '爱分值', type: 'int', nullable: true, status: 'pending' },
    { key: 'scoreHate', label: '恨分值', type: 'int', nullable: true, status: 'pending' },
    { key: 'scoreTaskReward', label: '秘密任务固定奖励', type: 'int', nullable: true, status: 'pending' },
    { key: 'scavengeRounds', label: '搜刮轮数', type: 'int', min: 1, status: 'confirmed', note: '3轮' },
    { key: 'scavengeOptions', label: '每轮选项数', type: 'int', min: 1, status: 'confirmed', note: '3个' },
    { key: 'scavengeSeconds', label: '每轮秒数', type: 'int', min: 1, status: 'confirmed', note: '7秒，超时选默认项' },
    { key: 'scavengeComboTicks', label: '每组合上限', type: 'units', status: 'confirmed', note: '2单位；每组在「上限−0.5」到上限之间，不会超出' },
    { key: 'professionsEnabled', label: '启用职业草案', type: 'bool', status: 'draft', note: '默认停用，主持人明确启用后使用' },
    { key: 'tasksEnabled', label: '启用秘密任务草案', type: 'bool', status: 'draft', note: '与职业独立开关' },
    { key: 'draftStatusesEnabled', label: '启用候选负面状态', type: 'bool', status: 'draft', note: '感染、腹泻、虚弱、拉伤、眩晕：效果未确认' }
  ];

  var ITEM_USE_FIELDS = [
    { key: 'energy_bar', label: '能量棒使用次数', status: 'confirmed' },
    { key: 'ammo', label: '子弹每份使用次数', status: 'pending' },
    { key: 'checkers', label: '跳棋使用次数', status: 'pending' },
    { key: 'flare', label: '信号枪使用次数', status: 'pending' }
  ];

  /** 把导入或旧存档里的 rules 补齐缺失字段（不覆盖已有值）。 */
  function normalizeRules(rules) {
    var base = defaultRules();
    var out = Object.assign({}, base, rules || {});
    out.itemUses = Object.assign({}, base.itemUses, (rules && rules.itemUses) || {});
    // 第2版调整了搜刮节奏（5秒→7秒，约3单位→2单位）：旧存档里仍是旧默认值的才跟着改，手动改过的保留
    if (rules && rules.rulesRev == null) {
      if (out.scavengeSeconds === 5) out.scavengeSeconds = base.scavengeSeconds;
      if (out.scavengeComboTicks === 6) out.scavengeComboTicks = base.scavengeComboTicks;
      out.rulesRev = base.rulesRev;
    }
    return out;
  }

  /** 顶栏「配置未完成项」：所有仍为 null 的待定配置。 */
  function pendingConfigItems(rules) {
    var out = [];
    RULE_FIELDS.forEach(function (f) {
      if (f.status === 'pending' && rules[f.key] == null) out.push({ key: f.key, label: f.label });
    });
    ITEM_USE_FIELDS.forEach(function (f) {
      if (rules.itemUses[f.key] == null) out.push({ key: 'itemUses.' + f.key, label: f.label });
    });
    return out;
  }

  /** 饥饿区间。阈值没配齐时返回 null：禁用自动判定，保留手动状态。 */
  function hungerZone(value, rules) {
    if (!isNum(value) || !isNum(rules.hungerFullAt) || !isNum(rules.hungerHungryAt)) return null;
    if (value >= rules.hungerFullAt) return '充盈';
    if (isNum(rules.hungerFamineAt) && value <= rules.hungerFamineAt) return '饥荒';
    if (value <= rules.hungerHungryAt) return '饥饿';
    return '普通';
  }

  // ---------------------------------------------------------------- 库存与实例

  function isStackable(def) {
    return !def.instance;
  }

  function instanceDefaults(def, rules) {
    switch (def.instance) {
      case 'uses': {
        var configured = rules && rules.itemUses ? rules.itemUses[def.id] : null;
        return { uses: isInt(configured) && configured > 0 ? configured : def.defaultUses || 1 };
      }
      case 'notes': return { notes: [], condition: 'intact' };
      case 'water': return { water: 0 };
      case 'condition': return { condition: 'intact' };
      default: return {};
    }
  }

  /**
   * 加入物品。普通同类物品叠加；带实例字段的物品（能量棒、地图、水壶、背心）每件独立保存，
   * 不同的剩余次数、笔记、水量不会被合并。
   * opts: { customItems, rules, fields, remark }
   */
  function addItem(list, defId, qty, opts) {
    opts = opts || {};
    if (!isInt(qty) || qty <= 0) throw new Error('数量必须是正整数');
    var def = getDef(defId, opts.customItems);
    var created = [];
    if (isStackable(def)) {
      if (!opts.remark) {
        for (var i = 0; i < list.length; i++) {
          if (list[i].defId === defId && !list[i].remark) {
            list[i].qty += qty;
            return [list[i]];
          }
        }
      }
      var entry = { id: uid('it'), defId: defId, qty: qty };
      if (opts.remark) entry.remark = opts.remark;
      list.push(entry);
      return [entry];
    }
    for (var k = 0; k < qty; k++) {
      var inst = Object.assign({ id: uid('it'), defId: defId, qty: 1 }, instanceDefaults(def, opts.rules), clone(opts.fields || {}));
      if (opts.remark) inst.remark = opts.remark;
      list.push(inst);
      created.push(inst);
    }
    return created;
  }

  /** 从某个条目扣数量；不足时抛错，不会扣成负数。 */
  function removeQty(list, entryId, qty) {
    if (!isInt(qty) || qty <= 0) throw new Error('数量必须是正整数');
    var idx = indexOfEntry(list, entryId);
    if (idx < 0) throw new Error('找不到该物品');
    var e = list[idx];
    if (qty > e.qty) throw new Error('数量不足：现有 ' + e.qty + '，要扣 ' + qty);
    e.qty -= qty;
    if (e.qty === 0) list.splice(idx, 1);
    return e;
  }

  function indexOfEntry(list, entryId) {
    for (var i = 0; i < list.length; i++) if (list[i].id === entryId) return i;
    return -1;
  }

  function findEntry(list, entryId) {
    var i = indexOfEntry(list, entryId);
    return i < 0 ? null : list[i];
  }

  function countPieces(list) {
    return list.reduce(function (sum, e) { return sum + e.qty; }, 0);
  }

  function countDef(list, defId) {
    return list.reduce(function (sum, e) { return sum + (e.defId === defId ? e.qty : 0); }, 0);
  }

  /** 单个条目占的 ticks。水壶内的水只有在配置了占位时才计入。 */
  function entryTicks(entry, customItems, rules) {
    var def = getDef(entry.defId, customItems);
    var t = entry.qty * (def.capacityTicks || 0);
    if (def.instance === 'water' && rules && isInt(rules.canteenWaterTicks) && entry.water) t += entry.water * rules.canteenWaterTicks;
    return t;
  }

  function listTicks(list, customItems, rules) {
    return list.reduce(function (sum, e) { return sum + entryTicks(e, customItems, rules); }, 0);
  }

  /** 是否有水壶装着水、但「水是否占容量」仍未配置。 */
  function canteenCapacityPending(list, rules) {
    if (rules && isInt(rules.canteenWaterTicks)) return false;
    return list.some(function (e) { return e.defId === 'canteen' && e.water > 0; });
  }

  /** 从条目里拆出一件（实例物品整件拿走，普通物品拆出 qty=1 的副本）。 */
  function takeOnePiece(list, entryId) {
    var idx = indexOfEntry(list, entryId);
    if (idx < 0) throw new Error('找不到该物品');
    var e = list[idx];
    if (e.qty > 1) {
      e.qty -= 1;
      var piece = clone(e);
      piece.id = uid('it');
      piece.qty = 1;
      return piece;
    }
    list.splice(idx, 1);
    return e;
  }

  /** 把一件物品放回列表：普通物品并回同类，实例物品原样保留字段。 */
  function putPiece(list, piece, customItems) {
    var def = getDef(piece.defId, customItems);
    if (isStackable(def) && !piece.remark) {
      for (var i = 0; i < list.length; i++) {
        if (list[i].defId === piece.defId && !list[i].remark) {
          list[i].qty += piece.qty;
          return list[i];
        }
      }
    }
    var copy = clone(piece);
    if (findEntry(list, copy.id)) copy.id = uid('it');
    list.push(copy);
    return copy;
  }

  /** 按物品拿走 n 件，返回拿走的件（含实例字段，供撤销时原样放回）。 */
  function takeDef(list, defId, n) {
    var taken = [];
    while (taken.length < n) {
      var entry = null;
      for (var i = 0; i < list.length; i++) if (list[i].defId === defId) { entry = list[i]; break; }
      if (!entry) break;
      taken.push(takeOnePiece(list, entry.id));
    }
    return taken;
  }

  /** 物品条目的简短描述（含实例状态），用于日志与交接文本。 */
  function describeEntry(entry, customItems, opts) {
    var def = getDef(entry.defId, customItems);
    var parts = [def.name];
    if (def.instance === 'uses') parts.push('（剩' + entry.uses + '次）');
    if (def.instance === 'notes') parts.push('（笔记' + (entry.notes ? entry.notes.length : 0) + '条' + (entry.condition === 'damaged' ? '·损坏' : '') + '）');
    if (def.instance === 'water') parts.push('（储水' + (entry.water || 0) + '/' + (def.maxWater || 2) + '）');
    if (def.instance === 'condition') parts.push(entry.condition === 'damaged' ? '（破损）' : '（完好）');
    if (!(opts && opts.noQty) && entry.qty > 1) parts.push('×' + entry.qty);
    if (entry.remark) parts.push('〔' + entry.remark + '〕');
    return parts.join('');
  }

  /**
   * 解析「面包+2，子弹-1」「普通水×3」「能量棒 2」这类批量录入文本。
   * 返回 { items: [{defId, qty}], errors: [...] }，qty 可为负（表示扣除）。
   */
  function parseItemList(text, customItems) {
    var items = [];
    var errors = [];
    String(text || '').split(/[，,、;；\n]+/).forEach(function (raw) {
      var part = raw.trim();
      if (!part) return;
      var m = part.match(/^(.+?)\s*(?:([+\-＋－])\s*)?(?:[x×*]\s*)?(\d+)?$/i);
      if (!m) { errors.push('看不懂：「' + part + '」'); return; }
      var def = findDefByName(m[1], customItems);
      if (!def) { errors.push('未知物品：「' + m[1].trim() + '」'); return; }
      var qty = m[3] ? parseInt(m[3], 10) : 1;
      if (qty === 0) { errors.push('数量为0：「' + part + '」'); return; }
      if (m[2] === '-' || m[2] === '－') qty = -qty;
      items.push({ defId: def.id, qty: qty });
    });
    return { items: items, errors: errors };
  }

  function formatItemList(items, customItems, signed) {
    return items.map(function (it) {
      var name = getDef(it.defId, customItems).name;
      if (signed) return name + (it.qty > 0 ? '+' : '') + it.qty;
      return name + '×' + it.qty;
    }).join('，');
  }

  // ---------------------------------------------------------------- 公共池与每日发放

  /**
   * 从公共池无放回抽 n 件（按实际件数，不是按单位容量）。
   * 默认每件等概率；weights[defId] 可改权重（实现建议）。
   * 公共池不足时不生成不存在的物资，返回 { ok:false, available }。
   */
  function drawPieces(pool, n, opts) {
    opts = opts || {};
    var rng = opts.rng || Math.random;
    var weights = opts.weights || {};
    if (!isInt(n) || n <= 0) return { ok: false, reason: '抽取数量必须是正整数', available: countPieces(pool) };
    var available = countPieces(pool);
    if (available < n) return { ok: false, reason: '公共池只有 ' + available + ' 件，不足 ' + n + ' 件', available: available };
    var pieces = [];
    for (var k = 0; k < n; k++) {
      var idx = weightedIndex(pool, function (e) {
        var w = weights[e.defId];
        return (isNum(w) ? w : 1) * e.qty;
      }, rng);
      if (idx < 0) return { ok: false, reason: '剩余物品的权重都为 0，无法抽取', available: countPieces(pool), partial: pieces };
      pieces.push(takeOnePiece(pool, pool[idx].id));
    }
    return { ok: true, pieces: pieces };
  }

  /**
   * 生成一个分配批次：抽到的物品从公共池扣除，存进 batch.items（刷新不会重抽）。
   * pickOrder 为参与者按当前座次的领取顺序。
   */
  function createBatch(pool, opts) {
    var participants = opts.participantIds || [];
    var n = isInt(opts.count) ? opts.count : participants.length;
    var res = drawPieces(pool, n, opts);
    if (!res.ok) {
      if (res.partial) res.partial.forEach(function (p) { putPiece(pool, p, opts.customItems); });
      return res;
    }
    var seat = opts.seatOrder || participants;
    var order = seat.filter(function (id) { return participants.indexOf(id) >= 0; });
    participants.forEach(function (id) { if (order.indexOf(id) < 0) order.push(id); });
    return {
      ok: true,
      batch: {
        id: uid('batch'),
        day: opts.day == null ? null : opts.day,
        kind: opts.kind || 'daily',
        label: opts.label || '每日补给',
        participantIds: participants.slice(),
        pickOrder: order,
        items: res.pieces,
        picks: [],
        status: 'open',
        createdAt: opts.now || Date.now()
      }
    };
  }

  /** 某人从批次中选一件；被选物品从本批候选移除，不能再被选。 */
  function pickFromBatch(batch, playerId, pieceId, now) {
    if (batch.status !== 'open') return { ok: false, reason: '该批次已结束' };
    if (batch.participantIds.indexOf(playerId) < 0) return { ok: false, reason: '该玩家不在本批领取名单中' };
    for (var i = 0; i < batch.picks.length; i++) {
      if (batch.picks[i].playerId === playerId) return { ok: false, reason: '该玩家本批已领取过' };
    }
    var idx = indexOfEntry(batch.items, pieceId);
    if (idx < 0) return { ok: false, reason: '该物品已被选走或不在本批候选中' };
    var piece = batch.items.splice(idx, 1)[0];
    var pick = { playerId: playerId, piece: piece, at: now || Date.now() };
    batch.picks.push(pick);
    return { ok: true, pick: pick };
  }

  /** 撤回某人的选择：物品回到本批候选。 */
  function unpickFromBatch(batch, playerId) {
    if (batch.status !== 'open') return { ok: false, reason: '该批次已结束' };
    for (var i = 0; i < batch.picks.length; i++) {
      if (batch.picks[i].playerId === playerId) {
        var pick = batch.picks.splice(i, 1)[0];
        batch.items.push(pick.piece);
        return { ok: true, pick: pick };
      }
    }
    return { ok: false, reason: '该玩家本批尚未领取' };
  }

  /** 结束批次：未被选走的物品放回公共池。 */
  function closeBatch(pool, batch, customItems) {
    if (batch.status !== 'open') return { ok: false, reason: '该批次已结束' };
    var returned = batch.items.length;
    batch.items.forEach(function (p) { putPiece(pool, p, customItems); });
    batch.items = [];
    batch.status = 'closed';
    return { ok: true, returned: returned };
  }

  /**
   * 撤销整个批次：抽到的物品（含已被领取的）全部原样归还公共池，
   * 并返回已领取者名单——他们需要在玩家页手动撤销，系统不会替玩家改库存。
   */
  function undoBatch(pool, batch, customItems) {
    if (batch.status === 'undone') return { ok: false, reason: '该批次已撤销' };
    var takers = batch.picks.map(function (p) { return { playerId: p.playerId, piece: p.piece }; });
    batch.items.forEach(function (p) { putPiece(pool, p, customItems); });
    batch.picks.forEach(function (p) { putPiece(pool, p.piece, customItems); });
    batch.items = [];
    batch.status = 'undone';
    return { ok: true, takers: takers };
  }

  // ---------------------------------------------------------------- 阶段、座次与行动

  var PHASES = {
    setup: { no: 0, name: '开局准备', desc: '登记玩家、设计开局物资：每名玩家先领取两次，方式由主持人决定。' },
    night: { no: 1, name: '昨夜结果', desc: '公布前一晚的守夜结果，主持人确认状态与营救进度变化。首日无结果可跳过。' },
    supply: { no: 2, name: '资源补给', desc: '按当前座次领取物资。' },
    exchange: { no: 3, name: '自由交流', desc: '讨论、交易、赠予及预先协商换位，均不收费；尚不锁定个人行动。' },
    rotation: { no: 4, name: '每日轮换', desc: '当前末位移到首位，其余人后移。每日只执行一次。' },
    actions: { no: 5, name: '个人行动', desc: '按轮换后的固定顺序逐人决定并结算；每人一次行动：使用技能、尝试换位或计划守夜名单。' },
    watch: { no: 6, name: '确认守夜', desc: '多人提交时，由实际换位后的末位玩家选择最终名单。' },
    event: { no: null, name: '公共事件', desc: '每日一次判定：80%触发需要投票的公共事件，20%无事件。' }
  };

  function phaseSequence(rules) {
    var seq = ['night', 'supply', 'exchange', 'rotation', 'actions', 'watch'];
    if (rules && rules.eventPosition === 'beforeSupply') seq.splice(1, 0, 'event');
    else if (rules && rules.eventPosition === 'afterWatch') seq.push('event');
    return seq;
  }

  function phaseLabel(phase) {
    var p = PHASES[phase];
    if (!p) return phase;
    return (p.no ? '阶段' + p.no + ' · ' : '') + p.name;
  }

  /** 每日轮换：末位移到首位，其余后移。 */
  function rotateSeats(seatOrder) {
    if (seatOrder.length < 2) return seatOrder.slice();
    return [seatOrder[seatOrder.length - 1]].concat(seatOrder.slice(0, -1));
  }

  /** 换位只改实际座次。 */
  function swapSeats(seatOrder, a, b) {
    var s = seatOrder.slice();
    var i = s.indexOf(a);
    var j = s.indexOf(b);
    if (i < 0 || j < 0) throw new Error('换位双方必须都在座次中');
    var tmp = s[i];
    s[i] = s[j];
    s[j] = tmp;
    return s;
  }

  /** 末位玩家：守夜最终名单的拍板者，取最新的实际座次。 */
  function lastSeat(seatOrder) {
    return seatOrder.length ? seatOrder[seatOrder.length - 1] : null;
  }

  function nextActor(actionOrder, actedIds) {
    if (!actionOrder) return null;
    for (var i = 0; i < actionOrder.length; i++) {
      if (actedIds.indexOf(actionOrder[i]) < 0) return actionOrder[i];
    }
    return null;
  }

  function newToday() {
    return {
      rotationDone: false,
      actionOrder: null,
      actedIds: [],
      actions: [],
      swapRequests: [],
      plannerIds: [],
      skillUserIds: [],
      watchCandidates: [],
      randomWatch: null,
      watchDecision: null,
      finalWatch: null,
      eventCheck: null,
      eventFlow: null,
      nightPublished: false,
      batchIds: []
    };
  }

  /** 今天是否已经记录了需要提醒的数据（跨日回退前确认用）。 */
  function todayHasData(today) {
    return !!(today.rotationDone || today.actedIds.length || today.plannerIds.length || today.skillUserIds.length ||
      today.watchCandidates.length || today.finalWatch || today.randomWatch || today.eventCheck || today.eventFlow ||
      today.nightPublished || today.batchIds.length || today.swapRequests.length);
  }

  /** 执行每日轮换；同一天第二次调用会被拒绝。 */
  function applyRotation(state) {
    if (state.today.rotationDone) return { ok: false, reason: '今日已轮换过，不会重复轮换' };
    state.seatOrder = rotateSeats(state.seatOrder);
    state.today.rotationDone = true;
    return { ok: true };
  }

  /**
   * 进入个人行动阶段：把 seatOrder 复制为 actionOrder，整轮保持不变。
   * 本轮已有记录后再进入（例如回退再前进）时保留原顺序，避免有人重复行动或漏行动。
   */
  function beginActions(state) {
    var t = state.today;
    // 只要本轮已有任何行动或换位记录，就保留原顺序（换位后回退再前进也不会按新座次重排）
    if (t.actionOrder && (t.actedIds.length || t.actions.length || t.swapRequests.length)) return { ok: true, kept: true };
    t.actionOrder = state.seatOrder.slice();
    return { ok: true, kept: false };
  }

  /**
   * 记录一次个人行动。
   * rec: { type: 'skill'|'swap'|'plan'|'other'|'pass', note, ends (默认 true) }
   * 计划守夜的人进入 plannerIds、使用技能的人进入 skillUserIds（当日记录，不从座位推断）。
   */
  function recordAction(state, playerId, rec) {
    var t = state.today;
    if (!t.actionOrder) return { ok: false, reason: '尚未进入个人行动阶段' };
    if (t.actionOrder.indexOf(playerId) < 0) return { ok: false, reason: '该玩家不在本轮行动顺序中' };
    if (t.actedIds.indexOf(playerId) >= 0 && rec.type !== 'swap') return { ok: false, reason: '该玩家本轮已行动' };
    var action = { id: uid('act'), playerId: playerId, type: rec.type, note: rec.note || '', at: rec.now || Date.now() };
    t.actions.push(action);
    if (rec.type === 'plan' && t.plannerIds.indexOf(playerId) < 0) t.plannerIds.push(playerId);
    if (rec.type === 'skill' && t.skillUserIds.indexOf(playerId) < 0) t.skillUserIds.push(playerId);
    if (rec.ends !== false && t.actedIds.indexOf(playerId) < 0) t.actedIds.push(playerId);
    return { ok: true, action: action };
  }

  /** 撤销某人本轮的行动标记（不处理换位，换位请用撤销最近操作）。 */
  function undoAction(state, playerId) {
    var t = state.today;
    t.actedIds = t.actedIds.filter(function (id) { return id !== playerId; });
    t.actions = t.actions.filter(function (a) { return a.playerId !== playerId || a.type === 'swap'; });
    t.plannerIds = t.plannerIds.filter(function (id) { return id !== playerId; });
    t.skillUserIds = t.skillUserIds.filter(function (id) { return id !== playerId; });
    t.watchCandidates = t.watchCandidates.filter(function (c) { return c.plannerId !== playerId; });
    return { ok: true };
  }

  /**
   * 记录一次换位请求。同意才生效，只改 seatOrder，不改本轮 actionOrder。
   * 请求次数上限默认3次，主持人可覆盖；失败是否仍耗行动、被请求者是否支付行动未定——由 ends / targetPays 显式传入。
   */
  function requestSwap(state, req) {
    var t = state.today;
    var limit = state.rules.swapRequestLimit;
    var used = t.swapRequests.filter(function (r) { return r.fromId === req.fromId; }).length;
    if (isInt(limit) && used >= limit && !req.override) {
      return { ok: false, reason: '该玩家今日已发起 ' + used + ' 次换位请求（上限 ' + limit + '）', limitReached: true };
    }
    if (req.fromId === req.toId) return { ok: false, reason: '不能和自己换位' };
    if (state.seatOrder.indexOf(req.fromId) < 0 || state.seatOrder.indexOf(req.toId) < 0) {
      return { ok: false, reason: '换位双方必须都在座次中' };
    }
    var record = {
      id: uid('swap'),
      fromId: req.fromId,
      toId: req.toId,
      accepted: !!req.accepted,
      ends: !!req.ends,
      targetPays: !!req.targetPays,
      override: !!req.override,
      seatBefore: state.seatOrder.slice(),
      at: req.now || Date.now()
    };
    if (record.accepted) state.seatOrder = swapSeats(state.seatOrder, req.fromId, req.toId);
    record.seatAfter = state.seatOrder.slice();
    t.swapRequests.push(record);
    if (t.actionOrder && t.actionOrder.indexOf(req.fromId) >= 0) {
      t.actions.push({ id: uid('act'), playerId: req.fromId, type: 'swap', note: '换位请求→' + req.toId + (record.accepted ? '（同意）' : '（拒绝）'), at: record.at });
      if (record.ends && t.actedIds.indexOf(req.fromId) < 0) t.actedIds.push(req.fromId);
    }
    if (record.targetPays && t.actedIds.indexOf(req.toId) < 0) t.actedIds.push(req.toId);
    return { ok: true, record: record };
  }

  /** 把今天归档并开启新的一天。昨夜结果草稿（pendingNightResult）保留到次日阶段1公布。 */
  function advanceDay(state) {
    state.history.push({ day: state.day, seatOrderEnd: state.seatOrder.slice(), today: state.today });
    state.day += 1;
    state.today = newToday();
    state.phase = phaseSequence(state.rules)[0];
  }

  /** 跨日回退：恢复前一天的当日记录与当天结束时的座次。 */
  function retreatDay(state) {
    var rec = state.history.pop();
    if (!rec) return false;
    var droppedDay = state.day;
    state.publicFeed = state.publicFeed.filter(function (f) { return f.day !== droppedDay; });
    if (state.today.nightPublished && state.pendingNightResult) state.pendingNightResult.publishedDay = null;
    state.day = rec.day;
    state.today = rec.today;
    state.seatOrder = rec.seatOrderEnd.slice();
    var seq = phaseSequence(state.rules);
    state.phase = seq[seq.length - 1];
    return true;
  }

  // ---------------------------------------------------------------- 守夜

  var WATCH_KINDS = [
    { id: 'designated', name: '指定N人', people: true },
    { id: 'planners', name: '今天计划过名单的人', people: true },
    { id: 'skillUsers', name: '今天使用过技能的人', people: true },
    { id: 'everyone', name: '全员', people: true },
    { id: 'rescue', name: '更可能获得营救信息', people: false },
    { id: 'danger', name: '更可能遭遇不测', people: false }
  ];

  var WATCH_COMBINE = [
    { id: 'single', name: '单条（不混合）' },
    { id: 'union', name: '叠加：人员取并集' },
    { id: 'pending', name: '组合方式待定：主持人预览确认' }
  ];

  var TENDENCY_NAMES = { neutral: '中性', rescue: '更可能获得营救信息', danger: '更可能遭遇不测' };

  function watchKindName(kind, count) {
    if (kind === 'designated') return '指定' + (count || 2) + '人';
    for (var i = 0; i < WATCH_KINDS.length; i++) if (WATCH_KINDS[i].id === kind) return WATCH_KINDS[i].name;
    return kind;
  }

  /** 默认名单模板：说明里列出的六种条目各一条，单条不混合。 */
  function defaultWatchTemplates() {
    return WATCH_KINDS.map(function (k) {
      return {
        id: 'wt_' + k.id,
        name: k.id === 'designated' ? '指定两人' : k.name,
        entries: [{ kind: k.id, count: k.id === 'designated' ? 2 : null }],
        combine: 'single',
        weight: 1,
        enabled: true,
        note: k.people ? '' : '只表达风险倾向，不含对象：确认时由主持人指定人员。'
      };
    });
  }

  function newWatchTemplate() {
    return { id: uid('wt'), name: '新名单模板', entries: [{ kind: 'designated', count: 2 }], combine: 'pending', weight: 1, enabled: true, note: '' };
  }

  /** 为一份名单模板生成候选：「指定N人」在生成时就抽定人员并保存，刷新不变。 */
  function makeWatchOption(template, aliveIds, rng, watchSize) {
    var opt = { id: uid('wo'), templateId: template.id, template: clone(template), designatedIds: null };
    for (var i = 0; i < template.entries.length; i++) {
      var e = template.entries[i];
      if (e.kind === 'designated') {
        var n = isInt(e.count) && e.count > 0 ? e.count : watchSize || 2;
        opt.designatedIds = sample(aliveIds, n, rng);
        break;
      }
    }
    return opt;
  }

  /** 计划者获得两份随机名单（模板无放回加权抽取）。 */
  function drawWatchOptions(templates, aliveIds, rng, watchSize) {
    var pool = (templates || []).filter(function (t) { return t.enabled; });
    var out = [];
    while (out.length < 2 && pool.length) {
      var idx = weightedIndex(pool, function (t) { return t.weight == null ? 1 : t.weight; }, rng);
      if (idx < 0) break;
      out.push(makeWatchOption(pool.splice(idx, 1)[0], aliveIds, rng, watchSize));
    }
    return out;
  }

  /**
   * 把名单解析成具体人员。按行为选人的条目从当日记录（plannerIds / skillUserIds）解析，
   * 不从当前座位推断；最终确认时由调用方保存人员快照。
   * ctx: { plannerIds, skillUserIds, aliveIds }
   */
  function resolveWatchOption(opt, ctx) {
    var people = [];
    var tendencies = [];
    var peopleEntries = 0;
    var notes = [];
    (opt.template.entries || []).forEach(function (e) {
      var ids = null;
      if (e.kind === 'designated') ids = opt.designatedIds || [];
      else if (e.kind === 'planners') ids = ctx.plannerIds || [];
      else if (e.kind === 'skillUsers') ids = ctx.skillUserIds || [];
      else if (e.kind === 'everyone') ids = ctx.aliveIds || [];
      else if (tendencies.indexOf(e.kind) < 0) tendencies.push(e.kind);
      if (ids) {
        peopleEntries += 1;
        ids.forEach(function (id) {
          if (people.indexOf(id) < 0 && (ctx.aliveIds || []).indexOf(id) >= 0) people.push(id);
        });
      }
    });
    var needsHost = false;
    if (peopleEntries === 0) {
      needsHost = true;
      notes.push('该名单没有指定对象：请主持人指定守夜人员。');
    } else if (peopleEntries > 1 && opt.template.combine !== 'union') {
      needsHost = true;
      notes.push('多条目的组合方式未定：已按并集预览，请主持人确认。');
    }
    if (peopleEntries > 0 && people.length === 0) {
      needsHost = true;
      notes.push('按当日记录解析后没有人：请主持人裁定。');
    }
    return { memberIds: people, tendencies: tendencies, needsHost: needsHost, notes: notes };
  }

  /** 0 份提交：系统随机；1 份：直接成为最终名单；2 份及以上：末位从所有提交中选择。 */
  function watchMode(submittedCount) {
    if (!isInt(submittedCount) || submittedCount <= 0) return 'random';
    return submittedCount === 1 ? 'single' : 'decider';
  }

  function submittedCandidates(today) {
    return (today.watchCandidates || []).filter(function (c) { return isInt(c.chosenIndex); });
  }

  /** 名单的人类可读描述（私信文本用）。nameOf: id → 姓名 */
  function describeWatchOption(opt, nameOf) {
    var entries = opt.template.entries || [];
    var parts = entries.map(function (e) {
      var detail = '';
      if (e.kind === 'designated') {
        var names = (opt.designatedIds || []).map(nameOf).join('、');
        detail = names ? '：' + names : '';
      } else if (e.kind === 'planners' || e.kind === 'skillUsers') {
        detail = '（按当日记录结算）';
      }
      return { label: watchKindName(e.kind, e.count), detail: detail };
    });
    var name = opt.template.name;
    // 单条名单且名称就是条目本身（如「指定两人」「全员」）时不重复书写
    if (parts.length === 1 && (parts[0].label === name || entries[0].kind === 'designated')) return '「' + name + '」' + parts[0].detail;
    var combine = '';
    if (entries.length > 1) {
      for (var i = 0; i < WATCH_COMBINE.length; i++) if (WATCH_COMBINE[i].id === opt.template.combine) combine = '｜' + WATCH_COMBINE[i].name;
    }
    return '「' + name + '」' + parts.map(function (p) { return p.label + p.detail; }).join(' + ') + combine;
  }

  /** 夜间遭遇按权重抽取：只有候选结果全部填了权重才允许自动抽签。 */
  function nightDrawable(entries) {
    if (!entries.length) return false;
    return entries.every(function (e) { return isNum(e.weight) && e.weight >= 0; }) &&
      entries.some(function (e) { return e.weight > 0; });
  }

  function newNightResult() {
    return { id: uid('nr'), name: '', text: '', tendency: 'neutral', weight: null, isDemo: false };
  }

  // ---------------------------------------------------------------- 公共事件

  function emptyEffects() {
    return { rescue: null, pool: [], personal: { target: '', hp: null, hunger: null, thirst: '', status: '', items: [], mapNotes: null, note: '' } };
  }

  function newOutcome() {
    return { id: uid('oc'), text: '', probability: null, effects: emptyEffects() };
  }

  function newOption(label) {
    return { id: uid('op'), label: label || '', outcomes: [newOutcome()] };
  }

  function newEvent() {
    return {
      id: uid('ev'), name: '', body: '', location: '', tags: [], isDraft: true, isDemo: false,
      participants: '', carryTicks: null, conditions: '', itemUses: '', modifiers: '',
      options: [newOption('参与'), newOption('拒绝')]
    };
  }

  /** 同一分支的结果概率合计100%（且没有空值）才允许自动抽签。 */
  function probabilityStatus(option) {
    var outs = (option && option.outcomes) || [];
    if (!outs.length) return { complete: false, sum: 0, reason: '没有结果' };
    var sum = 0;
    var missing = 0;
    outs.forEach(function (o) {
      if (isNum(o.probability)) sum += o.probability;
      else missing += 1;
    });
    sum = Math.round(sum * 1000) / 1000;
    if (missing) return { complete: false, sum: sum, reason: missing + ' 个结果未填概率' };
    if (Math.abs(sum - 100) > 1e-6) return { complete: false, sum: sum, reason: '概率合计 ' + sum + '%，不是100%' };
    return { complete: true, sum: 100, reason: '' };
  }

  /** 按分支概率抽签；概率不完整时返回 null（改为手动录入结果）。 */
  function drawOutcome(option, rng) {
    if (!probabilityStatus(option).complete) return null;
    var roll = (rng || Math.random)() * 100;
    var acc = 0;
    for (var i = 0; i < option.outcomes.length; i++) {
      acc += option.outcomes[i].probability;
      if (roll < acc) return { outcomeId: option.outcomes[i].id, roll: roll };
    }
    return { outcomeId: option.outcomes[option.outcomes.length - 1].id, roll: roll };
  }

  /** 每日事件判定：只决定是否触发，与事件本身的成功率无关。roll 为 0～99 的整数。 */
  function rollEventTrigger(chance, rng) {
    var roll = Math.floor((rng || Math.random)() * 100);
    return { roll: roll, chance: chance, triggered: roll < chance };
  }

  /** 事件效果需要从公共池扣除、但池里不够的物品。收益（正数）不算执行前必需物资。 */
  function poolShortages(pool, delta) {
    var need = {};
    (delta || []).forEach(function (d) {
      if (d.qty < 0) need[d.defId] = (need[d.defId] || 0) - d.qty;
    });
    return Object.keys(need).map(function (id) {
      return { defId: id, need: need[id], have: countDef(pool, id) };
    }).filter(function (s) { return s.have < s.need; });
  }

  /** 应用公共池增减，返回可精确回滚的变更记录。调用前应先用 poolShortages 检查。 */
  function applyPoolDelta(pool, delta, opts) {
    var changes = [];
    (delta || []).forEach(function (d) {
      if (d.qty > 0) {
        addItem(pool, d.defId, d.qty, opts);
        changes.push({ type: 'add', defId: d.defId, qty: d.qty });
      } else if (d.qty < 0) {
        var removed = takeDef(pool, d.defId, -d.qty);
        changes.push({ type: 'remove', defId: d.defId, removed: removed });
      }
    });
    return changes;
  }

  /** 回滚公共池变更。加入的物品若已被发放导致池里不够，返回 problems 由主持人处理。 */
  function revertPoolChanges(pool, changes, customItems) {
    var problems = [];
    for (var i = changes.length - 1; i >= 0; i--) {
      var c = changes[i];
      if (c.type === 'add') {
        var taken = takeDef(pool, c.defId, c.qty);
        if (taken.length < c.qty) problems.push(getDef(c.defId, customItems).name + ' 少了 ' + (c.qty - taken.length) + ' 件（可能已被发放）');
      } else if (c.type === 'remove') {
        c.removed.forEach(function (p) { putPiece(pool, p, customItems); });
      }
    }
    return { ok: problems.length === 0, problems: problems };
  }

  /** 个人效果只生成通知文本：系统不会修改玩家私人物品。 */
  function describePersonalEffects(personal, customItems) {
    if (!personal) return '';
    var parts = [];
    if (isNum(personal.hp) && personal.hp !== 0) parts.push('生命' + (personal.hp > 0 ? '+' : '') + personal.hp);
    if (isNum(personal.hunger) && personal.hunger !== 0) parts.push('饥饿值' + (personal.hunger > 0 ? '+' : '') + personal.hunger);
    if (personal.thirst) parts.push('口渴：' + personal.thirst);
    if (personal.status) parts.push('状态：' + personal.status);
    if (personal.items && personal.items.length) parts.push('物品：' + formatItemList(personal.items, customItems, true));
    if (isNum(personal.mapNotes) && personal.mapNotes !== 0) parts.push('地图笔记' + (personal.mapNotes > 0 ? '+' : '') + personal.mapNotes);
    if (personal.note) parts.push(personal.note);
    return parts.join('；');
  }

  function validateEvent(ev) {
    var issues = [];
    if (!String(ev.name || '').trim()) issues.push('缺少名称');
    if (!ev.options || !ev.options.length) issues.push('至少需要一个选项');
    (ev.options || []).forEach(function (op, i) {
      if (!String(op.label || '').trim()) issues.push('选项' + (i + 1) + '缺少名称');
      if (!op.outcomes || op.outcomes.length < 1) issues.push('选项' + (i + 1) + '没有结果');
    });
    return issues;
  }

  /** 导入的事件补齐字段；id 冲突时换新 id。 */
  function normalizeEvent(raw, existingIds) {
    var ev = Object.assign(newEvent(), clone(raw) || {});
    if (!ev.id || (existingIds && existingIds.indexOf(ev.id) >= 0)) ev.id = uid('ev');
    ev.tags = Array.isArray(ev.tags) ? ev.tags.map(String) : String(ev.tags || '').split(/[，,]/).map(function (s) { return s.trim(); }).filter(Boolean);
    ev.isDraft = ev.isDraft !== false;
    ev.isDemo = !!ev.isDemo;
    ev.options = (Array.isArray(ev.options) ? ev.options : []).map(function (op) {
      var o = Object.assign(newOption(''), op || {});
      o.id = o.id || uid('op');
      o.outcomes = (Array.isArray(o.outcomes) ? o.outcomes : []).map(function (oc) {
        var out = Object.assign(newOutcome(), oc || {});
        out.id = out.id || uid('oc');
        out.probability = isNum(out.probability) ? out.probability : null;
        var fx = Object.assign(emptyEffects(), out.effects || {});
        fx.personal = Object.assign(emptyEffects().personal, (out.effects && out.effects.personal) || {});
        fx.pool = Array.isArray(fx.pool) ? fx.pool : [];
        fx.personal.items = Array.isArray(fx.personal.items) ? fx.personal.items : [];
        out.effects = fx;
        return out;
      });
      return o;
    });
    return ev;
  }

  // ---------------------------------------------------------------- 计分

  var JEWEL_TABLE = [0, 1, 4, 8, 11, 15];

  /** 珠宝查表；超过5件返回 null（需主持人计分，不自行外推）。 */
  function jewelScore(n) {
    if (!isInt(n) || n < 0) return null;
    return n <= 5 ? JEWEL_TABLE[n] : null;
  }

  function wealthCounts(list) {
    return { cash: countDef(list, 'cash'), painting: countDef(list, 'painting'), jewel: countDef(list, 'jewel') };
  }

  /** 财富基础分 = 钞票×1 + 名画×6 + 珠宝查表；死亡后不保留财富分。 */
  function wealthScore(counts, dead) {
    if (dead) return { score: 0, pending: false, text: '死亡后不保留财富分' };
    var j = jewelScore(counts.jewel || 0);
    var base = (counts.cash || 0) + 6 * (counts.painting || 0);
    if (j == null) return { score: null, pending: true, base: base, text: '珠宝超过5件：需主持人计分' };
    return { score: base + j, pending: false, text: '' };
  }

  function mapNotesTotal(list) {
    return list.reduce(function (sum, e) {
      return sum + (e.defId === 'map' && e.notes ? e.notes.length : 0);
    }, 0);
  }

  var SCORE_PARTS = [
    { key: 'wealth', label: '财富分' },
    { key: 'map', label: '地图分' },
    { key: 'loveHate', label: '爱恨分' },
    { key: 'survival', label: '生存分' },
    { key: 'task', label: '任务分' }
  ];

  /** 结算合计：任一部分未填即为「部分分数／待裁定」，不能显示为完整最终排名。 */
  function settlementTotal(row) {
    var total = 0;
    var missing = [];
    SCORE_PARTS.forEach(function (p) {
      if (isNum(row[p.key])) total += row[p.key];
      else missing.push(p.label);
    });
    if (isNum(row.adjust)) total += row.adjust;
    return { total: total, partial: missing.length > 0, missing: missing };
  }

  // ---------------------------------------------------------------- 战斗力

  /**
   * 基础战斗力 = 当前生命。武器加成只列出，不擅自决定是否叠加（未定）。
   * 步枪只有在携带了子弹时才给出 +6；否则标注「无弹，仅可恐吓」。
   */
  function combatSummary(hp, carriedEntries, customItems, tempAttack) {
    var weapons = [];
    var hasAmmo = carriedEntries.some(function (e) { return e.defId === 'ammo'; });
    carriedEntries.forEach(function (e) {
      var def = getDef(e.defId, customItems);
      if (!def.attack) return;
      if (def.needsAmmo && !hasAmmo) weapons.push({ name: def.name, bonus: 0, note: '无弹，仅可恐吓' });
      else weapons.push({ name: def.name, bonus: def.attack, note: '' });
    });
    var bonuses = weapons.map(function (w) { return w.bonus; });
    var temp = isNum(tempAttack) ? tempAttack : 0;
    var base = isNum(hp) ? hp : 0;
    return {
      base: base,
      weapons: weapons,
      temp: temp,
      stacked: base + bonuses.reduce(function (a, b) { return a + b; }, 0) + temp,
      bestOnly: base + (bonuses.length ? Math.max.apply(null, bonuses) : 0) + temp,
      multiple: bonuses.filter(function (b) { return b > 0; }).length > 1
    };
  }

  // ---------------------------------------------------------------- 玩家总览

  var ALERT_ORDER = { critical: 0, warning: 1, info: 2 };

  /** 携带中物品的占位（按引用的库存实例计算，不复制物品）。 */
  function loadoutTicks(s) {
    if (!s.loadout) return 0;
    return s.loadout.items.reduce(function (sum, row) {
      var e = findEntry(s.inventory, row.entryId);
      return sum + (e ? row.qty * (getDef(e.defId, s.customItems).capacityTicks || 0) : 0);
    }, 0);
  }

  /**
   * 玩家总览的提醒：只汇总已经记录下来的事实与已确认规则，不推导新规则。
   * level: critical（严重）／warning（注意）／info（提示）；tab: 去哪一页处理。
   */
  function playerAlerts(s) {
    var out = [];
    var r = s.rules;
    var day = s.publicInfo ? s.publicInfo.day : null;
    if (s.alive === false) out.push({ level: 'info', text: '已标记死亡：财富分不保留，爱恨与任务分保留', tab: 'status' });
    if (isNum(s.hp) && s.hp <= 0) out.push({ level: 'critical', text: '生命为 0：处理方式与死亡时点待主持人裁定', tab: 'status' });
    if (s.thirst === '脱水') out.push({ level: 'critical', text: '脱水：直接昏迷', tab: 'status' });
    else if (s.thirst === '口渴') out.push({ level: 'warning', text: '口渴：补水幅度待定，饮水后手动调整', tab: 'status' });
    if (s.consciousness === '昏迷' && s.thirst !== '脱水') out.push({ level: 'critical', text: '昏迷中：如何解除尚未确定', tab: 'status' });
    var hz = hungerZone(s.hunger, r) || s.hungerManual;
    if (hz === '饥荒') out.push({ level: 'critical', text: '饥荒：比饥饿更严重，后果待主持人裁定', tab: 'status' });
    else if (hz === '饥饿') out.push({ level: 'warning', text: '饥饿：相关成功率降低', tab: 'status' });
    (s.statuses || []).forEach(function (st) {
      if (st.statusId === 'bleeding' && isInt(st.nextDay) && isInt(day) && day >= st.nextDay) {
        out.push({ level: 'warning', text: '流血伤口第 ' + st.nextDay + ' 天到期：先与主持人确认是否扣1生命', tab: 'status' });
      }
    });
    var used = listTicks(s.inventory, s.customItems, r);
    if (isInt(r.inventoryCapacityTicks) && used > r.inventoryCapacityTicks) {
      out.push({ level: 'warning', text: '库存超出上限 ' + fmtUnits(used - r.inventoryCapacityTicks) + ' 单位（只警告，由主持人裁定）', tab: 'inventory' });
    }
    if (s.loadout) {
      var carried = loadoutTicks(s);
      var label = s.loadout.context === 'event' ? '事件' : '守夜';
      if (isInt(s.loadout.limitTicks) && carried > s.loadout.limitTicks) {
        out.push({ level: 'warning', text: label + '携带超出上限 ' + fmtUnits(carried - s.loadout.limitTicks) + ' 单位', tab: 'inventory' });
      }
      out.push(s.loadout.confirmed
        ? { level: 'info', text: label + '携带中：' + fmtUnits(carried) + ' 单位；结果出来后处理高亮物品，再点「结束携带」', tab: 'inventory' }
        : { level: 'info', text: '正在挑选' + label + '携带：已选 ' + fmtUnits(carried) + ' 单位，确认后才生效', tab: 'inventory' });
    }
    if (s.scavenge && s.scavenge.status === 'running') {
      out.push({ level: 'warning', text: '搜刮进行中：第 ' + s.scavenge.rounds.length + '／' + s.scavenge.cfg.rounds + ' 轮，超时会自动选默认项', tab: 'scavenge' });
    } else if (s.scavenge && s.scavenge.status === 'organize') {
      out.push({ level: 'warning', text: '搜刮三轮已完成：待整理并一次性提交', tab: 'scavenge' });
    }
    if (s.alive !== false && !(s.action && s.action.day === day && s.action.used)) {
      out.push({ level: 'info', text: '第 ' + day + ' 天的个人行动未标记为已使用', tab: 'action' });
    }
    return out.sort(function (a, b) { return ALERT_ORDER[a.level] - ALERT_ORDER[b.level]; });
  }

  /**
   * 主持台的待办：只看已经记录下来的进度，不推导新规则。
   * 主持台可以屏幕共享，所以文字只用公开信息（人名、件数、份数），绝不带物品、候选或事件内容。
   * level 同 playerAlerts；tab: 去哪一页处理（'flow' 表示就在主持台的当前阶段卡里）。
   */
  function hostAlerts(s) {
    var out = [];
    var t = s.today;
    var r = s.rules;
    function nameOf(id) {
      var p = s.players.filter(function (x) { return x.id === id; })[0];
      return p ? p.name : '（已移除）';
    }
    var alive = s.players.filter(function (p) { return p.alive !== false; });
    var aliveIds = alive.map(function (p) { return p.id; });

    if (!s.players.length) out.push({ level: 'critical', text: '还没有登记玩家', tab: 'settings' });
    if (!s.started && s.players.length) {
      var done = s.opening.done.filter(Boolean).length;
      if (done < 2) out.push({ level: 'warning', text: '开局领取完成 ' + done + '／2 次', tab: 'supply' });
    }
    var unseated = alive.filter(function (p) { return s.seatOrder.indexOf(p.id) < 0; });
    if (unseated.length) out.push({ level: 'warning', text: '不在座次：' + unseated.map(function (p) { return p.name; }).join('、'), tab: 'flow' });
    var deadSeated = s.seatOrder.filter(function (id) { return aliveIds.indexOf(id) < 0; });
    if (deadSeated.length) out.push({ level: 'info', text: '已死亡仍在座次：' + deadSeated.map(nameOf).join('、') + '（是否移出由主持人决定）', tab: 'flow' });

    var night = s.pendingNightResult;
    if (s.started && night && night.publishedDay == null && s.day > night.day) {
      out.push({ level: 'warning', text: s.phase === 'night' ? '有一条昨夜结果待公布' : '昨夜结果还没有公布', tab: 'flow' });
    }

    s.batches.forEach(function (b) {
      if (b.status !== 'open') return;
      var left = b.pickOrder.filter(function (id) { return !b.picks.some(function (p) { return p.playerId === id; }); });
      out.push(left.length
        ? { level: 'warning', text: '「' + b.label + '」还有 ' + left.length + ' 人未领取', tab: 'supply' }
        : { level: 'info', text: '「' + b.label + '」已全部领取，可以结束批次', tab: 'supply' });
    });

    if (s.started) {
      if (s.phase === 'supply' && !t.batchIds.length) out.push({ level: 'info', text: '今天还没有发放批次', tab: 'supply' });
      if (s.phase === 'rotation' && !t.rotationDone) out.push({ level: 'warning', text: '今日尚未轮换', tab: 'flow' });
      if (s.phase === 'actions') {
        if (!t.actionOrder) {
          out.push({ level: 'warning', text: '尚未生成本轮行动顺序', tab: 'flow' });
        } else {
          var left = t.actionOrder.filter(function (id) { return t.actedIds.indexOf(id) < 0 && aliveIds.indexOf(id) >= 0; });
          if (left.length) out.push({ level: 'info', text: '轮到 ' + nameOf(left[0]) + ' 行动（还剩 ' + left.length + ' 人）', tab: 'flow' });
        }
      }
      if (s.phase === 'watch' || (t.finalWatch && s.phase === 'event')) {
        if (!t.finalWatch) {
          out.push({ level: 'warning', text: '守夜名单未确认（已收到 ' + submittedCandidates(t).length + ' 份提交）', tab: 'watch' });
        } else {
          if (!t.finalWatch.published) out.push({ level: 'info', text: '守夜名单已确认，尚未公开', tab: 'watch' });
          if (!(night && night.day === s.day)) out.push({ level: 'info', text: '今晚的守夜结果还没有保存为草稿', tab: 'watch' });
        }
      }
      var eventDue = s.phase === 'event' || (r.eventPosition == null && (t.eventCheck || t.eventFlow));
      if (eventDue) {
        var flow = t.eventFlow;
        var res = flow && flow.resolutionId ? s.resolutions.filter(function (x) { return x.id === flow.resolutionId; })[0] : null;
        if (!t.eventCheck && !flow) out.push({ level: 'warning', text: '今日事件尚未判定', tab: 'events' });
        else if (t.eventCheck && t.eventCheck.triggered && !flow) out.push({ level: 'warning', text: '今日触发了公共事件，尚未选择事件', tab: 'events' });
        else if (flow && !flow.published && !res) out.push({ level: 'warning', text: '事件已选定，尚未公布到公开页', tab: 'events' });
        else if (flow && !res) out.push({ level: 'warning', text: '事件已公布，等待录入投票并结算', tab: 'events' });
        else if (res && !res.public) out.push({ level: 'info', text: '事件已结算，结果尚未公开', tab: 'events' });
      }
    }

    if (isInt(r.rescueTarget) && s.rescueProgress >= r.rescueTarget && !s.settlement) {
      out.push({ level: 'warning', text: '营救进度已达阈值 ' + r.rescueTarget + '：何时结算由主持人决定', tab: 'records' });
    }
    var pending = pendingConfigItems(r).length;
    if (pending) out.push({ level: 'info', text: '规则配置未完成 ' + pending + ' 项', tab: 'settings' });
    return out.sort(function (a, b) { return ALERT_ORDER[a.level] - ALERT_ORDER[b.level]; });
  }

  /** 按分类汇总库存占位（总览的「占位构成」）。只返回有物品的分类，保持分类表顺序。 */
  function capacityByCategory(list, customItems, rules) {
    return CATEGORIES.map(function (cat) {
      var entries = list.filter(function (e) { return getDef(e.defId, customItems).category === cat.id; });
      return {
        id: cat.id,
        name: cat.name,
        ticks: entries.reduce(function (sum, e) { return sum + entryTicks(e, customItems, rules); }, 0),
        pieces: countPieces(entries)
      };
    }).filter(function (c) { return c.pieces > 0; });
  }

  // ---------------------------------------------------------------- 搜刮

  /*
   * 示例模板的权重：普通水、面包最常见；能量棒、奶油汤、装备（尤其步枪、消防斧、背心）明显更少。
   * 主持人与玩家都可以在模板里改。
   */
  var SCAVENGE_WEIGHTS = {
    water: 3, bread: 3, energy_drink: 2, cream_soup: 1, energy_bar: 1,
    bandage: 2, medkit: 0.8,
    cash: 2, jewel: 1, painting: 0.4,
    knife: 0.8, axe: 0.4, rifle: 0.25, ammo: 0.5, vest: 0.4,
    checkers: 1.5, map: 0.8, canteen: 0.8, liquor: 1.2, flare: 0.4
  };
  /* 同一组里已经有同类（补给除外）时，再抽到这一类的权重乘以这个系数：避免「武器＋武器」这类组合。 */
  var SAME_CATEGORY_FACTOR = 0.2;

  function defaultScavengeTemplate() {
    return {
      id: 'st_example',
      name: '示例搜刮模板',
      isExample: true,
      rev: 2,
      note: '实现假设：候选只从本模板生成，不扣公共池。补给之外的物品每组最多一件，同类物品不容易同时出现。物品与权重都可编辑，也可导入主持人给的模板。',
      items: ITEMS.map(function (d) { return { defId: d.id, weight: SCAVENGE_WEIGHTS[d.id] != null ? SCAVENGE_WEIGHTS[d.id] : 1 }; })
    };
  }

  /**
   * 生成一组物资：总占位在 [comboTicks − 1 tick, comboTicks] 之间（默认 1.5～2 单位），不会超出上限。
   * 补给可以重复；其他物品每组最多一件；同一组里已有同类（补给除外）时，同类物品的权重大幅降低。
   */
  function generateCombo(template, customItems, comboTicks, rng) {
    var hi = isInt(comboTicks) && comboTicks > 0 ? comboTicks : 4;
    var lo = Math.max(1, hi - 1);
    var cands = (template.items || []).filter(function (it) {
      var def = getDef(it.defId, customItems);
      return isNum(it.weight) && it.weight > 0 && !def.unknown && def.capacityTicks > 0 && def.capacityTicks <= hi;
    });
    var picked = {};
    var cats = {};
    var order = [];
    var total = 0;
    var guard = 0;
    while (total < lo && guard++ < 40) {
      var fit = cands.filter(function (it) {
        var def = getDef(it.defId, customItems);
        if (total + def.capacityTicks > hi) return false;
        return def.category === 'supply' || !picked[def.id];
      });
      if (!fit.length) break;
      var idx = weightedIndex(fit, function (it) {
        var cat = getDef(it.defId, customItems).category;
        return it.weight * (cat !== 'supply' && cats[cat] ? SAME_CATEGORY_FACTOR : 1);
      }, rng);
      if (idx < 0) break;
      var def = getDef(fit[idx].defId, customItems);
      if (!picked[def.id]) order.push(def.id);
      picked[def.id] = (picked[def.id] || 0) + 1;
      cats[def.category] = true;
      total += def.capacityTicks;
    }
    return order.map(function (id) { return { defId: id, qty: picked[id] }; });
  }

  function comboTicks(combo, customItems) {
    return combo.reduce(function (sum, it) { return sum + it.qty * getDef(it.defId, customItems).capacityTicks; }, 0);
  }

  function openScavengeRound(session, at, customItems, rng) {
    var options = [];
    for (var i = 0; i < session.cfg.options; i++) options.push(generateCombo(session.template, customItems, session.cfg.comboTicks, rng));
    session.rounds.push({ index: session.rounds.length, startedAt: at, deadline: at + session.cfg.seconds * 1000, options: options, choice: null, chosenAt: null, auto: false });
  }

  /** 开始搜刮：每一轮的候选与截止时间在开轮时即存档。 */
  function startScavenge(template, rules, customItems, now, rng) {
    var session = {
      id: uid('sc'),
      startedAt: now,
      status: 'running',
      cfg: {
        rounds: rules.scavengeRounds || 3,
        options: rules.scavengeOptions || 3,
        seconds: rules.scavengeSeconds || 7,
        comboTicks: rules.scavengeComboTicks || 4
      },
      template: clone(template),
      rounds: [],
      submitted: null
    };
    openScavengeRound(session, now, customItems, rng);
    return session;
  }

  function currentScavengeRound(session) {
    if (!session || session.status !== 'running') return null;
    var r = session.rounds[session.rounds.length - 1];
    return r && r.choice == null ? r : null;
  }

  function afterScavengeChoice(session, at, customItems, rng) {
    if (session.rounds.length >= session.cfg.rounds) session.status = 'organize';
    else openScavengeRound(session, at, customItems, rng);
  }

  /**
   * 按截止时间结算超时回合：超时自动选默认项（第一项），下一轮从截止时刻起算。
   * 刷新或后台切回只会补结算，不会多出一轮，也不会重置倒计时。
   */
  function settleScavenge(session, now, customItems, rng) {
    var changed = false;
    var guard = 0;
    while (session && session.status === 'running' && guard++ < 100) {
      var r = currentScavengeRound(session);
      if (!r || now < r.deadline) break;
      r.choice = 0;
      r.auto = true;
      r.chosenAt = r.deadline;
      changed = true;
      afterScavengeChoice(session, r.deadline, customItems, rng);
    }
    return changed;
  }

  /** 玩家在截止前选择。点的若是已超时的回合，会被拒绝（已按默认项记录）。 */
  function chooseScavenge(session, roundIndex, optionIndex, now, customItems, rng) {
    settleScavenge(session, now, customItems, rng);
    var r = currentScavengeRound(session);
    if (!r || r.index !== roundIndex) return { ok: false, reason: '该轮已超时，已按默认项记录' };
    if (!isInt(optionIndex) || optionIndex < 0 || optionIndex >= r.options.length) return { ok: false, reason: '选项不存在' };
    r.choice = optionIndex;
    r.chosenAt = now;
    r.auto = false;
    afterScavengeChoice(session, now, customItems, rng);
    return { ok: true };
  }

  /** 本次搜刮的全部新所得（只算本次选择，不含旧库存）。 */
  function scavengeGains(session) {
    var gains = {};
    var order = [];
    (session.rounds || []).forEach(function (r) {
      if (r.choice == null) return;
      (r.options[r.choice] || []).forEach(function (it) {
        if (!gains[it.defId]) order.push(it.defId);
        gains[it.defId] = (gains[it.defId] || 0) + it.qty;
      });
    });
    return order.map(function (id) { return { defId: id, qty: gains[id] }; });
  }

  /**
   * 整理检查：自留不超过搜刮保留额度，同时检查总库存；两者分开计算。
   * 旧物品转出只减少总库存占用，不计入本次搜刮所得。超出只警告，由主持人裁定。
   */
  function checkScavengeKeep(keep, inventoryTicks, transferOutTicks, rules, customItems) {
    var keepTicks = keep.reduce(function (sum, it) { return sum + it.qty * getDef(it.defId, customItems).capacityTicks; }, 0);
    var after = inventoryTicks - transferOutTicks + keepTicks;
    return {
      keepTicks: keepTicks,
      keepLimit: rules.scavengeKeepTicks,
      keepOver: isInt(rules.scavengeKeepTicks) && keepTicks > rules.scavengeKeepTicks,
      inventoryAfter: after,
      inventoryLimit: rules.inventoryCapacityTicks,
      inventoryOver: isInt(rules.inventoryCapacityTicks) && after > rules.inventoryCapacityTicks
    };
  }

  // ---------------------------------------------------------------- 存档

  function newHostState() {
    var now = Date.now();
    return {
      kind: 'shelter-host',
      schemaVersion: SCHEMA_VERSION,
      createdAt: now,
      updatedAt: now,
      isDemo: false,
      rules: defaultRules(),
      customItems: [],
      players: [],
      started: false,
      day: 0,
      phase: 'setup',
      seatOrder: [],
      today: newToday(),
      history: [],
      pool: [],
      poolTemplates: [],
      drawWeights: {},
      opening: { items: [], note: '', done: [false, false] },
      batches: [],
      watchTemplates: defaultWatchTemplates(),
      nightLibrary: [],
      pendingNightResult: null,
      events: [],
      resolutions: [],
      rescueProgress: 0,
      publicFeed: [],
      stage: { event: null, showPoolCount: false },
      timer: { durationMs: 180000, remainingMs: 180000, endsAt: null, running: false },
      scores: {},
      dmNotes: {},
      settlement: null,
      log: []
    };
  }

  function newPlayerState() {
    var now = Date.now();
    var rules = defaultRules();
    return {
      kind: 'shelter-player',
      schemaVersion: SCHEMA_VERSION,
      createdAt: now,
      updatedAt: now,
      isDemo: false,
      rules: rules,
      customItems: [],
      playerId: uid('pl'),
      name: '',
      alive: true,
      loveName: '',
      hateName: '',
      professionId: null,
      taskId: null,
      taskProgress: { count: 0, events: [], done: false, note: '' },
      hp: rules.hpInitial,
      hunger: rules.hungerInitial,
      hungerManual: '普通',
      thirst: '不渴',
      consciousness: '清醒',
      statuses: [],
      inventory: [],
      loadout: null,
      temporaryEffects: [],
      crafting: [],
      skillLog: [],
      action: { day: null, used: false, note: '' },
      publicInfo: { day: 1, seat: '', notes: '' },
      scavengeTemplate: defaultScavengeTemplate(),
      scavenge: null,
      scavengeHistory: [],
      manualScores: { loveHate: null, survival: null, task: null, adjust: null, note: '' },
      handoffs: [],
      log: []
    };
  }

  function validEntry(e) {
    return !!e && typeof e === 'object' && typeof e.id === 'string' && typeof e.defId === 'string' && isInt(e.qty) && e.qty > 0;
  }

  /**
   * 导入前校验结构。失败时调用方不得覆盖旧存档。
   * kind: 'shelter-host' | 'shelter-player'
   */
  function validateSave(obj, kind) {
    var errors = [];
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return { ok: false, errors: ['不是有效的存档对象'] };
    if (obj.kind !== kind) {
      var names = { 'shelter-host': '主持人存档', 'shelter-player': '玩家存档', 'shelter-rules': '规则包' };
      errors.push('存档类型不符：这里需要' + (names[kind] || kind) + '，文件是' + (names[obj.kind] || '未知类型'));
      return { ok: false, errors: errors };
    }
    if (!isInt(obj.schemaVersion) || obj.schemaVersion < 1) errors.push('缺少有效的 schemaVersion');
    else if (obj.schemaVersion > SCHEMA_VERSION) errors.push('存档版本 ' + obj.schemaVersion + ' 比本页面（' + SCHEMA_VERSION + '）新，无法导入');
    if (!obj.rules || typeof obj.rules !== 'object') errors.push('缺少 rules');
    if (!Array.isArray(obj.log)) errors.push('缺少 log');
    if (obj.customItems != null && !Array.isArray(obj.customItems)) errors.push('customItems 必须是数组');
    if (kind === 'shelter-host') {
      ['players', 'seatOrder', 'pool', 'history', 'events', 'batches', 'publicFeed'].forEach(function (k) {
        if (!Array.isArray(obj[k])) errors.push('缺少数组字段 ' + k);
      });
      if (!obj.today || typeof obj.today !== 'object') errors.push('缺少 today');
      if (!isInt(obj.day)) errors.push('day 必须是整数');
      if (Array.isArray(obj.players)) {
        var ids = {};
        obj.players.forEach(function (p, i) {
          if (!p || typeof p.id !== 'string' || typeof p.name !== 'string') errors.push('玩家' + (i + 1) + '缺少 id 或姓名');
          else if (ids[p.id]) errors.push('玩家 id 重复：' + p.id);
          else ids[p.id] = true;
        });
        if (Array.isArray(obj.seatOrder)) {
          obj.seatOrder.forEach(function (id) { if (!ids[id]) errors.push('座次中有不存在的玩家：' + id); });
        }
      }
      if (Array.isArray(obj.pool) && !obj.pool.every(validEntry)) errors.push('公共池里有无效物品（数量须为正整数）');
    }
    if (kind === 'shelter-player') {
      if (!Array.isArray(obj.inventory)) errors.push('缺少 inventory');
      else if (!obj.inventory.every(validEntry)) errors.push('库存里有无效物品（数量须为正整数）');
      if (!isNum(obj.hp)) errors.push('hp 必须是数字');
      if (!Array.isArray(obj.statuses)) errors.push('缺少 statuses');
      if (typeof obj.playerId !== 'string') errors.push('缺少 playerId');
    }
    return { ok: errors.length === 0, errors: errors };
  }

  /** 补齐旧存档缺失的可选字段（不覆盖已有值）。 */
  function normalizeSave(obj, kind) {
    var base = kind === 'shelter-host' ? newHostState() : newPlayerState();
    var out = Object.assign(base, obj);
    out.rules = normalizeRules(obj.rules);
    if (kind === 'shelter-host') {
      out.today = Object.assign(newToday(), obj.today || {});
      out.stage = Object.assign({ event: null, showPoolCount: false }, obj.stage || {});
      out.timer = Object.assign({ durationMs: 180000, remainingMs: 180000, endsAt: null, running: false }, obj.timer || {});
      out.opening = Object.assign({ items: [], note: '', done: [false, false] }, obj.opening || {});
    } else {
      out.publicInfo = Object.assign({ day: 1, seat: '', notes: '' }, obj.publicInfo || {});
      out.manualScores = Object.assign({ loveHate: null, survival: null, task: null, adjust: null, note: '' }, obj.manualScores || {});
      out.taskProgress = Object.assign({ count: 0, events: [], done: false, note: '' }, obj.taskProgress || {});
      out.action = Object.assign({ day: null, used: false, note: '' }, obj.action || {});
      // 没改过的示例搜刮模板换成新版权重；自定义模板原样保留
      if (out.scavengeTemplate && out.scavengeTemplate.isExample && out.scavengeTemplate.rev !== 2) out.scavengeTemplate = defaultScavengeTemplate();
    }
    return out;
  }

  /** 主持人发给玩家的「规则包」：只含规则、自定义物品与搜刮模板。 */
  function makeRulesPack(state, scavengeTemplate) {
    return {
      kind: 'shelter-rules',
      schemaVersion: SCHEMA_VERSION,
      exportedAt: Date.now(),
      rules: clone(state.rules),
      customItems: clone(state.customItems || []),
      scavengeTemplate: scavengeTemplate ? clone(scavengeTemplate) : null
    };
  }

  function validateRulesPack(obj) {
    if (!obj || typeof obj !== 'object' || obj.kind !== 'shelter-rules') return { ok: false, errors: ['不是规则包（kind 应为 shelter-rules）'] };
    if (!obj.rules || typeof obj.rules !== 'object') return { ok: false, errors: ['规则包缺少 rules'] };
    if (obj.customItems != null && !Array.isArray(obj.customItems)) return { ok: false, errors: ['customItems 必须是数组'] };
    return { ok: true, errors: [] };
  }

  return {
    SCHEMA_VERSION: SCHEMA_VERSION,
    PENDING_TEXT: PENDING_TEXT,
    RULE_STATUS: RULE_STATUS,
    CATEGORIES: CATEGORIES,
    ITEMS: ITEMS,
    STATUSES: STATUSES,
    PROFESSIONS: PROFESSIONS,
    TASKS: TASKS,
    RETIRED_DRAFTS: RETIRED_DRAFTS,
    RULE_FIELDS: RULE_FIELDS,
    ITEM_USE_FIELDS: ITEM_USE_FIELDS,
    PHASES: PHASES,
    WATCH_KINDS: WATCH_KINDS,
    WATCH_COMBINE: WATCH_COMBINE,
    TENDENCY_NAMES: TENDENCY_NAMES,
    JEWEL_TABLE: JEWEL_TABLE,
    SCORE_PARTS: SCORE_PARTS,
    uid: uid,
    clone: clone,
    isInt: isInt,
    isNum: isNum,
    seededRng: seededRng,
    fmtUnits: fmtUnits,
    weightedIndex: weightedIndex,
    sample: sample,
    getDef: getDef,
    allDefs: allDefs,
    findDefByName: findDefByName,
    newCustomItem: newCustomItem,
    getStatusDef: getStatusDef,
    getProfession: getProfession,
    getTask: getTask,
    defaultRules: defaultRules,
    normalizeRules: normalizeRules,
    pendingConfigItems: pendingConfigItems,
    hungerZone: hungerZone,
    isStackable: isStackable,
    instanceDefaults: instanceDefaults,
    addItem: addItem,
    removeQty: removeQty,
    findEntry: findEntry,
    countPieces: countPieces,
    countDef: countDef,
    entryTicks: entryTicks,
    listTicks: listTicks,
    canteenCapacityPending: canteenCapacityPending,
    takeOnePiece: takeOnePiece,
    putPiece: putPiece,
    takeDef: takeDef,
    describeEntry: describeEntry,
    parseItemList: parseItemList,
    formatItemList: formatItemList,
    drawPieces: drawPieces,
    createBatch: createBatch,
    pickFromBatch: pickFromBatch,
    unpickFromBatch: unpickFromBatch,
    closeBatch: closeBatch,
    undoBatch: undoBatch,
    phaseSequence: phaseSequence,
    phaseLabel: phaseLabel,
    rotateSeats: rotateSeats,
    swapSeats: swapSeats,
    lastSeat: lastSeat,
    nextActor: nextActor,
    newToday: newToday,
    todayHasData: todayHasData,
    applyRotation: applyRotation,
    beginActions: beginActions,
    recordAction: recordAction,
    undoAction: undoAction,
    requestSwap: requestSwap,
    advanceDay: advanceDay,
    retreatDay: retreatDay,
    watchKindName: watchKindName,
    defaultWatchTemplates: defaultWatchTemplates,
    newWatchTemplate: newWatchTemplate,
    makeWatchOption: makeWatchOption,
    drawWatchOptions: drawWatchOptions,
    resolveWatchOption: resolveWatchOption,
    watchMode: watchMode,
    submittedCandidates: submittedCandidates,
    describeWatchOption: describeWatchOption,
    nightDrawable: nightDrawable,
    newNightResult: newNightResult,
    emptyEffects: emptyEffects,
    newOutcome: newOutcome,
    newOption: newOption,
    newEvent: newEvent,
    probabilityStatus: probabilityStatus,
    drawOutcome: drawOutcome,
    rollEventTrigger: rollEventTrigger,
    poolShortages: poolShortages,
    applyPoolDelta: applyPoolDelta,
    revertPoolChanges: revertPoolChanges,
    describePersonalEffects: describePersonalEffects,
    validateEvent: validateEvent,
    normalizeEvent: normalizeEvent,
    jewelScore: jewelScore,
    wealthCounts: wealthCounts,
    wealthScore: wealthScore,
    mapNotesTotal: mapNotesTotal,
    settlementTotal: settlementTotal,
    combatSummary: combatSummary,
    loadoutTicks: loadoutTicks,
    playerAlerts: playerAlerts,
    hostAlerts: hostAlerts,
    capacityByCategory: capacityByCategory,
    defaultScavengeTemplate: defaultScavengeTemplate,
    generateCombo: generateCombo,
    comboTicks: comboTicks,
    startScavenge: startScavenge,
    currentScavengeRound: currentScavengeRound,
    settleScavenge: settleScavenge,
    chooseScavenge: chooseScavenge,
    scavengeGains: scavengeGains,
    checkScavengeKeep: checkScavengeKeep,
    newHostState: newHostState,
    newPlayerState: newPlayerState,
    validateSave: validateSave,
    normalizeSave: normalizeSave,
    makeRulesPack: makeRulesPack,
    validateRulesPack: validateRulesPack
  };
});
