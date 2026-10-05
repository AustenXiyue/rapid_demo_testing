/*
 * 避难所 Playtest · 玩家端
 *
 * 个人记录的主要来源：物品（含实例状态）、生命与状态、携带装备、搜刮、身份与分数。
 * 与主持人端互不同步：主持人发物资后玩家手动添加；交公、赠予、治疗他人都生成交接文本。
 * 玩家可以编辑自己的全部数据；超容量只警告，不阻断主持人裁定。
 */
(function () {
  'use strict';

  var C = window.ShelterCore;
  var U = window.ShelterUI;
  var h = U.h;

  var KEY_MAIN = 'shelter-playtest:player:v1';
  var KEY_DEMO = 'shelter-playtest:player-demo:v1';
  var KEY_SLOT = 'shelter-playtest:player:slot';
  var KEY_TAB = 'shelter-playtest:player:tab';

  var TABS = [
    { id: 'status', name: '状态' },
    { id: 'inventory', name: '库存' },
    { id: 'loadout', name: '携带' },
    { id: 'scavenge', name: '搜刮' },
    { id: 'action', name: '行动' },
    { id: 'identity', name: '身份' },
    { id: 'score', name: '分数' },
    { id: 'save', name: '存档' }
  ];

  var THIRST = ['不渴', '口渴', '脱水'];
  var HUNGER_ZONES = ['充盈', '普通', '饥饿'];

  var slot = U.readKey(KEY_SLOT) === 'demo' ? 'demo' : 'main';
  var store = null;
  var state = null;
  var notices = [];
  var undo = new U.UndoStack(40);
  var ui = { tab: 'status', filter: 'all', drafts: {}, keep: {}, transfer: {} };

  // ================================================================ 演示

  function buildDemoState() {
    var s = C.newPlayerState();
    s.isDemo = true;
    s.name = '演示·小周';
    s.loveName = 'A·老陈';
    s.hateName = 'E·二狗';
    s.publicInfo = { day: 2, seat: '3', notes: '【演示】公共池还剩不少面包；D 想用子弹换水。' };
    var opts = { rules: s.rules };
    C.addItem(s.inventory, 'bread', 1, opts);
    C.addItem(s.inventory, 'water', 1, opts);
    var bars = C.addItem(s.inventory, 'energy_bar', 2, opts);
    bars[0].uses = 1;
    var map = C.addItem(s.inventory, 'map', 1, opts)[0];
    map.notes = [{ text: '北门外有辆翻倒的补给车', day: 1 }, { text: '地铁站B口积水，别走', day: 2 }];
    C.addItem(s.inventory, 'canteen', 1, opts)[0].water = 1;
    C.addItem(s.inventory, 'vest', 1, opts)[0].condition = 'damaged';
    C.addItem(s.inventory, 'rifle', 1, opts);
    C.addItem(s.inventory, 'ammo', 1, opts);
    C.addItem(s.inventory, 'cash', 3, opts);
    C.addItem(s.inventory, 'jewel', 2, opts);
    s.statuses = [{ id: C.uid('st'), statusId: 'bleeding', name: '流血伤口', startDay: 1, nextDay: 3, note: '【演示】第1天在超市割伤' }];
    s.temporaryEffects = [{ id: C.uid('fx'), text: '下一次行动判定视为充盈（功能饮料）', day: 2, attack: null }];
    log(s, '载入演示存档（与正式存档完全分开）');
    return s;
  }

  // ================================================================ 存档与提交

  function loadState() {
    store = new U.Store(slot === 'demo' ? KEY_DEMO : KEY_MAIN);
    notices = [];
    var r = store.read();
    if (r.status === 'ok') {
      var v = C.validateSave(r.data, 'shelter-player');
      if (v.ok) return C.normalizeSave(r.data, 'shelter-player');
      store.backup(r.raw, '读取时校验失败：' + v.errors[0]);
      notices.push({ kind: 'danger', text: '本地存档无法读取（' + v.errors[0] + '）。原数据已另存为备份，当前是空白存档，可在「存档」页查看备份。' });
    } else if (r.status === 'corrupt') {
      store.backup(r.raw, '存档损坏');
      notices.push({ kind: 'danger', text: '本地存档已损坏。原数据已另存为备份，当前是空白存档。' });
    } else if (r.status === 'unavailable' || r.status === 'error') {
      notices.push({ kind: 'danger', text: '浏览器本地保存不可用（可能是隐私模式或存储被禁用）：页面仍在内存中运行，刷新即丢失——请随时在「存档」页导出 JSON。' });
    }
    return slot === 'demo' ? buildDemoState() : C.newPlayerState();
  }

  function save() {
    state.updatedAt = Date.now();
    if (!store.available) return;
    if (!store.write(state)) {
      var msg = '自动保存失败（' + ((store.lastError && store.lastError.name) || '未知错误') + '），可能是存储空间已满：请立即导出 JSON。';
      if (!notices.some(function (n) { return n.text === msg; })) notices.push({ kind: 'danger', text: msg });
    }
  }

  function commit(label, fn, opts) {
    opts = opts || {};
    var before = C.clone(state);
    try {
      if (fn(state) === false) {
        state = before;
        return false;
      }
    } catch (e) {
      state = before;
      U.toast(e && e.message ? e.message : String(e), 'warn');
      render();
      return false;
    }
    if (opts.undo !== false) undo.push(label, before);
    save();
    render();
    return true;
  }

  function undoLast() {
    var item = undo.pop();
    if (!item) return;
    state = item.snapshot;
    log(state, '撤销：' + item.label);
    save();
    render();
    U.toast('已撤销：' + item.label, 'ok');
  }

  function log(s, text) {
    s.log.unshift({ id: C.uid('log'), at: Date.now(), day: s.publicInfo ? s.publicInfo.day : null, text: text });
    if (s.log.length > 1500) s.log.length = 1500;
  }

  /** 交接文本：都写明「需要对方手动修改」，并存入交接记录。 */
  function handoff(s, kind, text) {
    s.handoffs.unshift({ id: C.uid('ho'), at: Date.now(), day: s.publicInfo.day, kind: kind, text: text });
    if (s.handoffs.length > 200) s.handoffs.length = 200;
    return text;
  }

  function showHandoff(text, title) {
    U.modal({ title: title || '交接文本（需要对方手动修改）', body: h('div', { class: 'stack' }, U.copyBlock(text, { note: '复制后发到 Discord' }), h('p', { class: 'muted small' }, '玩家端不会自动同步到任何人的页面。')) });
  }

  // ================================================================ 查询

  function defOf(entry) {
    return C.getDef(entry.defId, state.customItems);
  }

  function describe(entry) {
    return C.describeEntry(entry, state.customItems);
  }

  function myName() {
    return state.name || '我';
  }

  function today() {
    return state.publicInfo.day;
  }

  function invTicks() {
    return C.listTicks(state.inventory, state.customItems, state.rules);
  }

  function carriedQty(entryId) {
    if (!state.loadout) return 0;
    var row = state.loadout.items.find(function (r) { return r.entryId === entryId; });
    return row ? row.qty : 0;
  }

  /** 库存变化后，把携带数量收缩到库存实际数量以内（携带只引用库存，不复制物品）。 */
  function syncLoadout(s) {
    if (!s.loadout) return;
    s.loadout.items = s.loadout.items.map(function (r) {
      var e = C.findEntry(s.inventory, r.entryId);
      return e ? { entryId: r.entryId, qty: Math.min(r.qty, e.qty) } : null;
    }).filter(function (r) { return r && r.qty > 0; });
  }

  function tempAttack() {
    return state.temporaryEffects.reduce(function (sum, fx) { return sum + (C.isNum(fx.attack) ? fx.attack : 0); }, 0);
  }

  function setTab(id) {
    ui.tab = id;
    U.writeKey(KEY_TAB, id);
    render();
    window.scrollTo(0, 0);
  }

  function chip(text, cls) {
    return h('span', { class: 'chip ' + (cls || '') }, text);
  }

  // ================================================================ 渲染骨架

  function render() {
    renderBanner();
    renderTop();
    renderTabs();
    renderMain();
  }

  function renderBanner() {
    var el = U.clear(document.getElementById('banner'));
    if (slot === 'demo') {
      el.appendChild(h('div', { class: 'banner demo' }, h('b', null, '演示存档'), h('span', null, '仅供试用，与正式存档完全分开。'),
        h('button', { type: 'button', class: 'btn small', onclick: exitDemo }, '返回正式存档'),
        h('button', { type: 'button', class: 'btn small danger', onclick: clearDemo }, '清空演示')));
    }
    notices.forEach(function (n, i) {
      el.appendChild(h('div', { class: 'banner ' + n.kind }, U.icon('warn'), h('span', { class: 'grow' }, n.text),
        h('button', { type: 'button', class: 'btn small ghost', onclick: function () { notices.splice(i, 1); render(); } }, '关闭')));
    });
    if (/\.vercel\.app$/.test(location.hostname)) {
      el.appendChild(h('div', { class: 'banner info' }, '你正在通过上游部署地址访问。正式入口是 www.xxxmnalx.com/game/shelter ——两个地址的存档互不相通。'));
    }
  }

  function hungerText() {
    var zone = C.hungerZone(state.hunger, state.rules);
    if (zone) return zone + ' ' + state.hunger;
    var manual = state.hungerManual || '未记录';
    return manual + (C.isNum(state.hunger) ? ' ' + state.hunger : '');
  }

  function renderTop() {
    var top = U.clear(document.getElementById('topbar'));
    var used = invTicks();
    var cap = state.rules.inventoryCapacityTicks;
    var over = C.isInt(cap) && used > cap;
    top.appendChild(h('div', { class: 'p-top' },
      h('div', { class: 'p-top-row' },
        h('div', { class: 'p-name' }, h('b', null, state.name || '未命名玩家'), state.alive ? null : chip('已死亡', 'danger')),
        h('div', { class: 'p-day' },
          h('button', { type: 'button', class: 'btn small icon-btn', 'aria-label': '前一天', onclick: function () { setDay(today() - 1); } }, '‹'),
          h('span', null, '第 ', h('b', null, String(today())), ' 天'),
          h('button', { type: 'button', class: 'btn small icon-btn', 'aria-label': '后一天', onclick: function () { setDay(today() + 1); } }, '›')),
        h('button', { type: 'button', class: 'btn small', onclick: undoLast, disabled: !undo.peek(), title: undo.peek() ? '撤销：' + undo.peek().label : '' }, U.icon('undo'), '撤销')),
      h('div', { class: 'p-chips' },
        h('span', { class: 'pchip ' + (state.hp <= 0 ? 'danger' : state.hp <= 2 ? 'risk' : 'ok') }, '生命 ', h('b', null, String(state.hp))),
        h('span', { class: 'pchip ' + (hungerRisk() ? 'risk' : '') }, '饥饿 ', h('b', null, hungerText())),
        h('span', { class: 'pchip ' + (state.thirst === '脱水' ? 'danger' : state.thirst === '口渴' ? 'risk' : '') }, '口渴 ', h('b', null, state.thirst)),
        h('span', { class: 'pchip ' + (state.consciousness === '昏迷' ? 'danger' : '') }, h('b', null, state.consciousness)),
        h('span', { class: 'pchip ' + (over ? 'risk' : '') }, '库存 ', h('b', null, C.fmtUnits(used) + '/' + C.fmtUnits(cap))),
        state.statuses.length ? h('span', { class: 'pchip risk' }, '状态 ', h('b', null, String(state.statuses.length))) : null)));
    // 标签栏吸附在状态栏下方：按状态栏实际高度定位（芯片换行时高度会变）
    document.documentElement.style.setProperty('--top-h', top.offsetHeight + 'px');
  }

  function hungerRisk() {
    var zone = C.hungerZone(state.hunger, state.rules) || state.hungerManual;
    return zone === '饥饿';
  }

  function setDay(d) {
    if (!C.isInt(d) || d < 0) return;
    commit('修改天数', function (s) {
      s.publicInfo.day = d;
      log(s, '记录当前天数：第' + d + '天');
    });
  }

  function renderTabs() {
    var nav = U.clear(document.getElementById('tabs'));
    TABS.forEach(function (t) {
      nav.appendChild(h('button', { type: 'button', class: 'tab ' + (ui.tab === t.id ? 'on' : ''), 'data-tab': t.id, 'aria-current': ui.tab === t.id ? 'page' : null, onclick: function () { setTab(t.id); } }, t.name));
    });
  }

  function renderMain() {
    var main = U.clear(document.getElementById('main'));
    var views = { status: renderStatus, inventory: renderInventory, loadout: renderLoadout, scavenge: renderScavenge, action: renderAction, identity: renderIdentity, score: renderScore, save: renderSave };
    main.className = 'main p-main tab-' + ui.tab;
    main.appendChild((views[ui.tab] || renderStatus)());
  }

  // ================================================================ 状态

  function renderStatus() {
    return h('div', { class: 'stack' }, bleedReminders(), hpCard(), hungerCard(), thirstCard(), statusesCard(), effectsCard(), aliveCard());
  }

  function bleedReminders() {
    var due = state.statuses.filter(function (st) { return st.statusId === 'bleeding' && C.isInt(st.nextDay) && today() >= st.nextDay; });
    if (!due.length) return null;
    return h('div', { class: 'stack' }, due.map(function (st) {
      return h('div', { class: 'callout risk' },
        h('p', null, h('b', null, '流血提醒：'), '第 ' + st.nextDay + ' 天到期（获得于第 ' + st.startDay + ' 天）。每两个回合失去1生命——请先与主持人确认，避免两端重复扣血。'),
        h('div', { class: 'row' },
          h('button', {
            type: 'button', class: 'btn small risk', onclick: function () {
              commit('流血扣血', function (s) {
                var x = s.statuses.find(function (y) { return y.id === st.id; });
                s.hp -= 1;
                x.nextDay = today() + 2;
                log(s, '流血伤口：经主持人确认扣1生命 → ' + s.hp + '；下次提醒第' + x.nextDay + '天');
              });
            }
          }, '已确认，扣1生命'),
          h('button', {
            type: 'button', class: 'btn small', onclick: function () {
              commit('流血不扣', function (s) {
                var x = s.statuses.find(function (y) { return y.id === st.id; });
                x.nextDay = today() + 2;
                log(s, '流血伤口：主持人裁定本次不扣血；下次提醒第' + x.nextDay + '天');
              });
            }
          }, '主持人裁定不扣')));
    }));
  }

  function hpCard() {
    var r = state.rules;
    function set(v) {
      if (!C.isInt(v)) { U.toast('生命需为整数', 'warn'); return; }
      commit('修改生命', function (s) {
        var old = s.hp;
        if (old === v) return false;
        s.hp = v;
        log(s, '生命 ' + old + ' → ' + v);
      });
    }
    return h('section', { class: 'card' },
      h('div', { class: 'card-head' }, h('h2', null, '生命'), h('span', { class: 'muted small' }, '初始 ' + r.hpInitial + ' · 上限 ' + (r.hpMax == null ? '待配置' : r.hpMax))),
      h('div', { class: 'big-row' },
        h('button', { type: 'button', class: 'btn big', onclick: function () { set(state.hp - 1); }, 'aria-label': '生命减一' }, '−1'),
        h('div', { class: 'big-num ' + (state.hp <= 0 ? 'danger-text' : '') }, String(state.hp)),
        h('button', { type: 'button', class: 'btn big', onclick: function () { set(state.hp + 1); }, 'aria-label': '生命加一' }, '+1')),
      h('p', null, '基础战斗力＝当前生命：', h('b', null, String(Math.max(0, state.hp)))),
      state.hp <= 0 ? h('div', { class: 'callout danger' }, '生命为 0：0 生命的处理与死亡时点尚未确定（' + (r.hpZeroRule || C.PENDING_TEXT) + '）。页面不会自动判定死亡。') : null,
      C.isInt(r.hpMax) && state.hp > r.hpMax ? h('div', { class: 'callout risk' }, '超过生命上限 ' + r.hpMax + '：请确认是否录入有误。') : null);
  }

  function hungerCard() {
    var r = state.rules;
    var zone = C.hungerZone(state.hunger, r);
    var auto = C.isNum(r.hungerFullAt) && C.isNum(r.hungerHungryAt);
    function setValue(v) {
      commit('修改饥饿值', function (s) {
        var old = s.hunger;
        if (old === v) return false;
        s.hunger = v;
        log(s, '饥饿值 ' + (old == null ? '未记录' : old) + ' → ' + (v == null ? '未记录' : v));
      });
    }
    var input = h('input', { type: 'number', class: 'num', value: state.hunger == null ? '' : state.hunger, placeholder: '未记录', 'aria-label': '饥饿值' });
    input.addEventListener('change', function () {
      var n = U.parseNumber(input.value, true);
      if (Number.isNaN(n)) { U.toast('请输入数字或留空', 'warn'); input.value = state.hunger == null ? '' : state.hunger; return; }
      setValue(n);
    });
    return h('section', { class: 'card' },
      h('div', { class: 'card-head' }, h('h2', null, '饥饿'), h('span', { class: 'muted small' }, '充盈／普通／饥饿三区间')),
      h('div', { class: 'row' },
        h('button', { type: 'button', class: 'btn', onclick: function () { setValue((state.hunger || 0) - 1); } }, '−1'),
        input,
        h('button', { type: 'button', class: 'btn', onclick: function () { setValue((state.hunger || 0) + 1); } }, '+1'),
        h('span', null, '区间：', h('b', null, zone || (state.hungerManual || '未记录')), auto ? h('span', { class: 'muted small' }, '（按阈值自动判定）') : h('span', { class: 'muted small' }, '（手动）'))),
      auto ? null : h('div', { class: 'stack' },
        h('p', { class: 'small' }, U.pendingTag('阈值待配置'), ' 未填阈值时禁用自动判定，保留手动状态：'),
        U.segmented(HUNGER_ZONES.map(function (z) { return [z, z]; }).concat([['', '未记录']]), state.hungerManual || '', function (v) {
          commit('手动饥饿状态', function (s) { s.hungerManual = v || null; log(s, '饥饿状态（手动）：' + (v || '未记录')); });
        })),
      h('p', { class: 'muted small' }, '充盈改善力气和相关成功率，饥饿降低相关成功率（具体修正未定）。按行动消耗前的状态判定，再扣事件消耗；事件开启后不能靠临时进食提升本次状态（提示，不强制）。'));
  }

  function thirstCard() {
    return h('section', { class: 'card' },
      h('div', { class: 'card-head' }, h('h2', null, '口渴与意识')),
      h('div', { class: 'row' }, h('span', { class: 'field-label' }, '口渴'), U.segmented(THIRST.map(function (t) { return [t, t]; }), state.thirst, setThirst)),
      h('div', { class: 'row' }, h('span', { class: 'field-label' }, '意识'), U.segmented([['清醒', '清醒'], ['昏迷', '昏迷']], state.consciousness, function (v) {
        commit('修改意识', function (s) {
          if (s.consciousness === v) return false;
          log(s, '意识 ' + s.consciousness + ' → ' + v);
          s.consciousness = v;
        });
      })),
      h('p', { class: 'muted small' }, '脱水直接昏迷（已确认）。没有固定的每日口渴扣减，由结算结果触发；补水幅度、昏迷如何解除及能做哪些事尚未确定——请手动切换，不会自动判成死亡。'));
  }

  function setThirst(v) {
    commit('修改口渴', function (s) {
      if (s.thirst === v) return false;
      log(s, '口渴 ' + s.thirst + ' → ' + v);
      s.thirst = v;
      if (v === '脱水' && s.consciousness !== '昏迷') {
        s.consciousness = '昏迷';
        log(s, '脱水直接昏迷');
      }
    });
    if (v === '脱水') U.toast('脱水直接昏迷（已确认规则）', 'warn');
  }

  function statusesCard() {
    var options = C.STATUSES.filter(function (st) { return st.ruleStatus !== 'draft' || state.rules.draftStatusesEnabled; })
      .map(function (st) { return [st.id, st.name + (st.ruleStatus === 'draft' ? '（草案）' : '')]; }).concat([['custom', '自定义状态…']]);
    var sel = U.select(options, 'bleeding', function () {});
    return h('section', { class: 'card' },
      h('div', { class: 'card-head' }, h('h2', null, '负面状态')),
      state.statuses.length ? h('ul', { class: 'list-plain' }, state.statuses.map(function (st) {
        var def = st.statusId ? C.getStatusDef(st.statusId) : null;
        return h('li', null,
          h('div', { class: 'row between' },
            h('div', { class: 'grow' }, h('b', null, st.name), ' ', def ? U.ruleBadge(def.ruleStatus) : U.ruleBadge('custom'),
              st.statusId === 'bleeding' ? h('div', { class: 'small' }, '获得于第 ' + st.startDay + ' 天；下次提醒第 ' + (st.nextDay == null ? '?' : st.nextDay) + ' 天（主持人确认后扣血）') : null,
              def ? h('div', { class: 'muted small' }, def.effectText) : null,
              st.note ? h('div', { class: 'muted small' }, st.note) : null),
            h('div', { class: 'row tight' },
              st.statusId === 'bleeding' ? h('button', { type: 'button', class: 'btn small', onclick: function () { editBleed(st); } }, '改日期') : null,
              h('button', {
                type: 'button', class: 'btn small', onclick: function () {
                  commit('移除状态', function (s) { s.statuses = s.statuses.filter(function (x) { return x.id !== st.id; }); log(s, '移除状态：' + st.name); });
                }
              }, '移除'))));
      })) : h('p', { class: 'empty' }, '没有负面状态。'),
      h('div', { class: 'row' }, sel, h('button', { type: 'button', class: 'btn', onclick: function () { addStatus(sel.value); } }, '添加')),
      state.rules.draftStatusesEnabled ? h('p', { class: 'muted small' }, '感染、腹泻、虚弱、拉伤、眩晕：候选状态，效果未被确认。') :
        h('p', { class: 'muted small' }, '感染、腹泻、虚弱、拉伤、眩晕是草案状态，默认停用（可在「存档 → 规则」按主持人通知启用）。'));
  }

  function addStatus(statusId) {
    if (statusId === 'custom') {
      var nameI = h('input', { type: 'text', placeholder: '状态名称', autofocus: true });
      var noteI = h('input', { type: 'text', placeholder: '说明（可选）' });
      U.modal({ title: '自定义状态', body: h('div', { class: 'stack' }, U.field('名称', nameI), U.field('说明', noteI)), actions: [{ label: '取消', value: false }, { label: '添加', kind: 'primary', value: true }] })
        .then(function (ok) {
          if (!ok || !nameI.value.trim()) return;
          commit('添加状态', function (s) {
            s.statuses.push({ id: C.uid('st'), statusId: null, name: nameI.value.trim(), startDay: today(), nextDay: null, note: noteI.value });
            log(s, '添加状态：' + nameI.value.trim());
          });
        });
      return;
    }
    var def = C.getStatusDef(statusId);
    if (!def) return;
    if (statusId !== 'bleeding') {
      commit('添加状态', function (s) {
        s.statuses.push({ id: C.uid('st'), statusId: statusId, name: def.name, startDay: today(), nextDay: null, note: '' });
        log(s, '添加状态：' + def.name + '（草案，效果未确认）');
      });
      return;
    }
    var start = h('input', { type: 'number', class: 'num', value: today() });
    var next = h('input', { type: 'number', class: 'num', value: today() + 2 });
    var exists = state.statuses.some(function (st) { return st.statusId === 'bleeding'; });
    U.modal({
      title: '添加流血伤口',
      body: h('div', { class: 'stack' },
        exists ? h('div', { class: 'callout risk' }, '已经有流血伤口。重复流血是否叠加尚未确定——请先与主持人确认。') : null,
        h('div', { class: 'grid2' }, U.field('获得日期（第几天）', start), U.field('下次触发日期', next)),
        h('p', { class: 'muted small' }, '每两个回合失去1生命，直到清除。获得当天是否计入两回合待定：默认下次为获得日+2，可改。到期只提醒，扣血前与主持人确认。')),
      actions: [{ label: '取消', value: false }, { label: '添加', kind: 'primary', value: true }]
    }).then(function (ok) {
      if (!ok) return;
      var a = parseInt(start.value, 10);
      var b = parseInt(next.value, 10);
      if (!C.isInt(a) || !C.isInt(b)) { U.toast('日期需为整数', 'warn'); return; }
      commit('添加流血', function (s) {
        s.statuses.push({ id: C.uid('st'), statusId: 'bleeding', name: '流血伤口', startDay: a, nextDay: b, note: '' });
        log(s, '添加流血伤口：第' + a + '天获得，第' + b + '天提醒');
      });
    });
  }

  function editBleed(st) {
    var start = h('input', { type: 'number', class: 'num', value: st.startDay });
    var next = h('input', { type: 'number', class: 'num', value: st.nextDay == null ? '' : st.nextDay });
    U.modal({ title: '修改流血日期', body: h('div', { class: 'grid2' }, U.field('获得日期', start), U.field('下次触发日期', next)), actions: [{ label: '取消', value: false }, { label: '保存', kind: 'primary', value: true }] })
      .then(function (ok) {
        if (!ok) return;
        var a = parseInt(start.value, 10);
        var b = U.parseNumber(next.value, false);
        if (!C.isInt(a) || Number.isNaN(b)) { U.toast('日期需为整数', 'warn'); return; }
        commit('修改流血日期', function (s) {
          var x = s.statuses.find(function (y) { return y.id === st.id; });
          x.startDay = a;
          x.nextDay = b;
          log(s, '修改流血日期：第' + a + '天获得，下次第' + (b == null ? '?' : b) + '天');
        });
      });
  }

  function effectsCard() {
    var input = h('input', { type: 'text', placeholder: '例如：下一任务临时攻击+2（酒）' });
    return h('section', { class: 'card' },
      h('div', { class: 'card-head' }, h('h2', null, '临时效果')),
      state.temporaryEffects.length ? h('ul', { class: 'list-plain' }, state.temporaryEffects.map(function (fx) {
        return h('li', { class: 'row between' }, h('span', { class: 'grow' }, fx.text, h('span', { class: 'muted small' }, ' · 第' + fx.day + '天'), C.isNum(fx.attack) ? chip('攻击+' + fx.attack, 'ok') : null),
          h('button', { type: 'button', class: 'btn small', onclick: function () { commit('清除临时效果', function (s) { s.temporaryEffects = s.temporaryEffects.filter(function (x) { return x.id !== fx.id; }); log(s, '清除临时效果：' + fx.text); }); } }, '清除'));
      })) : h('p', { class: 'empty' }, '没有临时效果。'),
      h('div', { class: 'row' }, input, h('button', {
        type: 'button', class: 'btn', onclick: function () {
          var t = input.value.trim();
          if (!t) return;
          commit('添加临时效果', function (s) { s.temporaryEffects.push({ id: C.uid('fx'), text: t, day: today(), attack: null }); log(s, '添加临时效果：' + t); });
        }
      }, '添加')),
      h('p', { class: 'muted small' }, '临时效果只记录到下一次任务或行动，不自动扩展为全回合加成；用完请手动清除。'));
  }

  function aliveCard() {
    return h('section', { class: 'card' },
      h('div', { class: 'card-head' }, h('h2', null, '存活')),
      h('label', { class: 'check' }, h('input', {
        type: 'checkbox', checked: !state.alive, onchange: function (e) {
          var dead = e.target.checked;
          commit('存活状态', function (s) { s.alive = !dead; log(s, dead ? '标记为死亡（由主持人宣布）' : '恢复为存活'); });
        }
      }), '我已死亡（由主持人宣布）'),
      h('p', { class: 'muted small' }, '死亡后不保留财富分；爱恨与任务分保留，各任务是否仍可继续完成待定。'));
  }

  // ================================================================ 库存

  function renderInventory() {
    var used = invTicks();
    var cap = state.rules.inventoryCapacityTicks;
    var over = C.isInt(cap) && used > cap;
    var list = state.inventory.filter(function (e) { return ui.filter === 'all' || defOf(e).category === ui.filter; });
    return h('div', { class: 'stack' },
      h('section', { class: 'card' },
        h('div', { class: 'row between' }, h('h2', null, '库存'), h('span', { class: 'cap ' + (over ? 'risk-text' : 'ok-text') }, '总占位 ', h('b', null, C.fmtUnits(used) + ' / ' + C.fmtUnits(cap)), ' 单位')),
        h('div', { class: 'meter' + (over ? ' over' : ''), role: 'img', 'aria-label': '库存占位 ' + C.fmtUnits(used) + ' / ' + C.fmtUnits(cap) }, h('span', { style: 'width:' + Math.min(100, cap ? (used / cap) * 100 : 0) + '%' })),
        over ? h('div', { class: 'callout risk' }, '超出总库存上限 ' + C.fmtUnits(used - cap) + ' 单位：只警告，不阻断主持人裁定。') : null,
        C.canteenCapacityPending(state.inventory, state.rules) ? h('p', { class: 'small' }, U.pendingTag('水壶内的水是否额外占容量：待配置'), ' 目前只计算水壶本身。') : null,
        h('div', { class: 'filters' }, [['all', '全部']].concat(C.CATEGORIES.map(function (c) { return [c.id, c.name]; })).map(function (f) {
          var n = f[0] === 'all' ? state.inventory.length : state.inventory.filter(function (e) { return defOf(e).category === f[0]; }).length;
          return h('button', { type: 'button', class: 'filter ' + (ui.filter === f[0] ? 'on' : ''), onclick: function () { ui.filter = f[0]; render(); } }, f[1] + (n ? ' ' + n : ''));
        })),
        h('div', { class: 'row' },
          h('button', { type: 'button', class: 'btn primary', onclick: addItemDialog }, '+ 添加物品'),
          h('button', { type: 'button', class: 'btn', onclick: customItemDialog }, '新建自定义物品'))),
      list.length ? list.map(itemCard) : h('p', { class: 'empty card' }, state.inventory.length ? '这个分类下没有物品。' : '库存是空的。主持人发放物资后，请在这里手动添加。'));
  }

  function itemCard(e) {
    var def = defOf(e);
    var carried = carriedQty(e.id);
    var task = state.rules.tasksEnabled && state.taskId === 'hoarder';
    var hoardable = task && C.isStackable(def) && e.qty >= 3 && e.defId !== 'bread' && e.defId !== 'water';
    return h('section', { class: 'card item-card', 'data-entry': e.id, 'data-def': e.defId },
      h('div', { class: 'row between' },
        h('div', { class: 'grow' },
          h('div', { class: 'item-name' }, def.name, C.isStackable(def) ? h('span', { class: 'qty' }, '×' + e.qty) : null, ' ',
            carried ? chip('携带中 ' + carried, 'ok') : null, def.unknown ? chip('未知物品', 'danger') : null),
          h('div', { class: 'muted small' }, (C.CATEGORIES.find(function (c) { return c.id === def.category; }) || {}).name + ' · 每件占 ' + C.fmtUnits(def.capacityTicks) + ' 单位 · 合计 ' + C.fmtUnits(C.entryTicks(e, state.customItems, state.rules)))),
        h('div', { class: 'row tight' },
          def.use ? h('button', { type: 'button', class: 'btn small primary', onclick: function () { useItem(e.id); } }, '使用') : null,
          h('button', { type: 'button', class: 'btn small', onclick: function () { transferDialog(e.id); } }, '赠予／交公'),
          h('button', { type: 'button', class: 'btn small', onclick: function () { editItemDialog(e.id); } }, '修改'))),
      instanceLine(e, def),
      h('p', { class: 'small item-effect' }, def.effectText),
      (def.pending || []).length ? h('div', { class: 'row tight' }, def.pending.map(function (p) { return U.pendingTag(p); })) : null,
      e.remark ? h('p', { class: 'small' }, '备注：' + e.remark) : null,
      hoardable ? h('button', { type: 'button', class: 'btn small', onclick: function () { hoard(e.id); } }, '囤积者：秘密消耗1件记进度') : null);
  }

  function instanceLine(e, def) {
    if (def.instance === 'uses') return h('p', null, '剩余 ', h('b', null, e.uses + ' / ' + (state.rules.itemUses[def.id] || def.defaultUses)), ' 次（用完消失；未用完整件仍占 ' + C.fmtUnits(def.capacityTicks) + '）');
    if (def.instance === 'water') return h('p', null, '储水 ', h('b', null, (e.water || 0) + ' / ' + (def.maxWater || 2)), ' 份');
    if (def.instance === 'condition') return h('p', null, '状态：', h('b', { class: e.condition === 'damaged' ? 'risk-text' : 'ok-text' }, e.condition === 'damaged' ? '破损' : '完好'));
    if (def.instance === 'notes') {
      return h('div', null,
        h('p', null, '笔记 ', h('b', null, String(e.notes.length)), ' 条（每条1分）· 状态：', h('b', { class: e.condition === 'damaged' ? 'risk-text' : 'ok-text' }, e.condition === 'damaged' ? '损坏' : '完好')),
        e.notes.length ? h('ol', { class: 'notes' }, e.notes.map(function (n) { return h('li', null, n.text, h('span', { class: 'muted small' }, ' · 第' + n.day + '天')); })) : null);
    }
    return null;
  }

  function itemOptions() {
    var opts = [];
    C.CATEGORIES.forEach(function (cat) {
      C.allDefs(state.customItems).filter(function (d) { return d.category === cat.id; }).forEach(function (d) {
        opts.push([d.id, cat.name + ' · ' + d.name + '（占' + C.fmtUnits(d.capacityTicks) + '）']);
      });
    });
    return opts;
  }

  function addItemDialog() {
    var defId = 'bread';
    var qty = h('input', { type: 'number', min: 1, value: 1, class: 'num' });
    var remark = h('input', { type: 'text', placeholder: '可选，例如：主持人第2天发放' });
    var extraHost = h('div');
    var uses = h('input', { type: 'number', min: 1, class: 'num' });
    var water = h('input', { type: 'number', min: 0, max: 2, class: 'num', value: 0 });
    var damaged = h('input', { type: 'checkbox' });
    function drawExtra() {
      var def = C.getDef(defId, state.customItems);
      U.clear(extraHost);
      extraHost.appendChild(h('p', { class: 'small muted' }, def.effectText));
      if (def.instance === 'uses') { uses.value = state.rules.itemUses[def.id] || def.defaultUses; extraHost.appendChild(U.field('每件剩余次数', uses)); }
      if (def.instance === 'water') extraHost.appendChild(U.field('每个水壶储水（0～' + (def.maxWater || 2) + '）', water));
      if (def.instance === 'condition' || def.instance === 'notes') extraHost.appendChild(h('label', { class: 'check' }, damaged, def.instance === 'notes' ? '已损坏' : '破损'));
    }
    drawExtra();
    var sel = U.select(itemOptions(), defId, function (v) { defId = v; drawExtra(); });
    U.modal({
      title: '添加物品',
      body: h('div', { class: 'stack' }, U.field('物品', sel), U.field('数量（件）', qty), extraHost, U.field('备注', remark),
        h('p', { class: 'muted small' }, '主持人端不会自动发物资：拿到什么就在这里记什么。超出容量只警告。')),
      actions: [{ label: '取消', value: false }, { label: '添加', kind: 'primary', value: true }]
    }).then(function (ok) {
      if (!ok) return;
      var n = parseInt(qty.value, 10);
      if (!(n > 0)) { U.toast('数量必须是正整数', 'warn'); return; }
      var def = C.getDef(defId, state.customItems);
      var fields = null;
      if (def.instance === 'uses') {
        var u = parseInt(uses.value, 10);
        if (!(u > 0)) { U.toast('剩余次数需为正整数', 'warn'); return; }
        fields = { uses: u };
      } else if (def.instance === 'water') {
        var w = parseInt(water.value, 10);
        if (!(w >= 0 && w <= (def.maxWater || 2))) { U.toast('储水需在 0～' + (def.maxWater || 2) + ' 之间', 'warn'); return; }
        fields = { water: w };
      } else if (def.instance === 'condition' || def.instance === 'notes') {
        fields = { condition: damaged.checked ? 'damaged' : 'intact' };
      }
      commit('添加物品', function (s) {
        C.addItem(s.inventory, defId, n, { customItems: s.customItems, rules: s.rules, fields: fields, remark: remark.value.trim() || undefined });
        log(s, '添加物品：' + def.name + '×' + n + (remark.value.trim() ? '（' + remark.value.trim() + '）' : ''));
      });
      var after = invTicks();
      if (C.isInt(state.rules.inventoryCapacityTicks) && after > state.rules.inventoryCapacityTicks) U.toast('库存已超出上限（只警告）', 'warn');
    });
  }

  function customItemDialog() {
    var nameI = h('input', { type: 'text', placeholder: '物品名称', autofocus: true });
    var catSel = U.select(C.CATEGORIES.map(function (c) { return [c.id, c.name]; }), 'custom', function () {});
    var units = h('input', { type: 'number', class: 'num', min: 0, step: 0.5, value: 0.5 });
    var effect = h('input', { type: 'text', placeholder: '效果（按主持人说明）' });
    U.modal({
      title: '新建自定义物品',
      body: h('div', { class: 'stack' }, U.field('名称', nameI), U.field('分类', catSel), U.field('占位（单位）', units), U.field('效果', effect),
        h('p', { class: 'muted small' }, '主持人也可以把自定义物品放进规则包，你在「存档」页导入即可。')),
      actions: [{ label: '取消', value: false }, { label: '创建', kind: 'primary', value: true }]
    }).then(function (ok) {
      if (!ok) return;
      var n = U.parseNumber(units.value, true);
      if (!nameI.value.trim()) { U.toast('请输入名称', 'warn'); return; }
      if (n == null || Number.isNaN(n) || n < 0 || Math.round(n * 2) !== n * 2) { U.toast('占位需为 0.5 的倍数', 'warn'); return; }
      if (C.findDefByName(nameI.value.trim(), state.customItems)) { U.toast('已有同名物品', 'warn'); return; }
      commit('新建自定义物品', function (s) {
        var d = C.newCustomItem({ name: nameI.value, category: catSel.value, capacityTicks: Math.round(n * 2), effectText: effect.value });
        s.customItems.push(d);
        log(s, '新建自定义物品：' + d.name);
      });
    });
  }

  function editItemDialog(entryId) {
    var e = C.findEntry(state.inventory, entryId);
    if (!e) return;
    var def = defOf(e);
    var stack = C.isStackable(def);
    var qty = h('input', { type: 'number', min: 0, class: 'num', value: e.qty });
    var uses = h('input', { type: 'number', min: 0, class: 'num', value: e.uses });
    var water = h('input', { type: 'number', min: 0, max: def.maxWater || 2, class: 'num', value: e.water || 0 });
    var cond = e.condition || 'intact';
    var condHost = h('div');
    function drawCond() { U.clear(condHost).appendChild(U.segmented([['intact', '完好'], ['damaged', def.instance === 'notes' ? '损坏' : '破损']], cond, function (v) { cond = v; drawCond(); })); }
    drawCond();
    var remark = h('input', { type: 'text', value: e.remark || '' });
    var notes = (e.notes || []).map(function (n) { return Object.assign({}, n); });
    var notesHost = h('div');
    function drawNotes() {
      U.clear(notesHost).appendChild(h('div', { class: 'stack' },
        notes.map(function (n, i) {
          var t = h('input', { type: 'text', value: n.text });
          t.addEventListener('input', function () { n.text = t.value; });
          return h('div', { class: 'row' }, t, h('span', { class: 'muted small' }, '第' + n.day + '天'), h('button', { type: 'button', class: 'btn small', onclick: function () { notes.splice(i, 1); drawNotes(); } }, '删除'));
        }),
        h('button', { type: 'button', class: 'btn small', onclick: function () { notes.push({ text: '', day: today() }); drawNotes(); } }, '+ 添加笔记')));
    }
    if (def.instance === 'notes') drawNotes();
    U.modal({
      title: '修改：' + def.name,
      body: h('div', { class: 'stack' },
        h('p', { class: 'muted small' }, '手动覆盖用于纠错，会记入日志。'),
        stack ? U.field('数量（0＝删除）', qty) : null,
        def.instance === 'uses' ? U.field('剩余次数（0＝用完，删除）', uses) : null,
        def.instance === 'water' ? U.field('储水（0～' + (def.maxWater || 2) + '）', water) : null,
        def.instance === 'condition' || def.instance === 'notes' ? U.field('状态', condHost) : null,
        def.instance === 'notes' ? U.field('地图笔记', notesHost) : null,
        U.field('备注', remark),
        stack ? null : h('button', {
          type: 'button', class: 'btn small danger', onclick: function () {
            U.confirmBox('删除这件物品？', describe(e), '删除', 'danger').then(function (ok) {
              if (!ok) return;
              commit('删除物品', function (s) {
                C.removeQty(s.inventory, entryId, 1);
                syncLoadout(s);
                log(s, '删除物品：' + describe(e));
              });
            });
          }
        }, '删除这件')),
      actions: [{ label: '取消', value: false }, { label: '保存', kind: 'primary', value: true }]
    }).then(function (ok) {
      if (!ok) return;
      var n = parseInt(qty.value, 10);
      var u = parseInt(uses.value, 10);
      var w = parseInt(water.value, 10);
      if (stack && !(n >= 0)) { U.toast('数量不能是负数', 'warn'); return; }
      if (def.instance === 'uses' && !(u >= 0)) { U.toast('剩余次数不能是负数', 'warn'); return; }
      if (def.instance === 'water' && !(w >= 0 && w <= (def.maxWater || 2))) { U.toast('储水需在 0～' + (def.maxWater || 2) + ' 之间', 'warn'); return; }
      commit('修改物品', function (s) {
        var x = C.findEntry(s.inventory, entryId);
        var before = describe(x);
        x.remark = remark.value.trim() || undefined;
        if (!x.remark) delete x.remark;
        if (def.instance === 'water') x.water = w;
        if (def.instance === 'condition' || def.instance === 'notes') x.condition = cond;
        if (def.instance === 'notes') x.notes = notes.filter(function (k) { return k.text.trim(); });
        if (def.instance === 'uses') {
          x.uses = u;
          if (u === 0) s.inventory = s.inventory.filter(function (y) { return y.id !== entryId; });
        }
        if (stack) {
          if (n === 0) s.inventory = s.inventory.filter(function (y) { return y.id !== entryId; });
          else x.qty = n;
        }
        syncLoadout(s);
        log(s, '手动修改：' + before + ' → ' + (C.findEntry(s.inventory, entryId) ? describe(x) : '已删除'));
      });
    });
  }

  function hoard(entryId) {
    commit('囤积者进度', function (s) {
      var e = C.findEntry(s.inventory, entryId);
      if (!e || e.qty < 3) throw new Error('需要持有3件相同物品');
      var name = defOf(e).name;
      C.removeQty(s.inventory, entryId, 1);
      syncLoadout(s);
      s.taskProgress.count += 1;
      log(s, '囤积者：秘密消耗1件' + name + '，进度 ' + s.taskProgress.count + '/3');
    });
  }

  // ---------------------------------------------------------------- 赠予与交公

  function transferDialog(entryId) {
    var e = C.findEntry(state.inventory, entryId);
    if (!e) return;
    var def = defOf(e);
    var mode = 'gift';
    var modeHost = h('div');
    var who = h('input', { type: 'text', placeholder: '对方名字' });
    var qty = h('input', { type: 'number', class: 'num', min: 1, max: e.qty, value: 1 });
    function drawMode() { U.clear(modeHost).appendChild(U.segmented([['gift', '赠予／交易给玩家'], ['pool', '交给公共池']], mode, function (v) { mode = v; drawMode(); })); }
    drawMode();
    U.modal({
      title: '转出：' + describe(e),
      body: h('div', { class: 'stack' }, modeHost, U.field('对方（赠予时填写）', who), C.isStackable(def) ? U.field('数量（现有 ' + e.qty + '）', qty) : null,
        h('p', { class: 'muted small' }, '会从你的库存扣除并生成交接文本：对方（或主持人）需要手动添加，不会自动同步。')),
      actions: [{ label: '取消', value: false }, { label: '转出并生成文本', kind: 'primary', value: true }]
    }).then(function (ok) {
      if (!ok) return;
      var n = C.isStackable(def) ? parseInt(qty.value, 10) : 1;
      if (!(n > 0) || n > e.qty) { U.toast('数量需在 1～' + e.qty + ' 之间', 'warn'); return; }
      if (mode === 'gift' && !who.value.trim()) { U.toast('请填写对方名字', 'warn'); return; }
      var text = '';
      var done = commit(mode === 'gift' ? '赠予' : '交公', function (s) {
        var x = C.findEntry(s.inventory, entryId);
        var desc = C.isStackable(def) ? def.name + '×' + n + (x.remark ? '〔' + x.remark + '〕' : '') : describe(x);
        var notes = def.instance === 'notes' && x.notes.length ? '（地图笔记：' + x.notes.map(function (k) { return k.text; }).join('；') + '）' : '';
        C.removeQty(s.inventory, entryId, n);
        syncLoadout(s);
        if (mode === 'gift') {
          text = handoff(s, 'gift', '【赠予／交易·第' + today() + '天】' + myName() + ' 把「' + desc + '」交给了 ' + who.value.trim() + notes + '。请 ' + who.value.trim() + ' 在玩家页「库存」手动添加。');
          log(s, '转出给 ' + who.value.trim() + '：' + desc);
        } else {
          text = handoff(s, 'pool', '【交公·第' + today() + '天】' + myName() + ' 交出「' + desc + '」' + notes + '。请主持人在公共池手动加入。');
          log(s, '交给公共池：' + desc);
        }
      });
      if (done) showHandoff(text);
    });
  }

  // ---------------------------------------------------------------- 使用物品

  function useItem(entryId) {
    var e = C.findEntry(state.inventory, entryId);
    if (!e) return;
    var def = defOf(e);
    var handlers = { drink: useDrink, energyDrink: useDrink, eat: useEat, eatDrink: useEat, eatMulti: useEat, bandage: useBandage, medkit: useMedkit, map: useMap, canteen: useCanteen, liquor: useLiquor, vest: useVest, record: useRecord };
    (handlers[def.use] || useRecord)(e, def);
  }

  function thirstPicker(holder) {
    var host = h('div');
    function draw() { U.clear(host).appendChild(U.segmented(THIRST.map(function (t) { return [t, t]; }), holder.thirst, function (v) { holder.thirst = v; draw(); })); }
    draw();
    return host;
  }

  function hungerInput() {
    return h('input', { type: 'number', class: 'num', placeholder: '不改', step: 'any' });
  }

  function useDrink(e, def) {
    var holder = { thirst: state.thirst };
    U.modal({
      title: '饮用：' + def.name,
      body: h('div', { class: 'stack' },
        h('p', null, '消耗 1 件。补水幅度待定——请按主持人裁定手动设置口渴状态：'),
        thirstPicker(holder),
        def.use === 'energyDrink' ? h('div', { class: 'callout ok' }, '已确认：下一次行动判定视为充盈（实际饥饿值不变）。会记录为临时效果。') : null),
      actions: [{ label: '取消', value: false }, { label: '饮用', kind: 'primary', value: true }]
    }).then(function (ok) {
      if (!ok) return;
      commit('饮用' + def.name, function (s) {
        C.removeQty(s.inventory, e.id, 1);
        syncLoadout(s);
        var t0 = s.thirst;
        s.thirst = holder.thirst;
        if (def.use === 'energyDrink') s.temporaryEffects.push({ id: C.uid('fx'), text: '下一次行动判定视为充盈（功能饮料）', day: today(), attack: null });
        log(s, '饮用' + def.name + '：口渴 ' + t0 + ' → ' + s.thirst + (def.use === 'energyDrink' ? '；下一次行动视为充盈' : ''));
      });
    });
  }

  function useEat(e, def) {
    var amount = hungerInput();
    var holder = { thirst: state.thirst };
    var multi = def.use === 'eatMulti';
    U.modal({
      title: (multi ? '吃一次：' : '食用：') + def.name,
      body: h('div', { class: 'stack' },
        multi ? h('p', null, '剩余 ' + e.uses + ' 次 → 用后 ' + (e.uses - 1) + ' 次' + (e.uses - 1 === 0 ? '（用完消失）' : '') + '。每次约等于一份普通食物／面包。') : h('p', null, '消耗 1 件。'),
        U.field('饥饿值变化（恢复量待定：按主持人裁定手动填写，留空＝不改）', amount),
        def.use === 'eatDrink' ? U.field('口渴（补水幅度待定，手动设置）', thirstPicker(holder)) : null,
        h('p', { class: 'muted small' }, '提示：事件开启后不能通过临时进食提升本次状态；携带的食物可按事件规则消耗。')),
      actions: [{ label: '取消', value: false }, { label: '确定', kind: 'primary', value: true }]
    }).then(function (ok) {
      if (!ok) return;
      var n = U.parseNumber(amount.value, true);
      if (Number.isNaN(n)) { U.toast('饥饿值变化需为数字或留空', 'warn'); return; }
      commit('食用' + def.name, function (s) {
        var x = C.findEntry(s.inventory, e.id);
        if (multi) {
          x.uses -= 1;
          if (x.uses <= 0) s.inventory = s.inventory.filter(function (y) { return y.id !== e.id; });
        } else {
          C.removeQty(s.inventory, e.id, 1);
        }
        syncLoadout(s);
        var parts = [];
        if (n != null) {
          var old = s.hunger;
          s.hunger = (C.isNum(old) ? old : 0) + n;
          parts.push('饥饿值 ' + (old == null ? '未记录' : old) + ' → ' + s.hunger);
        } else {
          parts.push('饥饿值未改（恢复量待定）');
        }
        if (def.use === 'eatDrink' && holder.thirst !== s.thirst) { parts.push('口渴 ' + s.thirst + ' → ' + holder.thirst); s.thirst = holder.thirst; }
        log(s, (multi ? '吃一次' : '食用') + def.name + (multi ? '（剩' + Math.max(0, x.uses) + '次）' : '') + '：' + parts.join('；'));
      });
    });
  }

  function targetPicker(holder) {
    var host = h('div');
    var who = h('input', { type: 'text', placeholder: '对方名字', value: holder.who || '' });
    who.addEventListener('input', function () { holder.who = who.value; });
    function draw() {
      U.clear(host).appendChild(h('div', { class: 'stack' },
        U.segmented([['self', '自己'], ['other', '他人']], holder.target, function (v) { holder.target = v; draw(); }),
        holder.target === 'other' ? who : null));
    }
    draw();
    return host;
  }

  function useBandage(e, def) {
    var holder = { target: 'self', effect: 'heal', who: '' };
    var effHost = h('div');
    var bleeds = state.statuses.filter(function (st) { return st.statusId === 'bleeding'; });
    function drawEff() { U.clear(effHost).appendChild(U.segmented([['heal', '恢复1生命'], ['stop', '止血']], holder.effect, function (v) { holder.effect = v; drawEff(); })); }
    drawEff();
    U.modal({
      title: '使用绷带',
      body: h('div', { class: 'stack' }, U.field('对象', targetPicker(holder)), U.field('效果（二选一，已确认）', effHost),
        bleeds.length ? null : h('p', { class: 'muted small' }, '你目前没有流血伤口：对自己只能选「恢复1生命」。')),
      actions: [{ label: '取消', value: false }, { label: '使用', kind: 'primary', value: true }]
    }).then(function (ok) {
      if (!ok) return;
      if (holder.target === 'other' && !holder.who.trim()) { U.toast('请填写对方名字', 'warn'); return; }
      if (holder.target === 'self' && holder.effect === 'stop' && !bleeds.length) { U.toast('没有可以止血的伤口', 'warn'); return; }
      var text = '';
      commit('使用绷带', function (s) {
        C.removeQty(s.inventory, e.id, 1);
        syncLoadout(s);
        if (holder.target === 'self') {
          if (holder.effect === 'heal') { s.hp += 1; log(s, '绷带：恢复1生命 → ' + s.hp); }
          else {
            var b = s.statuses.find(function (st) { return st.statusId === 'bleeding'; });
            s.statuses = s.statuses.filter(function (st) { return st.id !== b.id; });
            log(s, '绷带：止血（清除一处流血伤口）');
          }
        } else {
          text = handoff(s, 'heal', '【治疗·第' + today() + '天】' + myName() + ' 对 ' + holder.who.trim() + ' 使用了绷带：' + (holder.effect === 'heal' ? '恢复1生命' : '止血（清除一处流血伤口）') + '。请 ' + holder.who.trim() + ' 在玩家页手动修改。');
          log(s, '对 ' + holder.who.trim() + ' 使用绷带（' + (holder.effect === 'heal' ? '恢复1生命' : '止血') + '）');
        }
      });
      if (text) showHandoff(text, '治疗他人：请对方手动修改');
    });
  }

  function useMedkit(e) {
    var holder = { target: 'self', who: '' };
    var checks = {};
    var doctor = state.rules.professionsEnabled && state.professionId === 'doctor';
    var doctorBox = h('input', { type: 'checkbox', checked: doctor });
    var statusList = h('div', { class: 'stack' }, state.statuses.length ? state.statuses.map(function (st) {
      var def = st.statusId ? C.getStatusDef(st.statusId) : null;
      var injury = def ? def.injury : null;
      checks[st.id] = injury === true;
      var box = h('input', { type: 'checkbox', checked: injury === true, onchange: function () { checks[st.id] = box.checked; } });
      return h('label', { class: 'check' }, box, st.name, injury === true ? chip('伤病类', 'ok') : U.pendingTag('是否属伤病类待裁定'));
    }) : h('p', { class: 'muted small' }, '你没有负面状态。'));
    U.modal({
      title: '使用医疗箱',
      body: h('div', { class: 'stack' },
        U.field('对象', targetPicker(holder)),
        h('p', null, '已确认：清除伤病类负面状态，并恢复2生命；不处理饥饿、口渴及脱水昏迷。不会把所有非正常状态清零。'),
        U.field('对自己时清除的状态', statusList),
        doctor ? h('label', { class: 'check' }, doctorBox, '医生（草案）：治疗他人时消耗医疗箱并获得1份绷带') : null),
      actions: [{ label: '取消', value: false }, { label: '使用', kind: 'primary', value: true }]
    }).then(function (ok) {
      if (!ok) return;
      if (holder.target === 'other' && !holder.who.trim()) { U.toast('请填写对方名字', 'warn'); return; }
      var text = '';
      commit('使用医疗箱', function (s) {
        C.removeQty(s.inventory, e.id, 1);
        syncLoadout(s);
        if (holder.target === 'self') {
          var removed = s.statuses.filter(function (st) { return checks[st.id]; }).map(function (st) { return st.name; });
          s.statuses = s.statuses.filter(function (st) { return !checks[st.id]; });
          s.hp += 2;
          log(s, '医疗箱：恢复2生命 → ' + s.hp + (removed.length ? '；清除 ' + removed.join('、') : ''));
        } else {
          text = handoff(s, 'heal', '【治疗·第' + today() + '天】' + myName() + ' 对 ' + holder.who.trim() + ' 使用了医疗箱：清除伤病类负面状态，并恢复2生命（不处理饥饿、口渴及脱水昏迷）。请 ' + holder.who.trim() + ' 在玩家页手动修改。');
          log(s, '对 ' + holder.who.trim() + ' 使用医疗箱');
          if (doctor && doctorBox.checked) {
            C.addItem(s.inventory, 'bandage', 1, { customItems: s.customItems, rules: s.rules });
            log(s, '医生（草案）：治疗他人后获得1份绷带');
          }
        }
      });
      if (text) showHandoff(text, '治疗他人：请对方手动修改');
    });
  }

  function useMap(e) {
    var text = h('input', { type: 'text', placeholder: '笔记内容：地点、时间或可能的回报', autofocus: true });
    U.modal({
      title: '地图',
      body: h('div', { class: 'stack' },
        h('p', null, '携带参加一次任务加1笔记（已确认），每条笔记1分。'),
        U.field('新笔记', text),
        h('p', { class: 'muted small' }, '移交地图时，笔记会写进交接文本告知对方；转移后笔记归属、损坏后及死亡后的分数由主持人裁定。')),
      actions: [
        { label: '取消', value: null },
        { label: e.condition === 'damaged' ? '标记完好' : '标记损坏', value: 'cond' },
        { label: '加1笔记', kind: 'primary', value: 'note' }
      ]
    }).then(function (v) {
      if (!v) return;
      commit(v === 'note' ? '地图加笔记' : '地图状态', function (s) {
        var x = C.findEntry(s.inventory, e.id);
        if (v === 'note') {
          var t = text.value.trim() || '任务笔记';
          x.notes.push({ text: t, day: today() });
          log(s, '地图加1笔记：' + t + '（共' + x.notes.length + '条）');
        } else {
          x.condition = x.condition === 'damaged' ? 'intact' : 'damaged';
          log(s, '地图标记为' + (x.condition === 'damaged' ? '损坏' : '完好'));
        }
      });
    });
  }

  function useCanteen(e, def) {
    var max = def.maxWater || 2;
    var holder = { thirst: state.thirst };
    U.modal({
      title: '军用水壶（储水 ' + (e.water || 0) + '/' + max + '）',
      body: h('div', { class: 'stack' },
        h('p', null, '水源或下雨条件下可获得1份水，最多储存' + max + '份。取水频率、饮用后是否生成普通水物品未定。'),
        U.field('饮用后的口渴（补水幅度待定，手动设置）', thirstPicker(holder))),
      actions: [
        { label: '取消', value: null },
        { label: '取水 +1', value: 'fill' },
        { label: '饮用 −1', kind: 'primary', value: 'drink' }
      ]
    }).then(function (v) {
      if (!v) return;
      if (v === 'fill' && (e.water || 0) >= max) { U.toast('最多储存 ' + max + ' 份', 'warn'); return; }
      if (v === 'drink' && !(e.water > 0)) { U.toast('水壶是空的', 'warn'); return; }
      commit(v === 'fill' ? '水壶取水' : '水壶饮用', function (s) {
        var x = C.findEntry(s.inventory, e.id);
        if (v === 'fill') {
          x.water = (x.water || 0) + 1;
          log(s, '水壶取水：储水 ' + x.water + '/' + max);
        } else {
          x.water -= 1;
          var t0 = s.thirst;
          s.thirst = holder.thirst;
          log(s, '水壶饮用：储水 ' + x.water + '/' + max + '；口渴 ' + t0 + ' → ' + s.thirst);
        }
      });
    });
  }

  function useLiquor(e) {
    U.confirmBox('事件中使用酒？', '消耗1件。已确认：临时攻击力+2，并承担一次口渴消耗。只记录到下一任务，不扩展为全回合加成；口渴变化请按结算手动修改。', '使用').then(function (ok) {
      if (!ok) return;
      commit('使用酒', function (s) {
        C.removeQty(s.inventory, e.id, 1);
        syncLoadout(s);
        s.temporaryEffects.push({ id: C.uid('fx'), text: '下一任务：临时攻击+2（酒）', day: today(), attack: 2 });
        s.temporaryEffects.push({ id: C.uid('fx'), text: '承担一次口渴消耗（酒，按结算手动修改）', day: today(), attack: null });
        log(s, '使用酒：下一任务临时攻击+2，并承担一次口渴消耗');
      });
    });
  }

  function useVest(e) {
    U.modal({
      title: '防弹背心（' + (e.condition === 'damaged' ? '破损' : '完好') + '）',
      body: h('div', { class: 'stack' },
        h('p', null, '防止任务中一次负面状态或生命损失。损坏时点、伤害范围待定：不会自动判定每次保护都会损坏。'),
        h('p', { class: 'muted small' }, '军人（草案）修复技能需要破损的背心。')),
      actions: [
        { label: '取消', value: null },
        { label: '记录抵挡一次', value: 'block' },
        { label: e.condition === 'damaged' ? '标记完好（已修复）' : '标记破损', kind: 'primary', value: 'toggle' }
      ]
    }).then(function (v) {
      if (!v) return;
      commit(v === 'block' ? '背心抵挡' : '背心状态', function (s) {
        var x = C.findEntry(s.inventory, e.id);
        if (v === 'block') log(s, '防弹背心抵挡一次（是否因此破损由主持人裁定）');
        else {
          x.condition = x.condition === 'damaged' ? 'intact' : 'damaged';
          log(s, '防弹背心标记为' + (x.condition === 'damaged' ? '破损' : '完好'));
        }
      });
    });
  }

  function useRecord(e, def) {
    var deduct = h('input', { type: 'checkbox' });
    var qty = h('input', { type: 'number', class: 'num', min: 1, max: e.qty, value: 1 });
    var note = h('input', { type: 'text', placeholder: '用在哪里（可选）' });
    var configured = state.rules.itemUses[def.id];
    U.modal({
      title: '记录使用：' + def.name,
      body: h('div', { class: 'stack' },
        h('p', null, def.effectText),
        h('p', { class: 'small' }, '使用次数：', configured == null ? U.pendingTag('待配置') : String(configured), '。未确定的使用不会自动扣数量。'),
        U.field('说明', note),
        h('label', { class: 'check' }, deduct, '同时扣除数量'), U.field('扣除件数', qty)),
      actions: [{ label: '取消', value: false }, { label: '记录', kind: 'primary', value: true }]
    }).then(function (ok) {
      if (!ok) return;
      var n = parseInt(qty.value, 10);
      if (deduct.checked && !(n > 0 && n <= e.qty)) { U.toast('扣除件数需在 1～' + e.qty + ' 之间', 'warn'); return; }
      commit('记录使用' + def.name, function (s) {
        if (deduct.checked) {
          C.removeQty(s.inventory, e.id, n);
          syncLoadout(s);
        }
        log(s, '记录使用' + def.name + (note.value ? '（' + note.value + '）' : '') + (deduct.checked ? '，扣除 ' + n + ' 件' : '，未扣数量'));
      });
    });
  }

  // ================================================================ 携带

  function renderLoadout() {
    var lo = state.loadout;
    if (!lo) {
      return h('div', { class: 'stack' },
        h('section', { class: 'card' },
          h('h2', null, '携带准备'),
          h('p', null, '从已有库存中选择本次事件或守夜要带的物品。携带列表只引用库存里的实例，不复制物品；事件中消耗会减少该实例；返回时只清空携带标记，不会重复添加物品。'),
          h('div', { class: 'row' },
            h('button', { type: 'button', class: 'btn primary', onclick: function () { startLoadout('event'); } }, '为事件准备携带'),
            h('button', { type: 'button', class: 'btn', onclick: function () { startLoadout('watch'); } }, '为守夜准备携带')),
          h('p', { class: 'muted small' }, '事件携带上限由具体事件规定（一般1～2单位）；守夜携带上限待定，不会默认沿用事件上限。')));
    }
    var usedTicks = lo.items.reduce(function (sum, r) {
      var e = C.findEntry(state.inventory, r.entryId);
      return sum + (e ? r.qty * (defOf(e).capacityTicks || 0) : 0);
    }, 0);
    var over = C.isInt(lo.limitTicks) && usedTicks > lo.limitTicks;
    var carried = [];
    lo.items.forEach(function (r) {
      var e = C.findEntry(state.inventory, r.entryId);
      if (e) for (var i = 0; i < r.qty; i++) carried.push(e);
    });
    var cs = C.combatSummary(state.hp, carried, state.customItems, tempAttack());
    var limitInput = h('input', { type: 'number', class: 'num', min: 0, step: 0.5, value: lo.limitTicks == null ? '' : lo.limitTicks / 2, placeholder: lo.context === 'watch' ? '待配置' : '按事件' });
    limitInput.addEventListener('change', function () {
      var n = U.parseNumber(limitInput.value, true);
      if (Number.isNaN(n) || (n != null && (n < 0 || Math.round(n * 2) !== n * 2))) { U.toast('上限需为 0.5 的倍数或留空', 'warn'); return; }
      commit('修改携带上限', function (s) { s.loadout.limitTicks = n == null ? null : Math.round(n * 2); log(s, '携带上限：' + (n == null ? '未设置' : n + '单位')); });
    });
    var labelInput = h('input', { type: 'text', value: lo.label || '', placeholder: lo.context === 'event' ? '事件名称' : '第几夜' });
    labelInput.addEventListener('change', function () { commit('携带备注', function (s) { s.loadout.label = labelInput.value; }, { undo: false }); });
    return h('div', { class: 'stack' },
      h('section', { class: 'card' },
        h('div', { class: 'card-head' }, h('h2', null, lo.context === 'event' ? '事件携带' : '守夜携带'), chip('第' + lo.day + '天', '')),
        h('div', { class: 'grid2' }, U.field('说明', labelInput), U.field(lo.context === 'event' ? '事件携带上限（单位）' : '守夜携带上限（单位，待定）', limitInput)),
        h('p', { class: over ? 'risk-text' : '' }, '已选占位：', h('b', null, C.fmtUnits(usedTicks)), ' / ', lo.limitTicks == null ? U.pendingTag(lo.context === 'watch' ? '守夜上限待配置' : '按事件规定') : C.fmtUnits(lo.limitTicks) + ' 单位'),
        over ? h('div', { class: 'callout risk' }, '超出携带上限：只警告，由主持人裁定。') : null),
      h('section', { class: 'card' },
        h('h3', null, '战斗力与临时效果'),
        h('p', null, '基础战斗力＝当前生命：', h('b', null, String(cs.base))),
        cs.weapons.length ? h('ul', null, cs.weapons.map(function (w) { return h('li', null, w.name + '：' + (w.bonus ? '攻击+' + w.bonus : w.note)); })) : h('p', { class: 'muted' }, '未携带武器。'),
        cs.temp ? h('p', null, '临时攻击：+' + cs.temp) : null,
        cs.multiple ? h('div', { class: 'callout info' }, '多武器是否叠加尚未确定：叠加＝', h('b', null, String(cs.stacked)), '；只取最高＝', h('b', null, String(cs.bestOnly)), '。请主持人裁定。') :
          h('p', null, '合计：', h('b', null, String(cs.stacked))),
        state.temporaryEffects.length ? h('ul', { class: 'small' }, state.temporaryEffects.map(function (fx) { return h('li', null, fx.text); })) : null,
        h('p', { class: 'muted small' }, '步枪存在不代表有弹：这里只在你的设备上显示，不会公开给主持人。')),
      h('section', { class: 'card' },
        h('h3', null, '选择携带的物品'),
        state.inventory.length ? h('ul', { class: 'list-plain' }, state.inventory.map(function (e) {
          var q = carriedQty(e.id);
          var def = defOf(e);
          return h('li', { class: 'row between' },
            h('span', { class: 'grow' }, describe(e), h('span', { class: 'muted small' }, ' · 每件' + C.fmtUnits(def.capacityTicks))),
            h('div', { class: 'row tight' },
              C.isStackable(def) ? [
                h('button', { type: 'button', class: 'btn small', disabled: q <= 0, onclick: function () { setCarry(e.id, q - 1); } }, '−'),
                h('span', { class: 'qty' }, String(q)),
                h('button', { type: 'button', class: 'btn small', disabled: q >= e.qty, onclick: function () { setCarry(e.id, q + 1); } }, '+')
              ] : h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: q > 0, onchange: function (ev) { setCarry(e.id, ev.target.checked ? 1 : 0); } }), '携带'),
              q > 0 && (def.use || C.isStackable(def)) ? h('button', { type: 'button', class: 'btn small risk', onclick: function () { consumeCarried(e.id); } }, '事件中消耗1') : null));
        })) : h('p', { class: 'empty' }, '库存是空的。')),
      h('div', { class: 'row' },
        h('button', {
          type: 'button', class: 'btn primary', onclick: function () {
            commit('返回清空携带', function (s) { log(s, '返回：清空携带标记（' + (s.loadout.context === 'event' ? '事件' : '守夜') + '），物品不重复添加'); s.loadout = null; });
          }
        }, '返回：清空携带标记'),
        h('span', { class: 'muted small' }, '只清除标记；没消耗的物品本来就在库存里。')));
  }

  function startLoadout(context) {
    commit('准备携带', function (s) {
      s.loadout = { context: context, label: '', day: today(), limitTicks: context === 'event' ? s.rules.eventCarryTicks : s.rules.watchCarryTicks, items: [] };
      log(s, '开始准备' + (context === 'event' ? '事件' : '守夜') + '携带');
    }, { undo: false });
  }

  function setCarry(entryId, q) {
    commit('调整携带', function (s) {
      var e = C.findEntry(s.inventory, entryId);
      if (!e) return false;
      var n = Math.max(0, Math.min(q, e.qty));
      s.loadout.items = s.loadout.items.filter(function (r) { return r.entryId !== entryId; });
      if (n > 0) s.loadout.items.push({ entryId: entryId, qty: n });
    }, { undo: false });
  }

  function consumeCarried(entryId) {
    var e = C.findEntry(state.inventory, entryId);
    if (!e) return;
    var def = defOf(e);
    var multi = def.instance === 'uses';
    U.confirmBox('事件中消耗', multi ? def.name + '：用掉1次（剩 ' + (e.uses - 1) + ' 次' + (e.uses - 1 <= 0 ? '，用完消失' : '') + '）' : '消耗 1 件' + def.name + '（从库存扣除）', '消耗', 'risk').then(function (ok) {
      if (!ok) return;
      commit('事件中消耗', function (s) {
        var x = C.findEntry(s.inventory, entryId);
        var row = s.loadout ? s.loadout.items.find(function (r) { return r.entryId === entryId; }) : null;
        if (multi) {
          x.uses -= 1;
          if (x.uses <= 0) s.inventory = s.inventory.filter(function (y) { return y.id !== entryId; });
        } else {
          C.removeQty(s.inventory, entryId, 1);
          // 消耗的是携带中的那一件：携带数量随之减1，其余携带保持不变
          if (row) row.qty -= 1;
        }
        syncLoadout(s);
        log(s, '事件中消耗：' + def.name + (multi ? '（1次）' : '×1'));
      });
    });
  }

  // ================================================================ 搜刮

  var scavTimer = null;

  function renderScavenge() {
    var sc = state.scavenge;
    var r = state.rules;
    var head = h('section', { class: 'card' },
      h('div', { class: 'card-head' }, h('h2', null, '阶段性搜刮'), chip(r.scavengeRounds + '轮 × ' + r.scavengeOptions + '选项 × ' + r.scavengeSeconds + '秒', '')),
      h('p', { class: 'small' }, '每轮几组物资组合（每组约 ' + C.fmtUnits(r.scavengeComboTicks) + ' 单位），超时自动选默认项（第一项，已标明）。计时按截止时间计算，候选与选择立即存档：刷新或切到后台都不会多领一轮。'),
      h('p', { class: 'small' }, '新所得进入待整理区：自留不超过 ' + C.fmtUnits(r.scavengeKeepTicks) + ' 单位，同时检查总库存 ' + C.fmtUnits(r.inventoryCapacityTicks) + ' 单位，其余形成交公清单。'));
    if (!sc || sc.status === 'submitted') {
      return h('div', { class: 'stack' }, head,
        sc ? submittedCard(sc) : null,
        h('section', { class: 'card' },
          h('button', { type: 'button', class: 'btn primary big', onclick: startScavenge }, '开始搜刮（主持人通知后）'),
          h('p', { class: 'muted small' }, '候选从下方的搜刮模板生成，不扣公共池（实现假设，主持人可改）。')),
        scavengeTemplateCard());
    }
    if (sc.status === 'running') return h('div', { class: 'stack' }, head, runningCard(sc));
    return h('div', { class: 'stack' }, head, organizeCard(sc));
  }

  function startScavenge() {
    U.confirmBox('开始搜刮？', '请确认主持人已经通知开始。开始后计时不能暂停，刷新也不会重置。', '开始').then(function (ok) {
      if (!ok) return;
      // 撤销不能回到搜刮开始之前（否则会丢掉进行中的回合）
      undo.clear();
      commit('开始搜刮', function (s) {
        if (s.scavenge && s.scavenge.status === 'submitted') s.scavengeHistory.unshift(s.scavenge);
        s.scavenge = C.startScavenge(s.scavengeTemplate, s.rules, s.customItems, Date.now(), Math.random);
        ui.keep = {};
        ui.transfer = {};
        log(s, '开始搜刮（第' + today() + '天）');
      }, { undo: false });
    });
  }

  function runningCard(sc) {
    var round = C.currentScavengeRound(sc);
    if (!round) return h('p', null, '处理中…');
    var remaining = Math.max(0, round.deadline - Date.now());
    return h('section', { class: 'card scav' },
      h('div', { class: 'row between' }, h('h2', null, '第 ' + (round.index + 1) + ' / ' + sc.cfg.rounds + ' 轮'),
        h('div', { class: 'scav-clock', id: 'scav-clock' }, (remaining / 1000).toFixed(1) + ' 秒')),
      h('div', { class: 'meter' }, h('span', { id: 'scav-bar', style: 'width:' + (remaining / (sc.cfg.seconds * 1000)) * 100 + '%' })),
      h('div', { class: 'scav-options' }, round.options.map(function (combo, i) {
        return h('button', { type: 'button', class: 'scav-option ' + (i === 0 ? 'default' : ''), 'data-option': String(i), onclick: function () { chooseOption(round.index, i); } },
          h('div', { class: 'scav-option-head' }, String.fromCharCode(65 + i), i === 0 ? chip('默认：超时自动选择', 'demo') : null),
          combo.length ? h('ul', null, combo.map(function (it) { return h('li', null, C.getDef(it.defId, state.customItems).name + ' ×' + it.qty); })) : h('p', { class: 'muted' }, '（空）'),
          h('div', { class: 'muted small' }, '共 ' + C.fmtUnits(C.comboTicks(combo, state.customItems)) + ' 单位'));
      })),
      sc.rounds.length > 1 ? h('p', { class: 'muted small' }, '已完成：' + sc.rounds.slice(0, -1).map(function (r) { return '第' + (r.index + 1) + '轮选 ' + String.fromCharCode(65 + r.choice) + (r.auto ? '（超时默认）' : ''); }).join('；')) : null);
  }

  function chooseOption(roundIndex, optionIndex) {
    var result = null;
    commit('搜刮选择', function (s) {
      result = C.chooseScavenge(s.scavenge, roundIndex, optionIndex, Date.now(), s.customItems, Math.random);
      if (result.ok) log(s, '搜刮第' + (roundIndex + 1) + '轮选择 ' + String.fromCharCode(65 + optionIndex));
      else log(s, '搜刮第' + (roundIndex + 1) + '轮超时，按默认项记录');
    }, { undo: false });
    if (result && !result.ok) U.toast(result.reason, 'warn');
  }

  function scavTick() {
    var sc = state.scavenge;
    if (!sc || sc.status !== 'running') return;
    var round = C.currentScavengeRound(sc);
    if (round && Date.now() >= round.deadline) {
      commit('搜刮超时', function (s) {
        var before = s.scavenge.rounds.length;
        C.settleScavenge(s.scavenge, Date.now(), s.customItems, Math.random);
        log(s, '搜刮超时：自动选默认项（第一项）' + (s.scavenge.rounds.length > before ? '，进入下一轮' : ''));
      }, { undo: false });
      return;
    }
    if (round && ui.tab === 'scavenge') {
      var remaining = Math.max(0, round.deadline - Date.now());
      var clock = document.getElementById('scav-clock');
      var bar = document.getElementById('scav-bar');
      if (clock) clock.textContent = (remaining / 1000).toFixed(1) + ' 秒';
      if (bar) bar.style.width = (remaining / (sc.cfg.seconds * 1000)) * 100 + '%';
    }
  }

  function organizeCard(sc) {
    var gains = C.scavengeGains(sc);
    var keep = gains.map(function (g) { return { defId: g.defId, qty: Math.min(ui.keep[g.defId] || 0, g.qty) }; });
    var transferTicks = 0;
    var transfers = [];
    Object.keys(ui.transfer).forEach(function (id) {
      var e = C.findEntry(state.inventory, id);
      var q = ui.transfer[id];
      if (e && q > 0) {
        var n = Math.min(q, e.qty);
        transfers.push({ entry: e, qty: n });
        transferTicks += n * (defOf(e).capacityTicks || 0);
      }
    });
    var check = C.checkScavengeKeep(keep.filter(function (k) { return k.qty > 0; }), invTicks(), transferTicks, state.rules, state.customItems);
    return h('div', { class: 'stack' },
      h('section', { class: 'card' },
        h('div', { class: 'card-head' }, h('h2', null, '待整理区'), chip('三轮已完成', 'ok')),
        h('p', { class: 'small muted' }, sc.rounds.map(function (r) { return '第' + (r.index + 1) + '轮 ' + String.fromCharCode(65 + r.choice) + (r.auto ? '（超时默认）' : ''); }).join('　')),
        gains.length ? h('ul', { class: 'list-plain' }, gains.map(function (g) {
          var k = Math.min(ui.keep[g.defId] || 0, g.qty);
          var def = C.getDef(g.defId, state.customItems);
          return h('li', { class: 'row between' },
            h('span', { class: 'grow' }, def.name + ' ×' + g.qty, h('span', { class: 'muted small' }, ' · 每件' + C.fmtUnits(def.capacityTicks))),
            h('span', { class: 'row tight' }, '自留',
              h('button', { type: 'button', class: 'btn small', disabled: k <= 0, onclick: function () { ui.keep[g.defId] = k - 1; render(); } }, '−'),
              h('span', { class: 'qty' }, String(k)),
              h('button', { type: 'button', class: 'btn small', disabled: k >= g.qty, onclick: function () { ui.keep[g.defId] = k + 1; render(); } }, '+'),
              h('span', { class: 'muted small' }, '交公 ' + (g.qty - k))));
        })) : h('p', { class: 'empty' }, '这次什么也没搜到。'),
        h('p', { class: check.keepOver ? 'risk-text' : '' }, '本次自留：', h('b', null, C.fmtUnits(check.keepTicks) + ' / ' + C.fmtUnits(check.keepLimit)), ' 单位' + (check.keepOver ? '（超出自留额度）' : '')),
        h('p', { class: check.inventoryOver ? 'risk-text' : '' }, '提交后总库存：', h('b', null, C.fmtUnits(check.inventoryAfter) + ' / ' + C.fmtUnits(check.inventoryLimit)), ' 单位' + (check.inventoryOver ? '（超出总库存，只警告）' : ''))),
      h('details', { class: 'card' },
        h('summary', null, h('b', null, '单独转出旧物品'), h('span', { class: 'muted small' }, ' 腾出库存；不算进本次搜刮所得')),
        state.inventory.length ? h('ul', { class: 'list-plain' }, state.inventory.map(function (e) {
          var q = Math.min(ui.transfer[e.id] || 0, e.qty);
          return h('li', { class: 'row between' }, h('span', { class: 'grow' }, describe(e)),
            h('span', { class: 'row tight' },
              h('button', { type: 'button', class: 'btn small', disabled: q <= 0, onclick: function () { ui.transfer[e.id] = q - 1; render(); } }, '−'),
              h('span', { class: 'qty' }, String(q)),
              h('button', { type: 'button', class: 'btn small', disabled: q >= e.qty, onclick: function () { ui.transfer[e.id] = q + 1; render(); } }, '+')));
        })) : h('p', { class: 'empty' }, '库存是空的。')),
      h('button', { type: 'button', class: 'btn primary big', onclick: function () { previewSubmit(sc, gains, keep, transfers, check); } }, '预览并提交'));
  }

  function previewSubmit(sc, gains, keep, transfers, check) {
    var handIn = gains.map(function (g) {
      var k = keep.find(function (x) { return x.defId === g.defId; });
      return { defId: g.defId, qty: g.qty - (k ? k.qty : 0) };
    }).filter(function (x) { return x.qty > 0; });
    var kept = keep.filter(function (k) { return k.qty > 0; });
    var over = check.keepOver || check.inventoryOver;
    var override = h('input', { type: 'checkbox' });
    U.modal({
      title: '预览：一次性提交',
      body: h('div', { class: 'stack' },
        h('p', null, h('b', null, '自留（加入库存）：'), kept.length ? C.formatItemList(kept, state.customItems) : '无'),
        h('p', null, h('b', null, '本次所得交公：'), handIn.length ? C.formatItemList(handIn, state.customItems) : '无'),
        transfers.length ? h('p', null, h('b', null, '旧物品转出（不算本次所得）：'), transfers.map(function (t) { return describe(t.entry) + (C.isStackable(defOf(t.entry)) ? '（' + t.qty + '件）' : ''); }).join('、')) : null,
        over ? h('div', { class: 'callout risk' }, (check.keepOver ? '自留超过 ' + C.fmtUnits(check.keepLimit) + ' 单位。' : '') + (check.inventoryOver ? '提交后总库存超过 ' + C.fmtUnits(check.inventoryLimit) + ' 单位。' : '') + '只警告，不阻断主持人裁定。') : null,
        over ? h('label', { class: 'check' }, override, '主持人已裁定，仍然提交') : null,
        h('p', { class: 'muted small' }, '提交后只能提交一次：自留物品加入库存，交公清单生成交接文本给主持人手动加入公共池。')),
      actions: [{ label: '返回修改', value: false }, { label: '确认提交', kind: 'primary', value: true, validate: function () { return over && !override.checked ? '超出额度：请先勾选「主持人已裁定」' : ''; } }]
    }).then(function (ok) {
      if (!ok) return;
      var text = '';
      var done = commit('提交搜刮', function (s) {
        if (!s.scavenge || s.scavenge.id !== sc.id || s.scavenge.status !== 'organize') throw new Error('本次搜刮已提交，不会重复领取');
        kept.forEach(function (k) { C.addItem(s.inventory, k.defId, k.qty, { customItems: s.customItems, rules: s.rules }); });
        var oldOut = [];
        transfers.forEach(function (t) {
          var e = C.findEntry(s.inventory, t.entry.id);
          if (!e) return;
          oldOut.push(C.isStackable(defOf(e)) ? defOf(e).name + '×' + t.qty : describe(e));
          C.removeQty(s.inventory, e.id, Math.min(t.qty, e.qty));
        });
        syncLoadout(s);
        var lines = ['【搜刮交公·第' + today() + '天】' + myName() + '：'];
        lines.push('本次所得交公：' + (handIn.length ? C.formatItemList(handIn, s.customItems) : '无'));
        if (oldOut.length) lines.push('另交出旧物品（不算本次所得）：' + oldOut.join('、'));
        lines.push('自留 ' + C.fmtUnits(check.keepTicks) + ' 单位' + (over ? '（超出额度，已由主持人裁定）' : '') + '。请主持人在公共池手动加入。');
        text = handoff(s, 'scavenge', lines.join('\n'));
        s.scavenge.status = 'submitted';
        s.scavenge.submitted = { at: Date.now(), kept: kept, handIn: handIn, oldOut: oldOut, text: text, override: over };
        log(s, '提交搜刮：自留 ' + (kept.length ? C.formatItemList(kept, s.customItems) : '无') + '；交公 ' + (handIn.length ? C.formatItemList(handIn, s.customItems) : '无') + (oldOut.length ? '；旧物品转出 ' + oldOut.join('、') : ''));
      });
      if (done) {
        ui.keep = {};
        ui.transfer = {};
        showHandoff(text, '交公清单：发给主持人');
      }
    });
  }

  function submittedCard(sc) {
    return h('section', { class: 'card' },
      h('div', { class: 'card-head' }, h('h2', null, '上一次搜刮'), chip('已提交 ' + U.fmtTime(sc.submitted.at), 'ok')),
      U.copyBlock(sc.submitted.text, { label: '复制交公清单' }));
  }

  function scavengeTemplateCard() {
    var t = state.scavengeTemplate;
    return h('details', { class: 'card' },
      h('summary', null, h('b', null, '搜刮模板：' + t.name), ' ', t.isExample ? U.ruleBadge('impl') : chip('自定义', '')),
      h('p', { class: 'section-note' }, t.note || ''),
      h('div', { class: 'weights' }, t.items.map(function (it, i) {
        var input = h('input', { type: 'number', class: 'num', min: 0, step: 'any', value: it.weight });
        input.addEventListener('change', function () {
          var n = U.parseNumber(input.value, true);
          if (n == null || Number.isNaN(n) || n < 0) { U.toast('权重需为非负数字（0＝不出现）', 'warn'); input.value = it.weight; return; }
          commit('修改搜刮模板', function (s) { s.scavengeTemplate.items[i].weight = n; s.scavengeTemplate.isExample = false; s.scavengeTemplate.name = '自定义搜刮模板'; }, { undo: true });
        });
        return h('label', { class: 'weight' }, C.getDef(it.defId, state.customItems).name, input);
      })),
      h('div', { class: 'row' },
        h('button', {
          type: 'button', class: 'btn small', onclick: function () {
            var defs = C.allDefs(state.customItems).filter(function (d) { return !t.items.some(function (it) { return it.defId === d.id; }); });
            if (!defs.length) { U.toast('所有物品都已在模板中', 'warn'); return; }
            commit('模板加入物品', function (s) { defs.forEach(function (d) { s.scavengeTemplate.items.push({ defId: d.id, weight: 0 }); }); });
          }
        }, '加入自定义物品（权重0）'),
        h('button', { type: 'button', class: 'btn small', onclick: function () { commit('恢复示例模板', function (s) { s.scavengeTemplate = C.defaultScavengeTemplate(); }); } }, '恢复示例模板')));
  }

  // ================================================================ 行动

  function renderAction() {
    var usedToday = state.action.day === today() && state.action.used;
    var prof = state.rules.professionsEnabled ? C.getProfession(state.professionId) : null;
    var craftName = h('input', { type: 'text', placeholder: '例如：制造子弹' });
    var craftReq = h('input', { type: 'number', class: 'num', min: 1, placeholder: '回合' });
    return h('div', { class: 'stack' },
      h('section', { class: 'card' },
        h('div', { class: 'card-head' }, h('h2', null, '第 ' + today() + ' 天的个人行动')),
        h('label', { class: 'check big-check' }, h('input', {
          type: 'checkbox', checked: usedToday, onchange: function (e) {
            var used = e.target.checked;
            commit('行动标记', function (s) { s.action = { day: today(), used: used, note: s.action.note || '' }; log(s, used ? '标记今日行动已使用' : '取消今日行动已使用'); });
          }
        }), usedToday ? '今日行动已使用' : '今日行动未使用'),
        h('p', { class: 'muted small' }, '每天一次行动（技能、换位或计划守夜名单）。这里的标记可人工修改，不与主持人自动同步。')),
      h('section', { class: 'card' },
        h('div', { class: 'card-head' }, h('h2', null, '职业技能'), U.ruleBadge('draft')),
        !state.rules.professionsEnabled ? h('p', { class: 'muted' }, '职业草案未启用（主持人明确启用后，在「存档 → 规则」打开）。') :
          prof ? h('div', null, h('p', null, h('b', null, prof.name + '：'), prof.text), h('p', null, U.pendingTag(prof.pending)),
            h('button', {
              type: 'button', class: 'btn primary', onclick: function () {
                var note = h('input', { type: 'text', placeholder: '用在谁身上、做了什么', autofocus: true });
                U.modal({ title: '记录使用技能', body: U.field('说明', note), actions: [{ label: '取消', value: false }, { label: '记录', kind: 'primary', value: true }] }).then(function (ok) {
                  if (!ok) return;
                  commit('使用技能', function (s) {
                    s.skillLog.unshift({ id: C.uid('sk'), day: today(), text: note.value || prof.name + '技能' });
                    log(s, '使用技能（' + prof.name + '）：' + (note.value || ''));
                  });
                });
              }
            }, '记录使用技能')) : h('p', { class: 'muted' }, '还没有选择职业（在「身份」页选择）。'),
        state.skillLog.length ? h('ul', { class: 'list-plain' }, state.skillLog.map(function (k) { return h('li', null, '第' + k.day + '天：' + k.text); })) : null),
      h('section', { class: 'card' },
        h('div', { class: 'card-head' }, h('h2', null, '制作进度')),
        state.crafting.length ? h('ul', { class: 'list-plain' }, state.crafting.map(function (c) {
          var done = C.isInt(c.required) && c.progress >= c.required;
          return h('li', { class: 'row between' },
            h('span', { class: 'grow' }, h('b', null, c.name), ' ', c.progress + ' / ' + (c.required == null ? '?' : c.required) + ' 回合', done ? chip('完成', 'ok') : null),
            h('span', { class: 'row tight' },
              h('button', { type: 'button', class: 'btn small', onclick: function () { craftStep(c.id, -1); } }, '−1'),
              h('button', { type: 'button', class: 'btn small', onclick: function () { craftStep(c.id, 1); } }, '+1'),
              h('button', { type: 'button', class: 'btn small', onclick: function () { commit('删除制作', function (s) { s.crafting = s.crafting.filter(function (x) { return x.id !== c.id; }); log(s, '删除制作项：' + c.name); }); } }, '删除')));
        })) : h('p', { class: 'empty' }, '没有进行中的制作。'),
        h('div', { class: 'row' }, craftName, craftReq, h('button', {
          type: 'button', class: 'btn', onclick: function () {
            var name = craftName.value.trim();
            var req = U.parseNumber(craftReq.value, false);
            if (!name) { U.toast('请输入制作内容', 'warn'); return; }
            if (Number.isNaN(req) || (req != null && req < 1)) { U.toast('回合数需为正整数或留空', 'warn'); return; }
            commit('新增制作', function (s) { s.crafting.push({ id: C.uid('cr'), name: name, progress: 0, required: req, note: '' }); log(s, '新增制作项：' + name); });
          }
        }, '新增')),
        h('p', { class: 'muted small' }, '例如军人（草案）：持枪两个回合制造1份子弹、两个回合修复破损背心；两回合是否各耗行动未定。完成后请手动修改库存。')));
  }

  function craftStep(id, d) {
    commit('制作进度', function (s) {
      var c = s.crafting.find(function (x) { return x.id === id; });
      c.progress = Math.max(0, c.progress + d);
      log(s, '制作进度：' + c.name + ' ' + c.progress + '/' + (c.required == null ? '?' : c.required));
    });
  }

  // ================================================================ 身份

  function renderIdentity() {
    function textField(label, key, hint, selfBtn) {
      var input = h('input', { type: 'text', value: state[key] || '' });
      input.addEventListener('change', function () { commit('修改' + label, function (s) { s[key] = input.value.trim(); log(s, label + '：' + (input.value.trim() || '（空）')); }); });
      return U.field(label, h('div', { class: 'row' }, input, selfBtn ? h('button', { type: 'button', class: 'btn small', onclick: function () { commit('指向自己', function (s) { s[key] = s.name || '自己'; log(s, label + '：自己'); }); } }, '自己') : null), hint);
    }
    var prof = C.getProfession(state.professionId);
    var task = C.getTask(state.taskId);
    return h('div', { class: 'stack' },
      h('section', { class: 'card' },
        h('h2', null, '身份与秘密'),
        textField('姓名', 'name'),
        textField('爱的人', 'loveName', '由主持人私信分配，手动填写；可以是自己', true),
        textField('恨的人', 'hateName', '可以是自己；爱与恨能否是同一人尚未确定', true)),
      h('section', { class: 'card' },
        h('div', { class: 'card-head' }, h('h2', null, '职业'), U.ruleBadge('draft')),
        state.rules.professionsEnabled ? h('div', { class: 'stack' },
          U.select([['', '未选择']].concat(C.PROFESSIONS.map(function (p) { return [p.id, p.name]; })), state.professionId || '', function (v) {
            commit('选择职业', function (s) { s.professionId = v || null; log(s, '职业：' + (v ? C.getProfession(v).name : '未选择')); });
          }),
          prof ? h('div', { class: 'callout info' }, h('b', null, prof.name + '：'), prof.text, h('div', null, U.pendingTag(prof.pending))) : null,
          h('p', { class: 'muted small' }, '职业没有专属分数，除非之后确认。')) : h('p', { class: 'muted' }, '职业草案未启用。')),
      h('section', { class: 'card' },
        h('div', { class: 'card-head' }, h('h2', null, '秘密任务'), U.ruleBadge('draft')),
        state.rules.tasksEnabled ? h('div', { class: 'stack' },
          U.select([['', '未选择']].concat(C.TASKS.map(function (t) { return [t.id, t.name]; })), state.taskId || '', function (v) {
            commit('选择任务', function (s) { s.taskId = v || null; s.taskProgress = { count: 0, events: [], done: false, note: '' }; log(s, '秘密任务：' + (v ? C.getTask(v).name : '未选择')); });
          }),
          task ? taskBox(task) : null,
          h('p', { class: 'muted small' }, '任务完成后统一固定奖励（奖励值：' + (state.rules.scoreTaskReward == null ? '待配置' : state.rules.scoreTaskReward) + '）。完成即锁定还是结算时判断，按任务与配置处理。停用草案：' + C.RETIRED_DRAFTS.map(function (d) { return d.name; }).join('、') + '（不可选择）。')) :
          h('p', { class: 'muted' }, '秘密任务草案未启用。')));
  }

  function taskBox(task) {
    var p = state.taskProgress;
    var body = [];
    if (task.progress === 'events') {
      var evInput = h('input', { type: 'text', placeholder: '亲自参与的公共事件名称' });
      body.push(h('p', null, '不同公共事件：', h('b', null, p.events.length + ' / ' + task.target)));
      body.push(p.events.length ? h('ul', null, p.events.map(function (n, i) {
        return h('li', null, n, ' ', h('button', { type: 'button', class: 'btn-link', onclick: function () { commit('移除事件', function (s) { s.taskProgress.events.splice(i, 1); }); } }, '移除'));
      })) : null);
      body.push(h('div', { class: 'row' }, evInput, h('button', {
        type: 'button', class: 'btn small', onclick: function () {
          var n = evInput.value.trim();
          if (!n) return;
          if (p.events.indexOf(n) >= 0) { U.toast('这件事件已记录过（需不同事件）', 'warn'); return; }
          commit('记录参与事件', function (s) { s.taskProgress.events.push(n); log(s, '冒险家：参与事件「' + n + '」（' + s.taskProgress.events.length + '/' + task.target + '）'); });
        }
      }, '记录')));
    } else if (task.progress === 'counter') {
      body.push(h('div', { class: 'row' }, '进度：', h('b', null, p.count + ' / ' + task.target),
        h('button', { type: 'button', class: 'btn small', onclick: function () { commit('任务进度', function (s) { s.taskProgress.count = Math.max(0, s.taskProgress.count - 1); log(s, task.name + '进度 ' + s.taskProgress.count); }); } }, '−1'),
        h('button', { type: 'button', class: 'btn small', onclick: function () { commit('任务进度', function (s) { s.taskProgress.count += 1; log(s, task.name + '进度 ' + s.taskProgress.count); }); } }, '+1')));
      if (task.id === 'hoarder') body.push(h('p', { class: 'muted small' }, '库存里同一物品（面包、普通水除外）持有3件时，物品卡上会出现「囤积者：秘密消耗1件」按钮。'));
    } else {
      body.push(h('p', { class: 'muted small' }, '在营救结算时由主持人判断：初始 ' + state.rules.playerCount + ' 人时最多 ' + Math.floor(state.rules.playerCount * 2 / 3) + ' 人死亡。'));
    }
    body.push(h('label', { class: 'check' }, h('input', {
      type: 'checkbox', checked: !!p.done, onchange: function (e) {
        var v = e.target.checked;
        commit('任务完成标记', function (s) { s.taskProgress.done = v; log(s, task.name + (v ? '：标记完成' : '：取消完成标记')); });
      }
    }), '已完成（由主持人确认）'));
    return h('div', { class: 'callout info stack' }, h('div', null, h('b', null, task.name + '：'), task.text), body);
  }

  // ================================================================ 分数

  function renderScore() {
    var counts = C.wealthCounts(state.inventory);
    var w = C.wealthScore(counts, !state.alive);
    var mapNotes = C.mapNotesTotal(state.inventory);
    var m = state.manualScores;
    var task = state.rules.tasksEnabled ? C.getTask(state.taskId) : null;
    var tot = C.settlementTotal({ wealth: w.score, map: m.map != null ? m.map : null, loveHate: m.loveHate, survival: m.survival, task: m.task, adjust: m.adjust });
    function manual(key, label, hint) {
      var input = h('input', { type: 'number', class: 'num', step: 'any', value: m[key] == null ? '' : m[key], placeholder: '待定' });
      input.addEventListener('change', function () {
        var n = U.parseNumber(input.value, true);
        if (Number.isNaN(n)) { U.toast('请输入数字或留空', 'warn'); input.value = m[key] == null ? '' : m[key]; return; }
        commit('手动分数', function (s) { s.manualScores[key] = n; log(s, label + '：' + (n == null ? '待定' : n)); });
      });
      return h('div', { class: 'rule-row' }, h('div', { class: 'rule-label' }, label), input, hint ? h('div', { class: 'field-hint' }, hint) : null);
    }
    var report = '【分数上报·第' + today() + '天】' + myName() + '：钞票' + counts.cash + '、名画' + counts.painting + '、珠宝' + counts.jewel +
      ' → 财富分 ' + (w.score == null ? '需主持人计分' : w.score) + (state.alive ? '' : '（已死亡）') + '；地图笔记 ' + mapNotes + ' 条' +
      (task ? '；任务 ' + task.name + (state.taskProgress.done ? '（已完成）' : '（进度 ' + (task.progress === 'events' ? state.taskProgress.events.length : state.taskProgress.count) + '/' + (task.target || '?') + '）') : '') + '。';
    return h('div', { class: 'stack' },
      h('section', { class: 'card' },
        h('h2', null, '财富估算'),
        h('p', null, '钞票 ' + counts.cash + ' × 1 ＋ 名画 ' + counts.painting + ' × 6 ＋ 珠宝 ' + counts.jewel + ' 件（查表：' + (C.jewelScore(counts.jewel) == null ? '超过5件' : C.jewelScore(counts.jewel)) + '）'),
        h('div', { class: 'big-num small-big' }, w.score == null ? '需主持人计分' : String(w.score)),
        w.text ? h('p', { class: w.pending ? 'risk-text' : 'muted' }, w.text) : null,
        h('p', { class: 'muted small' }, '珠宝 1～5 件总分依次 1、4、8、11、15；超过5件不自行外推。')),
      h('section', { class: 'card' },
        h('h2', null, '地图分'),
        h('p', null, '笔记合计 ', h('b', null, String(mapNotes)), ' 条（每条1分）'),
        h('p', { class: 'muted small' }, '转移后笔记归属、损坏后分数与死亡后的地图分由主持人裁定，不并入死亡即清零的财富。')),
      h('section', { class: 'card' },
        h('h2', null, '手动分数'),
        h('div', { class: 'rules-grid' },
          manual('map', '地图分（主持人裁定）', '留空＝待定'),
          manual('loveHate', '爱恨分', '分值待配置'),
          manual('survival', '生存分', '分值待配置'),
          manual('task', '任务分', '固定奖励值待配置'),
          manual('adjust', '裁定调整', '')),
        h('p', null, '合计（已知部分）：', h('b', null, String(tot.total)), tot.partial ? h('span', { class: 'pending-tag' }, '部分分数／待裁定：' + tot.missing.join('、')) : null)),
      h('section', { class: 'card' },
        h('h2', null, '上报给主持人'),
        U.copyBlock(report, { label: '复制分数上报', note: '主持人手动录入，不会自动同步' })));
  }

  // ================================================================ 记录与存档

  function renderSave() {
    return h('div', { class: 'stack' }, publicInfoCard(), rulesCard(), saveCard(), handoffsCard(), logCard());
  }

  function publicInfoCard() {
    var pi = state.publicInfo;
    var seat = h('input', { type: 'text', value: pi.seat || '', placeholder: '例如：3' });
    seat.addEventListener('change', function () { commit('记录座次', function (s) { s.publicInfo.seat = seat.value.trim(); log(s, '记录座次：' + seat.value.trim()); }); });
    var notes = h('textarea', { rows: 4, placeholder: '例如：公共池还剩面包；今晚守夜是 A、B。' });
    notes.value = pi.notes || '';
    notes.addEventListener('change', function () { commit('公共笔记', function (s) { s.publicInfo.notes = notes.value; }, { undo: false }); });
    return h('section', { class: 'card' },
      h('h2', null, '公共信息记录'),
      h('p', { class: 'section-note' }, '公共库存、座次、日期由主持人维护权威记录；这里只手动记必要信息。'),
      h('div', { class: 'grid2' }, U.field('当前第几天', U.stepper(pi.day, function (v) { setDay(v); }, { label: '天数' })), U.field('我的座次', seat)),
      U.field('公共笔记', notes));
  }

  function rulesCard() {
    var r = state.rules;
    function toggle(key, label) {
      return h('label', { class: 'check' }, h('input', {
        type: 'checkbox', checked: !!r[key], onchange: function (e) {
          var v = e.target.checked;
          commit('规则开关', function (s) { s.rules[key] = v; log(s, label + '：' + (v ? '开' : '关')); });
        }
      }), label);
    }
    function unitsField(key, label) {
      var input = h('input', { type: 'number', class: 'num', step: 0.5, min: 0, value: r[key] == null ? '' : r[key] / 2, placeholder: '待配置' });
      input.addEventListener('change', function () {
        var n = U.parseNumber(input.value, true);
        if (Number.isNaN(n) || (n != null && (n < 0 || Math.round(n * 2) !== n * 2))) { U.toast('请输入 0.5 的倍数或留空', 'warn'); return; }
        if (n == null && (key === 'inventoryCapacityTicks' || key === 'scavengeKeepTicks')) { U.toast('该项不能留空', 'warn'); return; }
        commit('修改规则', function (s) { s.rules[key] = n == null ? null : Math.round(n * 2); log(s, label + '：' + (n == null ? '待配置' : n + '单位')); });
      });
      return h('div', { class: 'rule-row' }, h('div', { class: 'rule-label' }, label), input);
    }
    function intField(key, label) {
      var input = h('input', { type: 'number', class: 'num', value: r[key] == null ? '' : r[key], placeholder: '待配置' });
      input.addEventListener('change', function () {
        var n = U.parseNumber(input.value, false);
        if (Number.isNaN(n)) { U.toast('请输入整数或留空', 'warn'); return; }
        commit('修改规则', function (s) { s.rules[key] = n; log(s, label + '：' + (n == null ? '待配置' : n)); });
      });
      return h('div', { class: 'rule-row' }, h('div', { class: 'rule-label' }, label), input);
    }
    var pack = h('textarea', { rows: 3, placeholder: '粘贴主持人发来的规则包 JSON' });
    return h('section', { class: 'card' },
      h('div', { class: 'card-head' }, h('h2', null, '规则（本机副本）'), h('span', { class: 'muted small' }, '以主持人通知为准')),
      h('div', { class: 'row' }, toggle('professionsEnabled', '启用职业草案'), toggle('tasksEnabled', '启用秘密任务草案'), toggle('draftStatusesEnabled', '启用候选负面状态')),
      h('div', { class: 'rules-grid' },
        unitsField('inventoryCapacityTicks', '个人总库存上限（暂定10）'),
        unitsField('scavengeKeepTicks', '搜刮自留额度（4）'),
        unitsField('eventCarryTicks', '事件携带上限默认值'),
        unitsField('watchCarryTicks', '守夜携带上限（待定）'),
        unitsField('canteenWaterTicks', '水壶内每份水占位（待定）'),
        intField('hpMax', '生命上限（待定）'),
        intField('hungerFullAt', '充盈阈值 ≥（待定）'),
        intField('hungerHungryAt', '饥饿阈值 ≤（待定）')),
      h('details', null, h('summary', null, '导入主持人规则包'),
        h('div', { class: 'stack' }, pack, h('button', { type: 'button', class: 'btn', onclick: function () { importRulesPack(pack.value); } }, '校验并导入'),
          h('p', { class: 'muted small' }, '只更新规则与自定义物品（以及包里附带的搜刮模板），不碰你的库存和状态。'))));
  }

  function importRulesPack(text) {
    var data;
    try { data = JSON.parse(text); } catch (e) { U.toast('不是有效的 JSON', 'warn'); return; }
    var v = C.validateRulesPack(data);
    if (!v.ok) { U.modal({ title: '导入失败：规则未改动', body: h('p', null, v.errors[0]) }); return; }
    commit('导入规则包', function (s) {
      s.rules = C.normalizeRules(data.rules);
      (data.customItems || []).forEach(function (d) {
        if (!d || !d.id || !d.name) return;
        var idx = s.customItems.findIndex(function (x) { return x.id === d.id; });
        if (idx >= 0) s.customItems[idx] = d;
        else s.customItems.push(d);
      });
      if (data.scavengeTemplate && Array.isArray(data.scavengeTemplate.items)) s.scavengeTemplate = data.scavengeTemplate;
      log(s, '导入主持人规则包');
    });
    U.toast('规则包已导入', 'ok');
  }

  function saveCard() {
    var fileInput = h('input', { type: 'file', accept: 'application/json,.json', class: 'offscreen' });
    fileInput.addEventListener('change', function () {
      var file = fileInput.files && fileInput.files[0];
      if (!file) return;
      U.readFileText(file).then(importSave, function (e) { U.toast(e.message, 'warn'); });
      fileInput.value = '';
    });
    var backups = store.backups();
    return h('section', { class: 'card' },
      h('div', { class: 'card-head' }, h('h2', null, '存档'), store.available ? chip('自动保存到本机', 'ok') : chip('本地保存不可用：仅内存', 'danger')),
      h('p', { class: 'section-note' }, '玩家存档与主持人存档使用不同的命名空间。导入前会校验并备份旧存档，导入失败不会覆盖当前存档。'),
      h('div', { class: 'row' },
        h('button', { type: 'button', class: 'btn primary', onclick: function () { U.downloadJSON('shelter-player-' + (state.name || 'me') + '-' + U.stamp() + '.json', state); } }, '导出 JSON'),
        h('button', { type: 'button', class: 'btn', onclick: function () { U.copyText(JSON.stringify(state)).then(function (ok) { U.toast(ok ? '已复制存档 JSON' : '复制失败', ok ? 'ok' : 'warn'); }); } }, '复制 JSON'),
        h('button', { type: 'button', class: 'btn', onclick: function () { fileInput.click(); } }, '导入文件'),
        h('button', { type: 'button', class: 'btn', onclick: pasteImport }, '粘贴导入'),
        h('button', { type: 'button', class: 'btn', onclick: undoLast, disabled: !undo.peek() }, U.icon('undo'), '撤销最近操作'),
        h('button', { type: 'button', class: 'btn danger', onclick: resetSave }, '重置'),
        fileInput),
      backups.length ? h('details', null, h('summary', null, '备份（' + backups.length + '）'), h('ul', { class: 'list-plain' }, backups.map(function (b, i) {
        return h('li', { class: 'row between' }, h('span', null, U.fmtTime(b.at) + ' · ' + (b.reason || '')), h('button', { type: 'button', class: 'btn small', onclick: function () { importSave(store.backups()[i].raw); } }, '恢复'));
      }))) : null,
      h('div', { class: 'card inset' },
        h('h3', null, '演示存档'),
        h('p', { class: 'muted small' }, '独立的存储位置：载入、修改、清空都不会碰到你的正式存档。'),
        slot === 'demo'
          ? h('div', { class: 'row' }, h('button', { type: 'button', class: 'btn', onclick: exitDemo }, '返回正式存档'), h('button', { type: 'button', class: 'btn danger', onclick: clearDemo }, '清空演示数据'))
          : h('button', { type: 'button', class: 'btn', onclick: enterDemo }, '打开演示存档')));
  }

  function importSave(text) {
    var data;
    try { data = JSON.parse(text); } catch (e) {
      U.modal({ title: '导入失败', body: h('p', null, '不是有效的 JSON（' + e.message + '）。当前存档未改动。') });
      return;
    }
    var v = C.validateSave(data, 'shelter-player');
    if (!v.ok) {
      U.modal({ title: '导入失败：当前存档未改动', body: h('ul', null, v.errors.slice(0, 10).map(function (e) { return h('li', null, e); })) });
      return;
    }
    U.confirmBox('导入存档？', '将用导入的存档替换当前' + (slot === 'demo' ? '演示' : '正式') + '存档。当前存档会先备份。', '导入').then(function (ok) {
      if (!ok) return;
      store.backup(JSON.stringify(state), '导入前自动备份');
      undo.push('导入存档', C.clone(state));
      state = C.normalizeSave(data, 'shelter-player');
      log(state, '导入存档');
      save();
      render();
      U.toast('导入成功', 'ok');
    });
  }

  function pasteImport() {
    var ta = h('textarea', { rows: 8, placeholder: '把存档 JSON 粘贴到这里', autofocus: true });
    U.modal({ title: '粘贴导入', body: ta, actions: [{ label: '取消', value: null }, { label: '校验并导入', kind: 'primary', value: function () { return ta.value; } }] })
      .then(function (text) { if (text) importSave(text); });
  }

  function resetSave() {
    U.confirmBox('重置存档？', '会清空当前' + (slot === 'demo' ? '演示' : '正式') + '存档（先自动备份）。', '重置', 'danger').then(function (ok) {
      if (!ok) return;
      store.backup(JSON.stringify(state), '重置前自动备份');
      undo.push('重置存档', C.clone(state));
      state = slot === 'demo' ? buildDemoState() : C.newPlayerState();
      log(state, '重置存档');
      save();
      render();
    });
  }

  function switchSlot(next) {
    slot = next;
    U.writeKey(KEY_SLOT, next);
    undo.clear();
    ui.keep = {};
    ui.transfer = {};
    state = loadState();
    save();
    render();
  }

  function enterDemo() { switchSlot('demo'); U.toast('已切换到演示存档（正式存档未改动）', 'ok'); }
  function exitDemo() { switchSlot('main'); U.toast('已返回正式存档', 'ok'); }

  function clearDemo() {
    U.confirmBox('清空演示数据？', '只删除演示存档，正式存档不受影响。', '清空', 'danger').then(function (ok) {
      if (!ok) return;
      new U.Store(KEY_DEMO).remove();
      switchSlot('main');
      U.toast('演示数据已清空', 'ok');
    });
  }

  function handoffsCard() {
    return h('details', { class: 'card' },
      h('summary', null, h('b', null, '交接记录（' + state.handoffs.length + '）'), h('span', { class: 'muted small' }, ' 赠予、交公、治疗他人、搜刮交公')),
      state.handoffs.length ? h('ul', { class: 'list-plain' }, state.handoffs.slice(0, 50).map(function (x) {
        return h('li', null, h('div', { class: 'muted small' }, U.fmtTime(x.at)), U.copyBlock(x.text));
      })) : h('p', { class: 'empty' }, '暂无。'));
  }

  function logCard() {
    return h('details', { class: 'card' },
      h('summary', null, h('b', null, '个人日志（' + state.log.length + '）')),
      h('ul', { class: 'log-list' }, state.log.slice(0, 300).map(function (l) {
        return h('li', null, h('span', { class: 'log-meta' }, U.fmtTime(l.at) + (l.day != null ? ' · 第' + l.day + '天' : '')), l.text);
      })));
  }

  // ================================================================ 启动

  function boot() {
    var tab = U.readKey(KEY_TAB);
    if (tab && TABS.some(function (t) { return t.id === tab; })) ui.tab = tab;
    state = loadState();
    if (state.scavenge && state.scavenge.status === 'running') {
      if (C.settleScavenge(state.scavenge, Date.now(), state.customItems, Math.random)) log(state, '搜刮：离开期间已超时的回合按默认项记录');
    }
    save();
    render();
    scavTimer = setInterval(scavTick, 100);
    document.addEventListener('visibilitychange', function () { if (!document.hidden) scavTick(); });
    window.addEventListener('storage', function (e) {
      if (e.key === (slot === 'demo' ? KEY_DEMO : KEY_MAIN)) {
        notices.push({ kind: 'risk', text: '另一个标签页修改了同一份玩家存档。请只保留一个标签页，然后刷新本页。' });
        render();
      }
    });
  }

  boot();
})();
