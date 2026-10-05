/*
 * 避难所 Playtest · 主持人端
 *
 * 公开展示区给 Discord 屏幕共享；库存、抽取详情、未公布名单与日志详情放在独立的隐藏管理区。
 * 隐藏时秘密内容根本不渲染进页面（不是模糊或蒙层），刷新后一律恢复隐藏。
 * 主持人端与玩家端互不同步：所有跨端变化都生成可复制的交接文本，由对方手动修改。
 */
(function () {
  'use strict';

  var C = window.ShelterCore;
  var U = window.ShelterUI;
  var h = U.h;

  var KEY_MAIN = 'shelter-playtest:host:v1';
  var KEY_DEMO = 'shelter-playtest:host-demo:v1';
  var KEY_SLOT = 'shelter-playtest:host:slot';
  var KEY_TAB = 'shelter-playtest:host:tab';

  // 三组：可以屏幕共享的（主持台、公开展示）｜要先暂停共享的秘密页｜设置。从左到右越来越「不能给人看」。
  var TABS = [
    { id: 'flow', name: '主持台', group: 'public' },
    { id: 'stage', name: '公开展示', group: 'public' },
    { id: 'supply', name: '补给与公共池', secret: true, group: 'secret' },
    { id: 'watch', name: '守夜', secret: true, group: 'secret' },
    { id: 'events', name: '公共事件', secret: true, group: 'secret' },
    { id: 'records', name: '记录与结算', secret: true, group: 'secret' },
    { id: 'log', name: '日志', secret: true, group: 'secret' },
    { id: 'settings', name: '设置与存档', group: 'setup' }
  ];

  var ACTION_TYPES = [
    ['plan', '计划守夜名单'],
    ['skill', '使用技能'],
    ['other', '其他行动'],
    ['pass', '放弃行动']
  ];

  var slot = U.readKey(KEY_SLOT) === 'demo' ? 'demo' : 'main';
  var store = null;
  var state = null;
  var notices = [];
  var undo = new U.UndoStack(40);
  var ui = { tab: 'flow', revealed: {}, drafts: {}, showAllNight: false, present: false, presentFs: false };

  // ================================================================ 演示内容（明确标记）

  var DEMO_EVENTS = [
    {
      name: '【演示】停电的售货机', location: '地下通道', tags: ['售货机', '跳棋'],
      body: '地下通道里有台还亮着按钮的售货机。投币口卡着一枚旧硬币——也可能是一颗跳棋。',
      participants: '1～2人', carryTicks: 2, conditions: '携带跳棋可冒充硬币', itemUses: '跳棋：冒充硬币', modifiers: '未定义的修正由主持人裁定',
      options: [
        { label: '派人去试试', outcomes: [
          { text: '售货机吐出两瓶水，交给公共池。', probability: 60, effects: { pool: [{ defId: 'water', qty: 2 }] } },
          { text: '机器吞了硬币，一言不发。', probability: 30, effects: {} },
          { text: '漏电！参与者生命-1。', probability: 10, effects: { personal: { target: '参与者', hp: -1 } } }
        ] },
        { label: '不理它', outcomes: [{ text: '什么也没有发生。', probability: 100, effects: {} }] }
      ]
    },
    {
      name: '【演示】断续的军方广播', location: '避难所大厅', tags: ['营救'],
      body: '收音机里传来断断续续的广播：「……撤离……推迟……请保持……」',
      participants: '全员投票', options: [
        { label: '用信号回应', outcomes: [
          { text: '对方似乎收到了。营救进度+1。', probability: 50, effects: { rescue: 1 } },
          { text: '信号引来了掠夺者，公共池失去2个面包。', probability: 50, effects: { pool: [{ defId: 'bread', qty: -2 }] } }
        ] },
        { label: '保持沉默', outcomes: [{ text: '广播渐渐沉寂。', probability: 100, effects: {} }] }
      ]
    }
  ];

  var DEMO_NIGHT = [
    { name: '【演示】平安无事', tendency: 'neutral', weight: 3, text: '一夜无事。只有风声和远处的狗叫。' },
    { name: '【演示】野兽靠近', tendency: 'danger', weight: 1, text: '有东西在门外徘徊。携带食物的守夜者可以用食物引开它；否则守夜者各生命-1（主持人裁定）。' },
    { name: '【演示】远处的信号弹', tendency: 'rescue', weight: 1, text: '守夜者看见远处升起信号弹：营救进度+1（主持人确认后修改）。' }
  ];

  function demoEvent(raw) {
    var ev = C.normalizeEvent(raw);
    ev.isDemo = true;
    ev.isDraft = false;
    return ev;
  }

  function demoNight(raw) {
    return Object.assign(C.newNightResult(), raw, { isDemo: true });
  }

  function buildDemoState() {
    var s = C.newHostState();
    s.isDemo = true;
    var names = ['A·老陈', 'B·阿珍', 'C·胖虎', 'D·修女', 'E·二狗', 'F·教授'];
    s.players = names.map(function (n, i) { return { id: 'demo_p' + (i + 1), name: n, alive: true }; });
    s.seatOrder = s.players.map(function (p) { return p.id; });
    [['bread', 6], ['water', 6], ['energy_bar', 2], ['cream_soup', 2], ['energy_drink', 1], ['bandage', 2], ['medkit', 1],
      ['cash', 4], ['jewel', 2], ['knife', 1], ['ammo', 2], ['map', 1], ['canteen', 1], ['checkers', 1]].forEach(function (p) {
      C.addItem(s.pool, p[0], p[1], { rules: s.rules });
    });
    s.poolTemplates = [{ id: C.uid('tpl'), name: '【演示】每日补给', text: '面包×3，普通水×3', isDemo: true }];
    s.opening = { items: [{ defId: 'bread', qty: 6 }, { defId: 'water', qty: 6 }], note: '【演示】开局物资由主持人自行设计，这里只是示例。', done: [false, false] };
    s.events = DEMO_EVENTS.map(demoEvent);
    s.nightLibrary = DEMO_NIGHT.map(demoNight);
    log(s, '载入演示存档（与正式存档完全分开）');
    return s;
  }

  // ================================================================ 存档与提交

  function loadState() {
    store = new U.Store(slot === 'demo' ? KEY_DEMO : KEY_MAIN);
    notices = [];
    var r = store.read();
    if (r.status === 'ok') {
      var v = C.validateSave(r.data, 'shelter-host');
      if (v.ok) return C.normalizeSave(r.data, 'shelter-host');
      store.backup(r.raw, '读取时校验失败：' + v.errors[0]);
      notices.push({ kind: 'danger', text: '本地存档无法读取（' + v.errors[0] + '）。原数据已另存为备份，当前是空白存档，可在「设置与存档」查看备份。' });
    } else if (r.status === 'corrupt') {
      store.backup(r.raw, '存档损坏');
      notices.push({ kind: 'danger', text: '本地存档已损坏。原数据已另存为备份，当前是空白存档。' });
    } else if (r.status === 'unavailable' || r.status === 'error') {
      notices.push({ kind: 'danger', text: '浏览器本地保存不可用（可能是隐私模式或存储被禁用）：页面仍在内存中运行，刷新即丢失——请随时在「设置与存档」导出 JSON。' });
    }
    return slot === 'demo' ? buildDemoState() : C.newHostState();
  }

  function save() {
    state.updatedAt = Date.now();
    if (!store.available) return;
    if (!store.write(state)) {
      var msg = '自动保存失败（' + ((store.lastError && store.lastError.name) || '未知错误') + '），可能是存储空间已满：请立即导出 JSON。';
      if (!notices.some(function (n) { return n.text === msg; })) notices.push({ kind: 'danger', text: msg });
    }
  }

  /**
   * 所有修改都走这里：先快照（供撤销）、再修改、再保存与重绘。
   * fn 抛错或返回 false 时恢复原状态，不留下半截修改。
   */
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

  /** 日志：secret 的条目只在「日志」页解锁后可见，公开日志与通知里不出现秘密内容。 */
  function log(s, text, secret) {
    s.log.unshift({ id: C.uid('log'), at: Date.now(), day: s.day, phase: s.phase, text: text, secret: !!secret });
    if (s.log.length > 2000) s.log.length = 2000;
  }

  function publish(s, kind, text, refId) {
    s.publicFeed.push({ id: C.uid('pub'), day: s.day, kind: kind, text: text, refId: refId || null, at: Date.now() });
  }

  // ================================================================ 查询工具

  function playerById(id) {
    for (var i = 0; i < state.players.length; i++) if (state.players[i].id === id) return state.players[i];
    return null;
  }

  function nameOf(id) {
    var p = playerById(id);
    return p ? p.name : '（已删除的玩家）';
  }

  function names(ids) {
    return ids.length ? ids.map(nameOf).join('、') : '（无）';
  }

  function isAlive(id) {
    var p = playerById(id);
    return !!p && p.alive !== false;
  }

  function aliveIds(s) {
    return (s || state).players.filter(function (p) { return p.alive !== false; }).map(function (p) { return p.id; });
  }

  function seatedAlive(s) {
    s = s || state;
    return s.seatOrder.filter(function (id) {
      var p = s.players.find(function (x) { return x.id === id; });
      return p && p.alive !== false;
    });
  }

  function defName(defId) {
    return C.getDef(defId, state.customItems).name;
  }

  function describe(entry) {
    return C.describeEntry(entry, state.customItems);
  }

  function setTab(id) {
    if (ui.present && id !== 'stage') exitPresent(true);
    ui.tab = id;
    U.writeKey(KEY_TAB, id);
    render();
    window.scrollTo(0, 0);
  }

  // ================================================================ 秘密遮挡

  /**
   * 秘密区块。未显示时只渲染一张占位卡——内容函数根本不会被调用，
   * 所以悬浮、页面搜索、通知、侧栏与日志摘要都拿不到秘密。
   */
  function gate(key, title, renderFn) {
    if (!ui.revealed[key]) {
      return h('section', { class: 'card gate', 'data-gate': key },
        h('div', { class: 'gate-icon' }, U.icon('lock')),
        h('h3', null, title + '：已隐藏'),
        h('p', { class: 'muted small' }, '隐藏时内容不会写进页面：悬浮、页面搜索、通知和日志摘要都看不到。'),
        h('button', { type: 'button', class: 'btn primary', onclick: function () { reveal(key, title); } }, U.icon('unlock'), '显示…（先暂停屏幕共享）'));
    }
    return h('div', { class: 'gated', 'data-gate-open': key },
      h('div', { class: 'reveal-bar' },
        h('span', null, U.icon('unlock'), ' 「' + title + '」正在显示：恢复屏幕共享前请先隐藏'),
        h('button', { type: 'button', class: 'btn small', onclick: function () { delete ui.revealed[key]; render(); } }, U.icon('eyeOff'), '隐藏')),
      renderFn());
  }

  function reveal(key, title) {
    var box = h('input', { type: 'checkbox', id: 'confirm-share-paused' });
    U.modal({
      title: '确认已暂停屏幕共享？',
      body: h('div', { class: 'stack' },
        h('p', null, '即将显示「' + title + '」。网站无法替 Discord 隐藏已经共享出去的画面——请先停止或切换屏幕共享。'),
        h('label', { class: 'check' }, box, '我已暂停／切换屏幕共享')),
      actions: [
        { label: '取消', value: false },
        { label: '显示', kind: 'primary', value: true, validate: function () { return box.checked ? '' : '请先勾选「我已暂停／切换屏幕共享」'; } }
      ]
    }).then(function (ok) {
      if (!ok) return;
      ui.revealed[key] = true;
      render();
    });
  }

  function hideAllSecrets() {
    ui.revealed = {};
    render();
    U.toast('已隐藏所有秘密', 'ok');
  }

  // ================================================================ 绑定输入的小工具

  function bindText(obj, key, attrs) {
    var el = h('input', Object.assign({ type: 'text', value: obj[key] == null ? '' : String(obj[key]) }, attrs || {}));
    el.addEventListener('input', function () { obj[key] = el.value; });
    return el;
  }

  function bindArea(obj, key, rows, attrs) {
    var el = h('textarea', Object.assign({ rows: rows || 3 }, attrs || {}));
    el.value = obj[key] == null ? '' : String(obj[key]);
    el.addEventListener('input', function () { obj[key] = el.value; });
    return el;
  }

  function bindNum(obj, key, opts) {
    opts = opts || {};
    var el = h('input', { type: 'number', class: 'num', value: obj[key] == null ? '' : obj[key], placeholder: opts.placeholder || '空', step: opts.step || 'any' });
    el.addEventListener('change', function () {
      var n = U.parseNumber(el.value, true);
      if (Number.isNaN(n)) {
        U.toast('请输入数字', 'warn');
        el.value = obj[key] == null ? '' : obj[key];
        return;
      }
      obj[key] = n;
      if (opts.after) opts.after();
    });
    return el;
  }

  function draftArea(key, rows, placeholder) {
    var el = h('textarea', { rows: rows || 3, placeholder: placeholder || '' });
    el.value = ui.drafts[key] || '';
    el.addEventListener('input', function () { ui.drafts[key] = el.value; });
    return el;
  }

  function itemOptions(includeBlank) {
    var opts = includeBlank ? [['', '选择物品…']] : [];
    C.CATEGORIES.forEach(function (cat) {
      C.allDefs(state.customItems).filter(function (d) { return d.category === cat.id; }).forEach(function (d) {
        opts.push([d.id, cat.name + ' · ' + d.name + '（占' + C.fmtUnits(d.capacityTicks) + '）']);
      });
    });
    return opts;
  }

  function chip(text, cls) {
    return h('span', { class: 'chip ' + (cls || '') }, text);
  }

  // ================================================================ 渲染：骨架

  function render() {
    renderBanner();
    renderTop();
    renderTabs();
    renderMain();
  }

  function renderBanner() {
    var el = U.clear(document.getElementById('banner'));
    if (slot === 'demo') {
      el.appendChild(h('div', { class: 'banner demo' },
        h('b', null, '演示存档'),
        h('span', null, '数据仅供演示，与正式存档完全分开，可随时清空。'),
        h('button', { type: 'button', class: 'btn small', onclick: exitDemo }, '返回正式存档'),
        h('button', { type: 'button', class: 'btn small danger', onclick: clearDemo }, '清空演示数据')));
    }
    notices.forEach(function (n, i) {
      el.appendChild(h('div', { class: 'banner ' + n.kind }, U.icon('warn'), h('span', { class: 'grow' }, n.text),
        h('button', { type: 'button', class: 'btn small ghost', onclick: function () { notices.splice(i, 1); render(); } }, '关闭')));
    });
    if (/\.vercel\.app$/.test(location.hostname)) {
      el.appendChild(h('div', { class: 'banner info' }, '你正在通过上游部署地址访问。正式入口是 www.xxxmnalx.com/game/shelter ——两个地址的存档互不相通。'));
    }
  }

  function stat(label, value, cls) {
    return h('div', { class: 'stat ' + (cls || '') }, h('span', { class: 'stat-label' }, label), h('span', { class: 'stat-value' }, value));
  }

  function isLastPhase() {
    var seq = C.phaseSequence(state.rules);
    return seq.indexOf(state.phase) === seq.length - 1;
  }

  function renderTop() {
    var top = U.clear(document.getElementById('topbar'));
    var pending = C.pendingConfigItems(state.rules);
    var alive = aliveIds().length;
    var last = undo.peek();
    var target = state.rules.rescueTarget;
    top.appendChild(h('div', { class: 'top-main' },
      h('div', { class: 'brand' }, h('b', null, '避难所 Playtest'), h('span', { class: 'brand-role' }, '主持人')),
      h('div', { class: 'top-stats' },
        stat('天数', state.started ? '第 ' + state.day + ' 天' : '未开始'),
        stat('阶段', C.phaseLabel(state.phase)),
        stat('存活', alive + ' / ' + state.players.length + ' 人'),
        stat('营救进度', state.rescueProgress + (target != null ? ' / ' + target : '（阈值待定）'), 'teal'),
        pending.length ? h('button', { type: 'button', class: 'cfg-chip', onclick: function () { setTab('settings'); } },
          U.icon('warn'), '配置未完成 ' + pending.length + ' 项') : null),
      h('div', { class: 'top-actions' },
        h('span', { class: 'top-group' },
          h('button', { type: 'button', class: 'btn', onclick: prevPhase, disabled: !state.started }, '← 回退'),
          h('button', { type: 'button', class: 'btn primary', onclick: nextPhase },
            !state.started ? '开始第 1 天 →' : isLastPhase() ? '进入第 ' + (state.day + 1) + ' 天 →' : '下一阶段 →')),
        h('span', { class: 'top-group' },
          h('button', { type: 'button', class: 'btn', onclick: undoLast, disabled: !last, title: last ? '撤销：' + last.label : '没有可撤销的操作' }, U.icon('undo'), '撤销'),
          h('button', { type: 'button', class: 'btn', onclick: manualAdjust }, '手动调整')),
        h('button', { type: 'button', class: 'btn danger', onclick: hideAllSecrets }, U.icon('eyeOff'), '一键隐藏所有秘密'))));
  }

  function renderTabs() {
    var nav = U.clear(document.getElementById('tabs'));
    var groups = { public: null, secret: null, setup: null };
    TABS.forEach(function (t) {
      if (!groups[t.group]) {
        groups[t.group] = h('div', { class: 'tab-group g-' + t.group, role: 'group', 'aria-label': t.group === 'secret' ? '秘密页（先暂停屏幕共享）' : t.group === 'public' ? '可以共享的页' : '设置' },
          t.group === 'secret' ? h('span', { class: 'tab-group-label' }, U.icon('lock'), '先暂停共享') : null);
        nav.appendChild(groups[t.group]);
      }
      groups[t.group].appendChild(h('button', {
        type: 'button',
        class: 'tab ' + (ui.tab === t.id ? 'on' : ''),
        'aria-current': ui.tab === t.id ? 'page' : null,
        'data-tab': t.id,
        onclick: function () { setTab(t.id); }
      }, t.secret ? U.icon('lock') : null, t.name));
    });
  }

  function renderMain() {
    var main = U.clear(document.getElementById('main'));
    var views = { stage: renderStage, flow: renderFlow, supply: renderSupply, watch: renderWatch, events: renderEvents, records: renderRecords, log: renderLog, settings: renderSettings };
    if (ui.present && ui.tab !== 'stage') exitPresent(true);
    main.className = 'main tab-' + ui.tab;
    main.appendChild((views[ui.tab] || renderStage)());
  }

  // ================================================================ 公开展示

  // 给 Discord 屏幕共享看的页面：最大的字是「现在是哪个阶段」，其次是「轮到谁」。
  // 版面固定为 主视区（随阶段切换：行动顺序／领取顺序／公共事件／座次）＋ 侧栏（计时、营救进度）＋ 下方补充。
  function renderStage() {
    var seq = C.phaseSequence(state.rules);
    var p = C.PHASES[state.phase] || {};
    var idx = seq.indexOf(state.phase);
    var focus = stageFocus();
    var more = [
      focus.kind !== 'event' ? stageEvent() : null,
      focus.kind !== 'supply' ? stageSupply() : null,
      h('div', { class: 'stage-panel feed-panel' }, h('h3', null, '公开结果'), feedList(true))
    ].filter(Boolean);
    return h('div', { class: 'stage' },
      h('section', { class: 'stage-hero', 'aria-label': '当前进度' },
        h('div', { class: 'hero-top' },
          h('span', { class: 'hero-day' }, state.started ? '第 ' + state.day + ' 天' : '尚未开始'),
          ui.present
            ? h('button', { type: 'button', class: 'btn small ghost present-btn', onclick: function () { exitPresent(); } }, U.icon('exitFull'), '退出展示（Esc）')
            : h('button', { type: 'button', class: 'btn small present-btn', onclick: enterPresent, title: '隐藏主持人工具栏，只留公开内容' }, U.icon('expand'), '全屏展示')),
        h('h1', { class: 'hero-phase' },
          p.no ? h('span', { class: 'hero-no' }, '阶段' + p.no) : null,
          h('span', null, p.name || state.phase)),
        p.desc ? h('p', { class: 'hero-desc' }, p.desc) : null,
        state.started && idx >= 0 ? stageTrack(seq, idx) : null),
      h('div', { class: 'stage-grid' },
        h('div', { class: 'stage-focus' }, focus.node,
          focus.kind !== 'seats' ? h('div', { class: 'stage-panel' }, h('h3', null, '座次'), seatChips(true)) : null),
        h('aside', { class: 'stage-side' }, timerWidget(true), stageRescue())),
      h('div', { class: 'stage-more' }, more));
  }

  /** 一天的阶段走到哪了：每段一条横杠，做完的实心、当前的加粗加高、未到的只有轨道。 */
  function stageTrack(seq, idx) {
    return h('ol', { class: 'track', 'aria-label': '今天的阶段' }, seq.map(function (ph, i) {
      var st = i < idx ? 'done' : i === idx ? 'on' : 'todo';
      var no = C.PHASES[ph].no ? String(C.PHASES[ph].no) : '事';
      return h('li', { class: 'track-seg ' + st, 'aria-current': st === 'on' ? 'step' : null },
        h('span', { class: 'track-bar' }),
        h('span', { class: 'track-label' }, st === 'done' ? '✓ ' : '', h('span', { class: 'track-no' }, no + ' '), h('span', { class: 'track-name' }, C.PHASES[ph].name)));
    }));
  }

  /** 主视区随阶段切换：个人行动看「轮到谁」，补给看领取顺序，事件看投票选项，其余看座次。 */
  function stageFocus() {
    var t = state.today;
    var ph = state.phase;
    if (ph === 'actions' && t.actionOrder) return { kind: 'actions', node: stageActionOrder() };
    var supply = stageSupply(true);
    if (ph === 'supply' && supply) return { kind: 'supply', node: supply };
    var ev = stageEvent();
    if (ev && (ph === 'event' || state.stage.event)) return { kind: 'event', node: ev };
    if (supply && openBatches().length) return { kind: 'supply', node: supply };
    return { kind: 'seats', node: h('div', { class: 'stage-panel focus' }, h('h3', null, '座次'), seatChips(true)) };
  }

  function seatChips(withMarks) {
    var t = state.today;
    var last = C.lastSeat(state.seatOrder);
    if (!state.seatOrder.length) return h('p', { class: 'empty' }, '还没有座次。请在「设置与存档」登记玩家。');
    return h('ol', { class: 'seat-list' }, state.seatOrder.map(function (id, i) {
      var marks = [];
      if (!isAlive(id)) marks.push(chip('已死亡', 'danger'));
      if (withMarks && state.phase === 'actions' && t.actionOrder) {
        if (t.actedIds.indexOf(id) >= 0) marks.push(chip('已行动 ✓', 'ok'));
        else if (C.nextActor(t.actionOrder, t.actedIds) === id) marks.push(chip('▶ 行动中', 'now'));
      }
      if (id === last) marks.push(chip('末位', ''));
      return h('li', { class: 'seat' + (isAlive(id) ? '' : ' dead') }, h('span', { class: 'seat-no' }, String(i + 1)), h('span', { class: 'seat-name' }, nameOf(id)), marks);
    }));
  }

  function stageActionOrder() {
    var t = state.today;
    var current = C.nextActor(t.actionOrder, t.actedIds);
    var acted = t.actedIds.length;
    return h('div', { class: 'stage-panel focus focus-actions' },
      h('h3', null, '个人行动'),
      h('div', { class: 'focus-now' },
        current ? h('span', { class: 'focus-label' }, '轮到') : null,
        h('span', { class: 'focus-name' }, current ? nameOf(current) : '本轮行动全部完成'),
        h('span', { class: 'focus-count' }, '已行动 ' + acted + '／' + t.actionOrder.length)),
      h('ol', { class: 'order-line' }, t.actionOrder.map(function (id) {
        var done = t.actedIds.indexOf(id) >= 0;
        return h('li', { class: 'order-item ' + (done ? 'done' : id === current ? 'now' : '') }, (done ? '✓ ' : id === current ? '▶ ' : '') + nameOf(id));
      })),
      h('p', { class: 'muted small' }, '本轮行动顺序固定；换位只改变实际座次，不改变这个顺序。'));
  }

  function openBatches() {
    return state.batches.filter(function (b) { return b.status === 'open'; });
  }

  function stageSupply(asFocus) {
    var list = openBatches();
    var showCount = state.stage.showPoolCount;
    if (!list.length && !showCount) return null;
    return h('div', { class: 'stage-panel' + (asFocus ? ' focus' : '') },
      h('h3', null, '补给领取'),
      list.map(function (b) {
        var next = b.pickOrder.filter(function (id) { return !b.picks.some(function (p) { return p.playerId === id; }); })[0];
        return h('div', { class: 'supply-batch' },
          asFocus && next ? h('div', { class: 'focus-now' }, h('span', { class: 'focus-label' }, '轮到'), h('span', { class: 'focus-name' }, nameOf(next)), h('span', { class: 'focus-count' }, b.label + ' · 已领取 ' + b.picks.length + '／' + b.pickOrder.length)) : h('b', null, b.label),
          h('ol', { class: 'order-line' }, b.pickOrder.map(function (id) {
            var picked = b.picks.some(function (p) { return p.playerId === id; });
            return h('li', { class: 'order-item ' + (picked ? 'done' : id === next ? 'now' : '') }, (picked ? '✓ ' : id === next ? '▶ ' : '') + nameOf(id));
          })));
      }),
      showCount ? h('p', null, '公共池剩余：', h('b', null, C.countPieces(state.pool) + ' 件')) : null);
  }

  function stageEvent() {
    var ev = state.stage.event;
    var check = state.today.eventCheck;
    if (!ev && !check) return null;
    return h('div', { class: 'stage-panel stage-event' },
      h('h3', null, '公共事件'),
      check && !ev ? h('p', { class: 'event-check' }, check.triggered ? '今日判定：触发事件，等待主持人公布' : '今日判定：无事件') : null,
      ev ? h('div', null,
        h('div', { class: 'event-title' }, ev.name, ev.location ? h('span', { class: 'event-loc' }, ev.location) : null),
        ev.body ? h('p', { class: 'event-body' }, ev.body) : null,
        ev.options && ev.options.length ? h('div', { class: 'vote-options' }, h('span', { class: 'muted' }, 'Discord 投票'), ev.options.map(function (o, i) {
          return h('span', { class: 'vote-option' }, h('b', null, String.fromCharCode(65 + i)), o);
        })) : null) : null);
  }

  function stageRescue() {
    var target = state.rules.rescueTarget;
    return h('div', { class: 'stage-panel rescue-panel' },
      h('h3', null, '营救进度'),
      h('div', { class: 'rescue-value' }, String(state.rescueProgress), target != null ? h('span', { class: 'rescue-of' }, '／' + target) : null),
      target != null ? U.meter(state.rescueProgress, target, 'ok', '营救进度') : null,
      h('p', { class: 'muted small' }, target != null ? '阈值 ' + target + '（到达后由主持人宣布结算）' : '阈值未知 · 军方热线：忙音'));
  }

  // ---------------------------------------------------------------- 全屏展示：隐藏主持人工具栏，只留公开展示页

  function enterPresent() {
    ui.present = true;
    ui.presentFs = false;
    document.body.classList.add('presenting');
    render();
    var el = document.documentElement;
    try {
      if (el.requestFullscreen) {
        var p = el.requestFullscreen();
        if (p && p.then) p.then(function () { ui.presentFs = true; }, function () {});
      }
    } catch (e) { /* 不支持全屏时只隐藏工具栏 */ }
  }

  function exitPresent(silent) {
    if (!ui.present) return;
    ui.present = false;
    document.body.classList.remove('presenting');
    try {
      if (document.fullscreenElement && document.exitFullscreen) document.exitFullscreen().catch(function () {});
    } catch (e) { /* 忽略 */ }
    ui.presentFs = false;
    if (!silent) render();
  }

  function feedList(todayFirst) {
    var items = state.publicFeed.slice().reverse();
    if (!items.length) return h('p', { class: 'empty' }, '暂无公开结果。');
    var kindNames = { night: '昨夜', event: '事件', watch: '守夜', note: '公告', settle: '结算', supply: '补给' };
    var shown = todayFirst ? items.slice(0, 8) : items;
    return h('ul', { class: 'feed' }, shown.map(function (f) {
      return h('li', { class: f.day === state.day ? 'today' : '' }, h('span', { class: 'feed-meta' }, '第' + f.day + '天 · ' + (kindNames[f.kind] || '公开')), h('span', { class: 'feed-text' }, f.text));
    }));
  }

  // ---------------------------------------------------------------- 计时器（截止时间计算）

  function timerRemaining() {
    var tm = state.timer;
    if (tm.running && tm.endsAt) return Math.max(0, tm.endsAt - Date.now());
    return Math.max(0, tm.remainingMs);
  }

  function timerWidget(big) {
    var tm = state.timer;
    var remaining = timerRemaining();
    var word = remaining <= 0 ? '时间到' : tm.running ? '计时中' : remaining < tm.durationMs ? '已暂停' : '未开始';
    return h('div', { class: 'timer ' + (big ? 'big' : 'compact') },
      h('div', { class: 'timer-head' }, h('span', { class: 'stage-label' }, U.icon('timer'), ' 计时'),
        h('span', { class: 'timer-state ' + (remaining <= 0 ? 'done' : tm.running ? 'run' : '') }, word)),
      h('div', { class: 'timer-display' + (remaining <= 0 ? ' done' : ''), id: 'timer-display' }, U.fmtClock(remaining)),
      h('div', { class: 'row tight' },
        tm.running
          ? h('button', { type: 'button', class: 'btn', onclick: timerPause }, '暂停')
          : h('button', { type: 'button', class: 'btn' + (big ? ' primary' : ''), onclick: timerStart, disabled: remaining <= 0 }, '开始'),
        h('button', { type: 'button', class: 'btn', onclick: timerReset }, '重置')),
      h('div', { class: 'row tight' }, [30, 60, 120, 180, 300].map(function (sec) {
        return h('button', { type: 'button', class: 'btn small', onclick: function () { timerSet(sec * 1000); } }, sec < 60 ? sec + '秒' : sec / 60 + '分');
      }), h('button', { type: 'button', class: 'btn small', onclick: timerCustom }, '自定义')));
  }

  function timerStart() {
    commit('计时开始', function (s) {
      var rem = s.timer.remainingMs > 0 ? s.timer.remainingMs : s.timer.durationMs;
      s.timer.endsAt = Date.now() + rem;
      s.timer.running = true;
    }, { undo: false });
  }

  function timerPause() {
    commit('计时暂停', function (s) {
      s.timer.remainingMs = Math.max(0, (s.timer.endsAt || Date.now()) - Date.now());
      s.timer.running = false;
      s.timer.endsAt = null;
    }, { undo: false });
  }

  function timerReset() {
    commit('计时重置', function (s) {
      s.timer.remainingMs = s.timer.durationMs;
      s.timer.running = false;
      s.timer.endsAt = null;
    }, { undo: false });
  }

  function timerSet(ms) {
    commit('设定计时', function (s) {
      s.timer.durationMs = ms;
      s.timer.remainingMs = ms;
      s.timer.running = false;
      s.timer.endsAt = null;
    }, { undo: false });
  }

  function timerCustom() {
    var input = h('input', { type: 'number', min: 1, value: Math.round(state.timer.durationMs / 1000), autofocus: true });
    U.modal({
      title: '自定义计时（秒）',
      body: U.field('秒数', input),
      actions: [{ label: '取消', value: null }, { label: '设定', kind: 'primary', value: function () { return parseInt(input.value, 10); } }]
    }).then(function (sec) {
      if (!sec) return;
      if (!(sec > 0)) { U.toast('请输入正整数秒数', 'warn'); return; }
      timerSet(sec * 1000);
    });
  }

  function timerTick() {
    var el = document.getElementById('timer-display');
    var tm = state.timer;
    if (tm.running && tm.endsAt && Date.now() >= tm.endsAt) {
      tm.running = false;
      tm.endsAt = null;
      tm.remainingMs = 0;
      save();
      render();
      U.toast('计时结束');
      return;
    }
    if (el) {
      var rem = timerRemaining();
      el.textContent = U.fmtClock(rem);
      el.classList.toggle('done', rem <= 0);
    }
  }

  // ================================================================ 主持台（流程与座次）

  // 主持台：主持人自己看的工作台（不含秘密，可以共享）。
  // 读法从上到下：今天走到哪（阶段轨）→ 现在要处理什么（当前阶段卡，主区）→ 还有什么没收尾（待办，侧栏顶部）。
  // 电脑上主区＋侧栏两列；平板与手机变成一列，按「待办 → 当前阶段 → 概况 → 其余」排序。
  function renderFlow() {
    return h('div', { class: 'console' },
      phaseRail(),
      h('div', { class: 'console-cols' },
        h('div', { class: 'console-main' }, currentPhaseCard(), seatsCard(), announceCard()),
        h('aside', { class: 'console-side', 'aria-label': '待办与概况' }, todoCard(), overviewTiles(), rescueCard(), timerCard(), guideCard())));
  }

  /** 阶段轨：整天的流程一行排开，做完的打勾，当前的高亮；点任一阶段可跳转。 */
  function phaseRail() {
    var seq = ['setup'].concat(C.phaseSequence(state.rules));
    var cur = seq.indexOf(state.phase);
    var pos = state.rules.eventPosition;
    return h('section', { class: 'rail-card' },
      h('ol', { class: 'rail', 'aria-label': '每日流程' }, seq.map(function (ph, i) {
        var st = cur < 0 ? 'todo' : i < cur ? 'done' : i === cur ? 'on' : 'todo';
        var no = ph === 'setup' ? '开' : C.PHASES[ph].no ? String(C.PHASES[ph].no) : '事';
        return h('li', { class: 'rail-step ' + st },
          h('button', {
            type: 'button',
            'aria-current': st === 'on' ? 'step' : null,
            'aria-label': C.PHASES[ph].name + (st === 'done' ? '（已过）' : st === 'on' ? '（当前）' : ''),
            onclick: function () { if (st !== 'on') jumpPhase(ph); }
          }, h('span', { class: 'rail-no' }, st === 'done' ? '✓' : no), h('span', { class: 'rail-name' }, C.PHASES[ph].name)));
      })),
      h('p', { class: 'rail-note' },
        h('span', null, '点阶段可直接跳转：只移动进度，记入日志，不回滚数据。'),
        h('span', null, pos ? '公共事件在' + (pos === 'beforeSupply' ? '阶段2之前' : '阶段6之后') : '公共事件位置未配置：手动触发')));
  }

  function guideCard() {
    return h('details', { class: 'card side-card guide' },
      h('summary', null, h('b', null, '主持人速查')),
      h('ol', null,
        h('li', null, '「主持台」和「公开展示」都没有秘密，可以直接屏幕共享；给玩家看时用公开展示的「全屏展示」。'),
        h('li', null, '带锁的页含秘密。打开前先暂停 Discord 共享；处理完点顶栏「一键隐藏所有秘密」再恢复共享。'),
        h('li', null, '主持人端不会把任何东西「发」给玩家：发放、事件后果、治疗都生成可复制的文本，由玩家在自己的页面手动修改。'),
        h('li', null, '「下一阶段／回退／手动调整」都会写进日志；顶栏的「撤销」可以回滚最近的操作。')));
  }

  /** 待办：从已记录的进度推出来的「还没收尾的事」，点右侧链接直接去处理。 */
  function todoCard() {
    var list = C.hostAlerts(state);
    return h('section', { class: 'card side-card todo' },
      h('div', { class: 'card-head' }, h('h2', null, '待办'),
        list.length ? h('span', { class: 'muted small' }, list.length + ' 项') : U.sevBadge('ok', '都处理完了')),
      list.length ? h('ul', { class: 'todo-list' }, list.map(function (a) {
        var t = TABS.filter(function (x) { return x.id === a.tab; })[0];
        return h('li', { class: 'todo-item lv-' + a.level },
          U.sevBadge(a.level),
          h('span', { class: 'todo-text' }, a.text),
          h('button', { type: 'button', class: 'btn-link todo-go', onclick: function () { goTodo(a); } },
            a.tab === 'flow' ? '去处理' : [t && t.secret ? U.icon('lock') : null, t ? t.name : '前往']));
      })) : h('p', { class: 'empty' }, '当前阶段没有未收尾的事项，可以进入下一阶段。'));
  }

  function goTodo(a) {
    if (a.tab !== 'flow') { setTab(a.tab); return; }
    var target = /座次/.test(a.text) ? document.getElementById('seats-card') : document.getElementById('phase-card');
    if (target) {
      target.scrollIntoView({ behavior: 'smooth', block: 'start' });
      target.classList.remove('flash');
      void target.offsetWidth;
      target.classList.add('flash');
    }
  }

  /** 概况：两张小卡，点了跳到对应页。数值都是公开信息。 */
  function overviewTiles() {
    var total = state.players.length;
    var alive = aliveIds().length;
    var dead = total - alive;
    var today = state.publicFeed.filter(function (f) { return f.day === state.day; });
    var latest = today[today.length - 1];
    return h('div', { class: 'tiles-2' },
      U.statTile({
        key: 'alive', label: '存活', value: String(alive), unit: '／' + total + ' 人',
        badge: dead ? U.sevBadge('info', '死亡 ' + dead) : null,
        viz: total ? U.meter(alive, total, 'ok', '存活人数') : null,
        sub: '座次 ' + state.seatOrder.length + ' 人',
        onclick: function () { setTab('settings'); }
      }),
      U.statTile({
        key: 'feed', label: state.started ? '今天的公开结果' : '公开结果', value: String(state.started ? today.length : state.publicFeed.length), unit: '条',
        sub: latest ? '最新：' + latest.text : '还没有发布',
        onclick: function () { setTab('stage'); }
      }));
  }

  function timerCard() {
    return h('section', { class: 'card side-card timer-card' }, timerWidget(false));
  }

  function jumpPhase(ph) {
    U.confirmBox('跳到「' + C.phaseLabel(ph) + '」？', '跳阶段只移动进度指针，不回滚任何数据，并会记入日志。需要回滚请用「撤销」。', '跳转').then(function (ok) {
      if (!ok) return;
      commit('跳转阶段', function (s) {
        var from = C.phaseLabel(s.phase);
        if (ph === 'setup') {
          s.started = false;
        } else if (!s.started) {
          s.started = true;
          if (s.day < 1) s.day = 1;
        }
        s.phase = ph;
        if (ph === 'actions') C.beginActions(s);
        log(s, '跳阶段：' + from + ' → ' + C.phaseLabel(ph));
      });
    });
  }

  function startGame() {
    if (!state.players.length) {
      U.toast('请先在「设置与存档」登记玩家', 'warn');
      setTab('settings');
      return;
    }
    var done = state.opening.done.filter(Boolean).length;
    var body = h('div', { class: 'stack' },
      h('p', null, '座次按当前顺序：' + names(state.seatOrder) + '。'),
      done < 2 ? h('div', { class: 'callout risk' }, '开局领取只完成了 ' + done + '／2 次（每名玩家先领取两次）。仍可开始，之后可在「补给与公共池」补做。') : null);
    U.modal({ title: '开始第 1 天？', body: body, actions: [{ label: '取消', value: false }, { label: '开始', kind: 'primary', value: true }] }).then(function (ok) {
      if (!ok) return;
      commit('开始游戏', function (s) {
        s.started = true;
        s.day = 1;
        s.phase = C.phaseSequence(s.rules)[0];
        s.today = C.newToday();
        log(s, '开始第 1 天');
      });
    });
  }

  function nextPhase() {
    if (!state.started) { startGame(); return; }
    var seq = C.phaseSequence(state.rules);
    var idx = seq.indexOf(state.phase);
    var t = state.today;
    var chain = Promise.resolve('go');

    if (state.phase === 'rotation' && !t.rotationDone) {
      chain = U.modal({
        title: '今日尚未轮换',
        body: h('p', null, '每日轮换发生在自由交流之后：当前末位移到首位，其余人后移。'),
        actions: [{ label: '取消', value: null }, { label: '不轮换，直接继续', value: 'skip' }, { label: '执行轮换并继续', value: 'rotate', kind: 'primary' }]
      });
    } else if (state.phase === 'actions' && t.actionOrder) {
      var left = t.actionOrder.filter(function (id) { return t.actedIds.indexOf(id) < 0 && isAlive(id); });
      if (left.length) chain = U.confirmBox('还有人未行动', '尚未行动：' + names(left) + '。仍要进入下一阶段吗？（会记入日志）', '继续').then(function (ok) { return ok ? 'go' : null; });
    } else if (state.phase === 'watch' && !t.finalWatch) {
      chain = U.confirmBox('今日守夜名单尚未确认', '仍要进入下一阶段吗？（会记入日志）', '继续').then(function (ok) { return ok ? 'go' : null; });
    } else if (state.phase === 'event' && !t.eventCheck) {
      chain = U.confirmBox('今日事件尚未判定', '仍要进入下一阶段吗？（会记入日志）', '继续').then(function (ok) { return ok ? 'go' : null; });
    }

    chain.then(function (decision) {
      if (!decision) return;
      if (idx === seq.length - 1) { newDay(decision); return; }
      commit('进入下一阶段', function (s) {
        var from = s.phase;
        if (decision === 'rotate') {
          C.applyRotation(s);
          log(s, '每日轮换：' + names(s.seatOrder));
        } else if (decision === 'skip') {
          log(s, '跳过每日轮换（主持人决定）');
        }
        if (from === 'actions' && s.today.actionOrder) {
          var notActed = s.today.actionOrder.filter(function (id) { return s.today.actedIds.indexOf(id) < 0 && isAlive(id); });
          if (notActed.length) log(s, '未行动即进入下一阶段：' + names(notActed));
        }
        s.phase = idx < 0 ? seq[0] : seq[idx + 1];
        if (s.phase === 'actions') {
          var r = C.beginActions(s);
          log(s, r.kept ? '个人行动：保留本轮已有的行动顺序' : '个人行动顺序（本轮固定）：' + names(s.today.actionOrder));
        }
        log(s, '阶段：' + C.phaseLabel(from) + ' → ' + C.phaseLabel(s.phase));
      });
    });
  }

  function newDay() {
    var open = openBatches().length;
    var body = h('div', { class: 'stack' },
      h('p', null, '今天的行动、计划者、技能使用者和守夜候选会归档并清空；昨夜结果草稿保留到次日阶段1公布。'),
      open ? h('div', { class: 'callout risk' }, '还有 ' + open + ' 个发放批次没有结束，它们会保留在「补给与公共池」中。') : null,
      state.today.finalWatch && !state.pendingNightResult ? h('div', { class: 'callout risk' }, '今晚的守夜结果还没有保存为草稿。') : null);
    U.modal({ title: '进入第 ' + (state.day + 1) + ' 天？', body: body, actions: [{ label: '取消', value: false }, { label: '进入下一天', kind: 'primary', value: true }] }).then(function (ok) {
      if (!ok) return;
      commit('进入下一天', function (s) {
        C.advanceDay(s);
        log(s, '进入第 ' + s.day + ' 天');
      });
    });
  }

  function prevPhase() {
    var seq = C.phaseSequence(state.rules);
    var idx = seq.indexOf(state.phase);
    if (idx !== 0) {
      commit('回退阶段', function (s) {
        var from = s.phase;
        // 当前阶段不在序列里（例如刚改了事件位置）时，回到当天的最后一个阶段
        s.phase = idx > 0 ? seq[idx - 1] : seq[seq.length - 1];
        log(s, '回退：' + C.phaseLabel(from) + ' → ' + C.phaseLabel(s.phase));
      });
      return;
    }
    var hasData = C.todayHasData(state.today);
    var keepNote = '已执行的发放批次与事件结算不会自动回滚（它们改动了公共池与营救进度）；需要时请先在对应页面撤销，或用顶栏「撤销」。';
    if (!state.history.length) {
      U.confirmBox('回到开局准备？', (hasData ? '第 1 天已记录的当日数据会被丢弃。' : '回到开局准备阶段。') + keepNote, '回退', hasData ? 'danger' : 'primary').then(function (ok) {
        if (!ok) return;
        commit('回到开局', function (s) {
          s.started = false;
          s.day = 0;
          s.phase = 'setup';
          s.today = C.newToday();
          s.publicFeed = s.publicFeed.filter(function (f) { return f.day !== 1; });
          log(s, '回退到开局准备');
        });
      });
      return;
    }
    var msg = (hasData ? '第 ' + state.day + ' 天已记录的数据（行动、名单、事件判定、公开结果等）将被丢弃。' : '') +
      '将恢复第 ' + (state.day - 1) + ' 天的当日记录与当天结束时的座次。' + keepNote;
    U.confirmBox('回退到第 ' + (state.day - 1) + ' 天？', msg, '回退', hasData ? 'danger' : 'primary').then(function (ok) {
      if (!ok) return;
      commit('跨日回退', function (s) {
        var from = s.day;
        C.retreatDay(s);
        log(s, '跨日回退：第' + from + '天 → 第' + s.day + '天 ' + C.phaseLabel(s.phase));
      });
    });
  }

  function manualAdjust() {
    var phases = ['setup'].concat(C.phaseSequence(state.rules));
    var dayInput = h('input', { type: 'number', min: 0, value: state.day });
    var phaseSel = U.select(phases.map(function (p) { return [p, C.phaseLabel(p)]; }), state.phase, function () {});
    U.modal({
      title: '手动调整进度',
      body: h('div', { class: 'stack' },
        h('p', { class: 'muted small' }, '只修改「第几天／哪个阶段」的指针，不回滚任何数据（需要回滚请用撤销），并会记入日志。'),
        h('div', { class: 'grid2' }, U.field('天数', dayInput), U.field('阶段', phaseSel))),
      actions: [{ label: '取消', value: false }, { label: '确定', kind: 'primary', value: true }]
    }).then(function (ok) {
      if (!ok) return;
      var day = parseInt(dayInput.value, 10);
      var phase = phaseSel.value;
      if (!C.isInt(day) || day < 0) { U.toast('天数无效', 'warn'); return; }
      commit('手动调整进度', function (s) {
        var from = '第' + s.day + '天 ' + C.phaseLabel(s.phase);
        s.phase = phase;
        s.started = phase !== 'setup';
        s.day = s.started && day < 1 ? 1 : day;
        if (phase === 'actions') C.beginActions(s);
        log(s, '手动调整：' + from + ' → 第' + s.day + '天 ' + C.phaseLabel(phase));
      });
    });
  }

  function currentPhaseCard() {
    var ph = state.phase;
    var body;
    if (ph === 'setup') body = setupPanel();
    else if (ph === 'night') body = nightPanel();
    else if (ph === 'supply') body = supplyPanel();
    else if (ph === 'exchange') body = exchangePanel();
    else if (ph === 'rotation') body = rotationPanel();
    else if (ph === 'actions') body = actionsPanel();
    else if (ph === 'watch') body = watchPanel();
    else if (ph === 'event') body = eventTriggerCard(true);
    else body = h('p', null, '未知阶段');
    var prog = phaseProgress();
    return h('section', { class: 'card current-phase', id: 'phase-card' },
      h('div', { class: 'phase-head' },
        h('div', { class: 'phase-title' },
          h('span', { class: 'phase-kicker' }, state.started ? '第 ' + state.day + ' 天' : '游戏开始前'),
          h('h2', null, C.phaseLabel(ph))),
        prog ? h('div', { class: 'phase-prog' },
          h('span', { class: 'phase-prog-text' }, prog.label),
          prog.max ? U.meter(prog.value, prog.max, 'ok', prog.label) : null) : null),
      h('p', { class: 'section-note' }, (C.PHASES[ph] || {}).desc || ''),
      body,
      phaseFoot());
  }

  /** 当前阶段的完成度（只在能数清楚的阶段显示）。 */
  function phaseProgress() {
    var t = state.today;
    var ph = state.phase;
    if (ph === 'setup') {
      var done = state.opening.done.filter(Boolean).length;
      return { value: done, max: 2, label: '开局领取 ' + done + '／2 次' };
    }
    if (ph === 'actions' && t.actionOrder) {
      return { value: t.actedIds.length, max: t.actionOrder.length, label: '已行动 ' + t.actedIds.length + '／' + t.actionOrder.length };
    }
    if (ph === 'supply') {
      var list = state.batches.filter(function (b) { return t.batchIds.indexOf(b.id) >= 0 || b.status === 'open'; });
      if (!list.length) return null;
      var picked = list.reduce(function (n, b) { return n + b.picks.length; }, 0);
      var all = list.reduce(function (n, b) { return n + b.pickOrder.length; }, 0);
      return { value: picked, max: all, label: '已领取 ' + picked + '／' + all };
    }
    if (ph === 'rotation') return { value: t.rotationDone ? 1 : 0, max: 0, label: t.rotationDone ? '✓ 今日已轮换' : '尚未轮换' };
    if (ph === 'watch') return { value: 0, max: 0, label: t.finalWatch ? '✓ 名单已确认' : '已收到 ' + C.submittedCandidates(t).length + ' 份提交' };
    if (ph === 'night') {
      var r = state.pendingNightResult;
      return { value: 0, max: 0, label: t.nightPublished ? '✓ 昨夜结果已公布' : r && r.publishedDay == null && state.day > r.day ? '昨夜结果待公布' : '没有待公布的结果' };
    }
    return null;
  }

  /** 卡片底部的「下一步」：和顶栏按钮是同一个动作，写明要去的阶段，免得来回看顶栏。 */
  function phaseFoot() {
    if (!state.started) return null;
    var seq = C.phaseSequence(state.rules);
    var idx = seq.indexOf(state.phase);
    var nextName = idx === seq.length - 1 ? null : C.PHASES[seq[idx + 1]].name;
    return h('div', { class: 'phase-foot' },
      h('span', { class: 'muted small' }, '这一阶段处理完后'),
      h('button', { type: 'button', class: 'btn', onclick: nextPhase },
        nextName ? '进入「' + nextName + '」' : '结束今天，进入第 ' + (state.day + 1) + ' 天', U.icon('arrow')));
  }

  function goSecret(tab, label) {
    return h('button', { type: 'button', class: 'btn', onclick: function () { setTab(tab); } }, U.icon('lock'), label || '前往');
  }

  function setupPanel() {
    var done = state.opening.done;
    return h('div', { class: 'stack' },
      h('ul', { class: 'checklist' },
        h('li', { class: state.players.length ? 'ok' : '' }, '登记玩家：' + state.players.length + ' 人（计划 ' + state.rules.playerCount + ' 人）'),
        h('li', { class: done[0] ? 'ok' : '' }, '开局领取第 1 次：' + (done[0] ? '已完成' : '未完成')),
        h('li', { class: done[1] ? 'ok' : '' }, '开局领取第 2 次：' + (done[1] ? '已完成' : '未完成'))),
      h('div', { class: 'row' },
        h('button', { type: 'button', class: 'btn', onclick: function () { setTab('settings'); } }, '登记玩家与规则'),
        goSecret('supply', '开局物资与领取（秘密）'),
        h('button', { type: 'button', class: 'btn primary', onclick: startGame }, '开始第 1 天')));
  }

  function nightPanel() {
    var r = state.pendingNightResult;
    var waiting = r && r.publishedDay == null;
    return h('div', { class: 'stack' },
      waiting
        ? h('div', { class: 'callout ok' }, '有一条待公布的守夜结果（第 ' + r.day + ' 天夜间）。内容可在「守夜」页预览（需先暂停共享）。')
        : h('p', { class: 'muted' }, state.today.nightPublished ? '昨夜结果已公布。' : '没有待公布的守夜结果（首日或昨夜未生成）：可以直接跳过。'),
      h('div', { class: 'row' },
        h('button', { type: 'button', class: 'btn primary', disabled: !waiting, onclick: publishNight }, '公布昨夜结果到公开页'),
        goSecret('watch', '预览守夜结果')),
      h('p', { class: 'muted small' }, '主持人确认状态与营救进度变化：营救进度在下方卡片修改；个人状态由玩家在自己的页面修改。'));
  }

  function publishNight() {
    commit('公布昨夜结果', function (s) {
      var r = s.pendingNightResult;
      if (!r || r.publishedDay != null) throw new Error('没有待公布的结果');
      publish(s, 'night', '第' + r.day + '天夜间：' + r.text, r.id);
      r.publishedDay = s.day;
      s.today.nightPublished = true;
      log(s, '公布昨夜结果（第' + r.day + '天夜间）');
    });
  }

  function supplyPanel() {
    var list = openBatches();
    return h('div', { class: 'stack' },
      list.length ? list.map(function (b) {
        return h('p', null, b.label + '：已领取 ' + b.picks.length + '／' + b.pickOrder.length + '（' + b.pickOrder.map(function (id) {
          return nameOf(id) + (b.picks.some(function (p) { return p.playerId === id; }) ? '✓' : '');
        }).join('、') + '）');
      }) : h('p', { class: 'muted' }, '今天还没有发放批次。'),
      h('div', { class: 'row' }, goSecret('supply', '去抽取与发放（秘密）')),
      h('p', { class: 'muted small' }, '按人数 N 从公共池实际物品中无放回抽 N 件；按座次秘密各选一件；玩家在自己的页面手动加入库存。'));
  }

  function exchangePanel() {
    return h('div', { class: 'stack' },
      h('p', null, '讨论、交易、赠予与预先协商换位都不收费；交易双方各自在玩家页增减库存。'),
      h('div', { class: 'row' }, h('span', { class: 'muted' }, '常用计时：'), [120, 180, 300].map(function (sec) {
        return h('button', { type: 'button', class: 'btn small', onclick: function () { timerSet(sec * 1000); timerStart(); } }, sec / 60 + ' 分钟并开始');
      })));
  }

  function rotationPanel() {
    var done = state.today.rotationDone;
    var preview = C.rotateSeats(state.seatOrder);
    return h('div', { class: 'stack' },
      done ? h('div', { class: 'callout ok' }, '今日已轮换。新座次：' + names(state.seatOrder)) :
        h('p', null, '轮换后座次将变为：' + names(preview)),
      h('button', {
        type: 'button', class: 'btn primary', disabled: done, onclick: function () {
          commit('每日轮换', function (s) {
            var r = C.applyRotation(s);
            if (!r.ok) throw new Error(r.reason);
            log(s, '每日轮换：' + names(s.seatOrder));
          });
        }
      }, done ? '今日已轮换' : '执行每日轮换'));
  }

  function actionText(a) {
    var map = { plan: '计划守夜名单', skill: '使用技能', other: '其他行动', pass: '放弃行动', swap: '换位请求' };
    return map[a.type] || a.type;
  }

  function actionsPanel() {
    var t = state.today;
    if (!t.actionOrder) {
      return h('div', { class: 'stack' },
        h('p', null, '尚未生成本轮行动顺序。'),
        h('button', {
          type: 'button', class: 'btn primary', onclick: function () {
            commit('生成行动顺序', function (s) {
              C.beginActions(s);
              log(s, '个人行动顺序（本轮固定）：' + names(s.today.actionOrder));
            });
          }
        }, '按当前座次生成行动顺序'));
    }
    var current = C.nextActor(t.actionOrder, t.actedIds);
    var acted = t.actedIds.length;
    return h('div', { class: 'stack' },
      h('p', { class: 'muted small' }, '行动顺序在进入阶段5时从座次复制，整轮固定；换位只改实际座次，不改这个顺序。'),
      h('div', { class: 'table-wrap' }, h('table', { class: 'tbl actions-tbl' },
        h('thead', null, h('tr', null, h('th', null, '#'), h('th', null, '玩家'), h('th', null, '状态'), h('th', null, '本轮记录'), h('th', null, '实际座次'), h('th', null, '操作'))),
        h('tbody', null, t.actionOrder.map(function (id, i) {
          var done = t.actedIds.indexOf(id) >= 0;
          var acts = t.actions.filter(function (a) { return a.playerId === id; });
          var seat = state.seatOrder.indexOf(id);
          var swaps = t.swapRequests.filter(function (r) { return r.fromId === id; }).length;
          return h('tr', { class: done ? 'done' : id === current ? 'current' : '', 'data-player': id },
            h('td', { class: 'c-no' }, String(i + 1)),
            h('td', { class: 'c-name' }, nameOf(id), !isAlive(id) ? chip('已死亡', 'danger') : null),
            h('td', { class: 'c-state' }, done ? '✓ 已行动' : id === current ? '▶ 当前' : '等待'),
            h('td', { class: 'c-rec' }, acts.length ? acts.map(actionText).join('、') : '—', swaps ? h('span', { class: 'muted small' }, '（换位请求 ' + swaps + '/' + state.rules.swapRequestLimit + '）') : null),
            h('td', { class: 'c-seat' }, seat >= 0 ? '第 ' + (seat + 1) + ' 座' : '不在座次'),
            h('td', { class: 'c-ops' }, h('div', { class: 'row tight' },
              done ? null : h('button', { type: 'button', class: 'btn small primary', onclick: function () { recordActionDialog(id); } }, '记录行动'),
              done ? null : h('button', { type: 'button', class: 'btn small', onclick: function () { swapDialog(id); } }, '换位请求'),
              done || acts.length ? h('button', { type: 'button', class: 'btn small', onclick: function () { undoActionFor(id); } }, '撤销行动') : null)));
        })))),
      swapLog());
  }

  function swapLog() {
    var list = state.today.swapRequests;
    if (!list.length) return null;
    return h('div', null, h('h3', null, '今日换位请求'), h('ul', { class: 'list-plain' }, list.map(function (r) {
      return h('li', null, nameOf(r.fromId) + ' → ' + nameOf(r.toId) + '：' + (r.accepted ? '同意，座次已交换' : '拒绝') +
        (r.ends ? '；行动结束' : '；行动未结束') + (r.targetPays ? '；被请求者也消耗行动' : '') + (r.override ? '（主持人覆盖次数上限）' : ''));
    })));
  }

  function recordActionDialog(pid) {
    var type = 'plan';
    var note = h('input', { type: 'text', placeholder: '可选；只写进秘密日志' });
    var segHost = h('div');
    function drawSeg() {
      U.clear(segHost).appendChild(U.segmented(ACTION_TYPES, type, function (v) { type = v; drawSeg(); }));
    }
    drawSeg();
    U.modal({
      title: '记录行动：' + nameOf(pid),
      body: h('div', { class: 'stack' },
        segHost,
        U.field('备注', note),
        h('p', { class: 'muted small' }, '「计划守夜名单」会立即为该玩家抽取两份候选（秘密保存，刷新不变），内容在「守夜」页查看。换位请走「换位请求」。')),
      actions: [{ label: '取消', value: false }, { label: '记录', kind: 'primary', value: true }]
    }).then(function (ok) {
      if (!ok) return;
      commit('记录行动', function (s) {
        var r = C.recordAction(s, pid, { type: type, note: note.value });
        if (!r.ok) throw new Error(r.reason);
        if (type === 'plan') drawCandidatesFor(s, pid);
        log(s, nameOf(pid) + '：' + actionText({ type: type }));
        if (note.value) log(s, nameOf(pid) + ' 行动备注：' + note.value, true);
      });
    });
  }

  function drawCandidatesFor(s, pid) {
    var options = C.drawWatchOptions(s.watchTemplates, aliveIds(s), Math.random, s.rules.watchSize);
    s.today.watchCandidates.push({ id: C.uid('wc'), plannerId: pid, day: s.day, options: options, chosenIndex: null, submittedAt: null, createdAt: Date.now() });
    log(s, '为 ' + nameOf(pid) + ' 抽取守夜候选：' + options.map(function (o, i) { return (i ? '②' : '①') + C.describeWatchOption(o, nameOf); }).join(' '), true);
  }

  function swapDialog(fromId) {
    var t = state.today;
    var used = t.swapRequests.filter(function (r) { return r.fromId === fromId; }).length;
    var limit = state.rules.swapRequestLimit;
    var targets = state.seatOrder.filter(function (id) { return id !== fromId && isAlive(id); });
    if (!targets.length) { U.toast('没有可以换位的对象', 'warn'); return; }
    var target = targets[0];
    var accepted = true;
    var targetPays = h('input', { type: 'checkbox' });
    var override = h('input', { type: 'checkbox' });
    var resHost = h('div');
    function drawRes() {
      U.clear(resHost).appendChild(U.segmented([[true, '对方同意'], [false, '对方拒绝']], accepted, function (v) { accepted = v; drawRes(); }));
    }
    drawRes();
    var atLimit = C.isInt(limit) && used >= limit;
    var body = h('div', { class: 'stack' },
      h('p', null, '已发起 ' + used + '／' + limit + ' 次。换位消耗一次行动、双方同意才生效、没有战斗；只改变实际座次，不改变本轮行动顺序。'),
      U.field('请求对象', U.select(targets.map(function (id) { return [id, nameOf(id) + '（第 ' + (state.seatOrder.indexOf(id) + 1) + ' 座）']; }), target, function (v) { target = v; })),
      U.field('结果', resHost),
      h('label', { class: 'check' }, targetPays, '被请求者也消耗行动（规则未定，默认不扣；勾选＝主持人裁定）'),
      atLimit ? h('label', { class: 'check risk-text' }, override, '已到次数上限：主持人覆盖') : null,
      h('div', { class: 'callout info' }, '失败后是否仍耗行动、成功后能否继续请求尚未确定——请选择本次请求后该玩家的行动是否结束。'));
    U.modal({
      title: '换位请求：' + nameOf(fromId),
      body: body,
      actions: [
        { label: '取消', value: null },
        { label: '记录，行动未结束', value: 'continue' },
        { label: '记录，行动结束', kind: 'primary', value: 'end' }
      ]
    }).then(function (choice) {
      if (!choice) return;
      commit('换位请求', function (s) {
        var r = C.requestSwap(s, { fromId: fromId, toId: target, accepted: accepted, ends: choice === 'end', targetPays: targetPays.checked, override: override.checked });
        if (!r.ok) throw new Error(r.reason);
        log(s, nameOf(fromId) + ' 请求与 ' + nameOf(target) + ' 换位：' + (accepted ? '同意，座次已交换 → ' + names(s.seatOrder) : '拒绝') +
          (choice === 'end' ? '；行动结束' : '；行动未结束') + (targetPays.checked ? '；被请求者也消耗行动' : '') + (override.checked ? '（覆盖次数上限）' : ''));
      });
    });
  }

  function undoActionFor(pid) {
    var t = state.today;
    var hasSwap = t.swapRequests.some(function (r) { return (r.fromId === pid || r.toId === pid) && r.accepted; });
    if (hasSwap) {
      U.modal({ title: '无法单独撤销', body: h('p', null, '该玩家今天参与了已生效的换位。为保证座次准确，请用顶栏的「撤销」逐步回滚，或在下方座次卡手动调整。') });
      return;
    }
    var planned = t.plannerIds.indexOf(pid) >= 0;
    U.confirmBox('撤销 ' + nameOf(pid) + ' 的行动？', planned ? '他已计划守夜名单：撤销会一并作废为他抽取的候选。' : '将清除本轮的行动标记。', '撤销行动', planned ? 'danger' : 'primary').then(function (ok) {
      if (!ok) return;
      commit('撤销行动', function (s) {
        C.undoAction(s, pid);
        s.today.swapRequests = s.today.swapRequests.filter(function (r) { return r.fromId !== pid; });
        log(s, '撤销 ' + nameOf(pid) + ' 的本轮行动');
      });
    });
  }

  function watchPanel() {
    var t = state.today;
    var submitted = C.submittedCandidates(t).length;
    var decider = C.lastSeat(seatedAlive());
    return h('div', { class: 'stack' },
      h('p', null, '今日计划者：' + names(t.plannerIds) + '。末位（按最新座次）：' + (decider ? nameOf(decider) : '—') + '。'),
      t.finalWatch ? h('div', { class: 'callout ok' }, '今日最终名单已确认' + (t.finalWatch.published ? '并已公开。' : '（未公开）。')) :
        h('p', { class: 'muted' }, '已收到 ' + submitted + ' 份提交。0 份：系统随机；1 份：直接成为最终名单；多份：末位从提交中选择。'),
      h('div', { class: 'row' }, goSecret('watch', '去确认守夜（秘密）')));
  }

  function seatsCard() {
    var notSeated = state.players.filter(function (p) { return state.seatOrder.indexOf(p.id) < 0; });
    return h('section', { class: 'card', id: 'seats-card' },
      h('div', { class: 'card-head' }, h('h2', null, '座次（实际座位）'), h('span', { class: 'muted small' }, '玩家用稳定 ID 识别，不用座位号当身份')),
      state.seatOrder.length ? h('ol', { class: 'seat-edit' }, state.seatOrder.map(function (id, i) {
        return h('li', null,
          h('span', { class: 'seat-no' }, String(i + 1)),
          h('span', { class: 'grow' }, nameOf(id), !isAlive(id) ? chip('已死亡', 'danger') : null, i === state.seatOrder.length - 1 ? chip('末位', '') : null),
          h('button', { type: 'button', class: 'btn small', disabled: i === 0, onclick: function () { moveSeat(id, -1); }, 'aria-label': '上移' }, '↑'),
          h('button', { type: 'button', class: 'btn small', disabled: i === state.seatOrder.length - 1, onclick: function () { moveSeat(id, 1); }, 'aria-label': '下移' }, '↓'),
          h('button', { type: 'button', class: 'btn small', onclick: function () { removeSeat(id); } }, '移出座次'));
      })) : h('p', { class: 'empty' }, '座次为空。'),
      notSeated.length ? h('div', { class: 'row' }, h('span', { class: 'muted' }, '不在座次：'), notSeated.map(function (p) {
        return h('button', { type: 'button', class: 'btn small', onclick: function () { addSeat(p.id); } }, '+ ' + p.name);
      })) : null,
      h('p', { class: 'muted small' }, '手动调整会记入日志。死亡后的领取人数、座次剔除、守夜人数都由主持人决定，不自动处理。'));
  }

  function moveSeat(id, delta) {
    commit('调整座次', function (s) {
      var i = s.seatOrder.indexOf(id);
      var j = i + delta;
      if (i < 0 || j < 0 || j >= s.seatOrder.length) return false;
      var tmp = s.seatOrder[j];
      s.seatOrder[j] = id;
      s.seatOrder[i] = tmp;
      log(s, '手动调整座次：' + names(s.seatOrder));
    });
  }

  function removeSeat(id) {
    commit('移出座次', function (s) {
      s.seatOrder = s.seatOrder.filter(function (x) { return x !== id; });
      log(s, nameOf(id) + ' 移出座次：' + names(s.seatOrder));
    });
  }

  function addSeat(id) {
    commit('加入座次', function (s) {
      s.seatOrder.push(id);
      log(s, nameOf(id) + ' 加入座次末尾：' + names(s.seatOrder));
    });
  }

  function rescueCard() {
    function change(v) {
      if (!C.isInt(v)) { U.toast('营救进度需为整数', 'warn'); return; }
      commit('修改营救进度', function (s) {
        var old = s.rescueProgress;
        if (old === v) return false;
        s.rescueProgress = v;
        log(s, '营救进度 ' + old + ' → ' + v);
      });
    }
    var target = state.rules.rescueTarget;
    var reached = target != null && state.rescueProgress >= target;
    return h('section', { class: 'card side-card rescue-card' },
      h('div', { class: 'card-head' }, h('h2', null, '营救进度'), reached ? U.sevBadge('warning', '已达阈值') : null),
      h('div', { class: 'rescue-row' },
        h('div', { class: 'rescue-big' }, String(state.rescueProgress), h('span', { class: 'rescue-of' }, target != null ? '／' + target : '阈值待定')),
        h('div', { class: 'row tight' },
          h('button', { type: 'button', class: 'btn icon-btn', 'aria-label': '营救进度减一', onclick: function () { change(state.rescueProgress - 1); } }, '−1'),
          h('button', { type: 'button', class: 'btn icon-btn', 'aria-label': '营救进度加一', onclick: function () { change(state.rescueProgress + 1); } }, '+1'),
          h('button', {
            type: 'button', class: 'btn small', onclick: function () {
              var input = h('input', { type: 'number', value: state.rescueProgress, autofocus: true });
              U.modal({ title: '设定营救进度', body: U.field('营救进度', input), actions: [{ label: '取消', value: null }, { label: '设定', kind: 'primary', value: function () { return input.value; } }] })
                .then(function (v) { if (v != null && v !== '') change(parseInt(v, 10)); });
            }
          }, '设为…'))),
      target != null ? U.meter(state.rescueProgress, target, 'ok', '营救进度') : null,
      h('p', { class: 'muted small' }, target == null ? '阈值未知：不会自动结束，主持人在「记录与结算」点击结算。' : '到达阈值也不会自动结束，由主持人点击结算。'));
  }

  function announceCard() {
    return h('section', { class: 'card announce-card' },
      h('div', { class: 'card-head' }, h('h2', null, '发布公开结果')),
      draftArea('announce', 3, '例如：第2天自由交流结束；B 与 D 达成交易。会显示在公开展示页。'),
      h('div', { class: 'row' }, h('button', {
        type: 'button', class: 'btn primary', onclick: function () {
          var text = (ui.drafts.announce || '').trim();
          if (!text) { U.toast('请先输入内容', 'warn'); return; }
          commit('发布公告', function (s) {
            publish(s, 'note', text);
            log(s, '发布公开结果：' + text);
          });
          ui.drafts.announce = '';
          render();
        }
      }, '发布到公开页')),
      todayFeedEditor());
  }

  function todayFeedEditor() {
    var list = state.publicFeed.filter(function (f) { return f.day === state.day; });
    if (!list.length) return null;
    return h('ul', { class: 'list-plain' }, list.map(function (f) {
      return h('li', { class: 'row between' }, h('span', { class: 'grow' }, f.text), h('button', {
        type: 'button', class: 'btn small', onclick: function () {
          commit('撤下公开结果', function (s) {
            s.publicFeed = s.publicFeed.filter(function (x) { return x.id !== f.id; });
            if (f.kind === 'watch' && s.today.finalWatch && s.today.finalWatch.id === f.refId) s.today.finalWatch.published = false;
            s.resolutions.forEach(function (r) { if (r.id === f.refId) r.public = false; });
            if (f.kind === 'night' && s.pendingNightResult && s.pendingNightResult.id === f.refId) {
              s.pendingNightResult.publishedDay = null;
              s.today.nightPublished = false;
            }
            log(s, '撤下公开结果：' + f.text);
          });
        }
      }, '撤下'));
    }));
  }

  // ================================================================ 补给与公共池（秘密）

  function renderSupply() {
    return gate('pool', '补给与公共池', function () {
      return h('div', { class: 'stack' }, poolCard(), batchCard(), openingCard(), poolTemplatesCard(), weightsCard());
    });
  }

  function poolCard() {
    var byCat = {};
    state.pool.forEach(function (e) {
      var cat = C.getDef(e.defId, state.customItems).category;
      (byCat[cat] = byCat[cat] || []).push(e);
    });
    var addSel = U.select(itemOptions(true), '', function () {});
    var addQty = h('input', { type: 'number', min: 1, value: 1, class: 'num' });
    return h('section', { class: 'card' },
      h('div', { class: 'card-head' },
        h('h2', null, '公共池'),
        h('span', { class: 'badge ok' }, '共 ' + C.countPieces(state.pool) + ' 件 · ' + C.fmtUnits(C.listTicks(state.pool, state.customItems, state.rules)) + ' 单位')),
      h('label', { class: 'check' }, h('input', {
        type: 'checkbox', checked: !!state.stage.showPoolCount, onchange: function (e) {
          var on = e.target.checked;
          commit('公开池总数开关', function (s) { s.stage.showPoolCount = on; log(s, on ? '公开页显示公共池总件数' : '公开页隐藏公共池总件数'); });
        }
      }), '在公开展示页显示公共池总件数（默认关闭，数量一并遮住）'),
      state.pool.length ? C.CATEGORIES.filter(function (c) { return byCat[c.id]; }).map(function (cat) {
        return h('div', { class: 'pool-cat' }, h('h4', null, cat.name), h('ul', { class: 'list-plain' }, byCat[cat.id].map(poolRow)));
      }) : h('p', { class: 'empty' }, '公共池是空的。首次开启不会自动生成任何开局物资。'),
      h('div', { class: 'row add-row' }, addSel, addQty, h('button', {
        type: 'button', class: 'btn primary', onclick: function () {
          var q = parseInt(addQty.value, 10);
          if (!addSel.value) { U.toast('请选择物品', 'warn'); return; }
          if (!(q > 0)) { U.toast('数量必须是正整数', 'warn'); return; }
          commit('加入公共池', function (s) {
            C.addItem(s.pool, addSel.value, q, { customItems: s.customItems, rules: s.rules });
            log(s, '公共池加入：' + defName(addSel.value) + '×' + q, true);
          });
        }
      }, '加入')),
      h('div', { class: 'stack' },
        U.field('批量录入（正数加入、负数取出）', draftArea('poolBatch', 2, '例如：面包×3，普通水+2，子弹-1')),
        h('div', { class: 'row' },
          h('button', { type: 'button', class: 'btn', onclick: applyPoolBatch }, '解析并执行'),
          h('button', { type: 'button', class: 'btn', onclick: saveBatchAsTemplate }, '存为模板'))));
  }

  function poolRow(e) {
    var def = C.getDef(e.defId, state.customItems);
    var stackable = C.isStackable(def);
    return h('li', { class: 'row between' },
      h('span', { class: 'grow' }, describe(e), def.unknown ? chip('未知物品', 'danger') : null),
      stackable ? h('div', { class: 'row tight' },
        h('button', { type: 'button', class: 'btn small', 'aria-label': '减少一件', onclick: function () { changePool(e.id, -1); } }, '−1'),
        h('button', { type: 'button', class: 'btn small', 'aria-label': '增加一件', onclick: function () { changePool(e.id, 1); } }, '+1'))
        : h('div', { class: 'row tight' },
          def.instance === 'uses' ? h('button', { type: 'button', class: 'btn small', onclick: function () { editInstance(e, 'uses'); } }, '改剩余次数') : null,
          def.instance === 'water' ? h('button', { type: 'button', class: 'btn small', onclick: function () { editInstance(e, 'water'); } }, '改储水') : null,
          def.instance === 'condition' || def.instance === 'notes' ? h('button', { type: 'button', class: 'btn small', onclick: function () { toggleCondition(e); } }, e.condition === 'damaged' ? '标记完好' : '标记破损') : null,
          h('button', { type: 'button', class: 'btn small', onclick: function () { changePool(e.id, -1); } }, '取出')));
  }

  function changePool(entryId, delta) {
    commit('调整公共池', function (s) {
      var e = C.findEntry(s.pool, entryId);
      if (!e) throw new Error('找不到该物品');
      if (delta > 0) {
        e.qty += delta;
        log(s, '公共池：' + defName(e.defId) + ' +' + delta, true);
      } else {
        C.removeQty(s.pool, entryId, -delta);
        log(s, '公共池：' + defName(e.defId) + ' ' + delta, true);
      }
    });
  }

  function editInstance(entry, field) {
    var def = C.getDef(entry.defId, state.customItems);
    var input = h('input', { type: 'number', min: 0, value: entry[field] || 0, autofocus: true });
    U.modal({
      title: '修改「' + def.name + '」' + (field === 'uses' ? '剩余次数' : '储水'),
      body: U.field(field === 'uses' ? '剩余次数' : '储水（0～' + (def.maxWater || 2) + '）', input),
      actions: [{ label: '取消', value: null }, { label: '保存', kind: 'primary', value: function () { return parseInt(input.value, 10); } }]
    }).then(function (v) {
      if (v == null) return;
      if (!C.isInt(v) || v < 0) { U.toast('请输入非负整数', 'warn'); return; }
      if (field === 'water' && v > (def.maxWater || 2)) { U.toast('最多储存 ' + (def.maxWater || 2) + ' 份', 'warn'); return; }
      if (field === 'uses' && v === 0) { U.toast('剩余0次的能量棒应当取出', 'warn'); return; }
      commit('修改实例', function (s) {
        var e = C.findEntry(s.pool, entry.id);
        e[field] = v;
        log(s, '公共池实例：' + describe(e), true);
      });
    });
  }

  function toggleCondition(entry) {
    commit('标记物品状态', function (s) {
      var e = C.findEntry(s.pool, entry.id);
      e.condition = e.condition === 'damaged' ? 'intact' : 'damaged';
      log(s, '公共池实例：' + describe(e), true);
    });
  }

  function applyPoolBatch() {
    var text = ui.drafts.poolBatch || '';
    var parsed = C.parseItemList(text, state.customItems);
    if (parsed.errors.length) { U.modal({ title: '无法解析', body: h('ul', null, parsed.errors.map(function (e) { return h('li', null, e); })) }); return; }
    if (!parsed.items.length) { U.toast('没有内容', 'warn'); return; }
    var shortages = C.poolShortages(state.pool, parsed.items);
    if (shortages.length) {
      U.modal({ title: '公共池不足', body: h('p', null, '不能扣成负数：' + shortages.map(function (s) { return defName(s.defId) + ' 需要 ' + s.need + '、现有 ' + s.have; }).join('；')) });
      return;
    }
    commit('批量录入公共池', function (s) {
      C.applyPoolDelta(s.pool, parsed.items, { customItems: s.customItems, rules: s.rules });
      log(s, '公共池批量：' + C.formatItemList(parsed.items, s.customItems, true), true);
    });
    ui.drafts.poolBatch = '';
    render();
  }

  function saveBatchAsTemplate() {
    var text = (ui.drafts.poolBatch || '').trim();
    var parsed = C.parseItemList(text, state.customItems);
    if (!text || parsed.errors.length || !parsed.items.length) { U.toast('请先在批量录入框写好可解析的物品清单', 'warn'); return; }
    var nameInput = h('input', { type: 'text', placeholder: '例如：每日补给', autofocus: true });
    U.modal({ title: '保存为公共池模板', body: U.field('模板名称', nameInput), actions: [{ label: '取消', value: null }, { label: '保存', kind: 'primary', value: function () { return nameInput.value.trim(); } }] })
      .then(function (name) {
        if (!name) return;
        commit('保存池模板', function (s) {
          s.poolTemplates.push({ id: C.uid('tpl'), name: name, text: text, isDemo: false });
          log(s, '保存公共池模板：' + name, true);
        });
      });
  }

  function poolTemplatesCard() {
    return h('section', { class: 'card' },
      h('div', { class: 'card-head' }, h('h2', null, '公共池模板')),
      state.poolTemplates.length ? h('ul', { class: 'list-plain' }, state.poolTemplates.map(function (t) {
        return h('li', { class: 'row between' },
          h('span', { class: 'grow' }, h('b', null, t.name), t.isDemo ? chip('演示', 'demo') : null, h('span', { class: 'muted small' }, ' ' + t.text)),
          h('button', {
            type: 'button', class: 'btn small primary', onclick: function () {
              var parsed = C.parseItemList(t.text, state.customItems);
              if (parsed.errors.length) { U.toast(parsed.errors[0], 'warn'); return; }
              var shortages = C.poolShortages(state.pool, parsed.items);
              if (shortages.length) { U.toast('公共池不足，模板里的扣除无法执行', 'warn'); return; }
              commit('套用池模板', function (s) {
                C.applyPoolDelta(s.pool, parsed.items, { customItems: s.customItems, rules: s.rules });
                log(s, '套用公共池模板「' + t.name + '」：' + C.formatItemList(parsed.items, s.customItems, true), true);
              });
            }
          }, '加入公共池'),
          h('button', {
            type: 'button', class: 'btn small', onclick: function () {
              commit('删除池模板', function (s) {
                s.poolTemplates = s.poolTemplates.filter(function (x) { return x.id !== t.id; });
                log(s, '删除公共池模板：' + t.name, true);
              });
            }
          }, '删除'));
      })) : h('p', { class: 'empty' }, '还没有模板。在上方批量录入框写好清单后点「存为模板」。'));
  }

  function weightsCard() {
    var defIds = [];
    state.pool.forEach(function (e) { if (defIds.indexOf(e.defId) < 0) defIds.push(e.defId); });
    return h('details', { class: 'card' },
      h('summary', null, h('b', null, '抽取权重'), ' ', U.ruleBadge('impl'), h('span', { class: 'muted small' }, ' 默认每件等概率，可改权重')),
      defIds.length ? h('div', { class: 'weights' }, defIds.map(function (id) {
        var w = state.drawWeights[id];
        var input = h('input', { type: 'number', min: 0, step: 'any', class: 'num', value: w == null ? 1 : w });
        input.addEventListener('change', function () {
          var n = U.parseNumber(input.value, true);
          if (n == null || Number.isNaN(n) || n < 0) { U.toast('权重需为非负数字', 'warn'); input.value = w == null ? 1 : w; return; }
          commit('修改抽取权重', function (s) {
            if (n === 1) delete s.drawWeights[id];
            else s.drawWeights[id] = n;
            log(s, '抽取权重：' + defName(id) + ' = ' + n, true);
          });
        });
        return h('label', { class: 'weight' }, defName(id), input);
      })) : h('p', { class: 'empty' }, '公共池为空。'));
  }

  // ---------------------------------------------------------------- 发放批次

  function batchCard() {
    var list = openBatches();
    var closed = state.batches.filter(function (b) { return b.status !== 'open'; }).slice(-8).reverse();
    return h('section', { class: 'card' },
      h('div', { class: 'card-head' }, h('h2', null, '补给发放'), h('span', { class: 'muted small' }, '按件数无放回抽取；随机抽取与公布结果分开，刷新不会重抽')),
      list.length ? list.map(batchView) : null,
      newBatchForm(),
      closed.length ? h('details', null, h('summary', null, '已结束的批次（' + closed.length + '）'), h('ul', { class: 'list-plain' }, closed.map(function (b) {
        return h('li', null, h('b', null, b.label), (b.day ? ' · 第' + b.day + '天' : '') + ' · ' + (b.status === 'undone' ? '已撤销' : '已结束') + ' · ' +
          b.picks.map(function (p) { return nameOf(p.playerId) + '：' + describe(p.piece); }).join('；'));
      }))) : null);
  }

  function newBatchForm() {
    var seated = seatedAlive();
    var chosen = {};
    seated.forEach(function (id) { chosen[id] = true; });
    var kind = 'daily';
    var countLine = h('span', { class: 'muted' });
    function updateCount() {
      var n = Object.keys(chosen).filter(function (k) { return chosen[k]; }).length;
      countLine.textContent = '将抽取 ' + n + ' 件（按件数，不是单位）。公共池现有 ' + C.countPieces(state.pool) + ' 件。';
    }
    updateCount();
    var kindSel = U.select([['daily', '每日补给'], ['opening1', '开局领取第1次'], ['opening2', '开局领取第2次'], ['other', '其他发放']], kind, function (v) { kind = v; });
    return h('div', { class: 'card inset' },
      h('h3', null, '新建发放批次'),
      h('div', { class: 'row' }, U.field('类型', kindSel)),
      h('div', { class: 'row' }, h('span', { class: 'muted' }, '参与领取：'), state.players.map(function (p) {
        var box = h('input', { type: 'checkbox', checked: !!chosen[p.id], onchange: function () { chosen[p.id] = box.checked; updateCount(); } });
        return h('label', { class: 'check' }, box, p.name, p.alive === false ? '（已死亡）' : '');
      })),
      h('div', { class: 'row' }, countLine, h('button', {
        type: 'button', class: 'btn primary', onclick: function () {
          var ids = state.seatOrder.filter(function (id) { return chosen[id]; });
          state.players.forEach(function (p) { if (chosen[p.id] && ids.indexOf(p.id) < 0) ids.push(p.id); });
          createBatch(kind, ids);
        }
      }, '抽取')));
  }

  function batchLabel(kind) {
    return { daily: '每日补给', opening1: '开局领取第1次', opening2: '开局领取第2次', other: '其他发放' }[kind] || '发放';
  }

  function createBatch(kind, ids, count) {
    if (!ids.length) { U.toast('请至少选择一名领取者', 'warn'); return; }
    var n = C.isInt(count) ? count : ids.length;
    var available = C.countPieces(state.pool);
    if (available < n) {
      U.modal({
        title: '公共池不足',
        body: h('div', { class: 'stack' },
          h('p', null, '公共池只有 ' + available + ' 件，不足 ' + n + ' 件。系统不会生成不存在的物资。'),
          h('p', null, '请先补充公共池，或由主持人裁定只抽现有的 ' + available + ' 件。')),
        actions: [{ label: '取消', value: null }, { label: '只抽 ' + available + ' 件（主持人裁定）', value: 'partial', kind: 'risk' }]
      }).then(function (v) {
        if (v === 'partial' && available > 0) createBatch(kind, ids, available);
      });
      return;
    }
    commit('抽取补给', function (s) {
      var res = C.createBatch(s.pool, {
        participantIds: ids, seatOrder: s.seatOrder, count: n, weights: s.drawWeights, kind: kind,
        label: batchLabel(kind), day: s.started ? s.day : 0, customItems: s.customItems
      });
      if (!res.ok) throw new Error(res.reason);
      s.batches.push(res.batch);
      s.today.batchIds.push(res.batch.id);
      log(s, res.batch.label + '：抽取 ' + res.batch.items.length + ' 件 → ' + res.batch.items.map(describe).join('、'), true);
      log(s, res.batch.label + '：已抽取，按座次领取（' + names(res.batch.pickOrder) + '）');
    });
  }

  function batchView(b) {
    var next = null;
    for (var i = 0; i < b.pickOrder.length; i++) {
      var pid = b.pickOrder[i];
      if (!b.picks.some(function (p) { return p.playerId === pid; })) { next = pid; break; }
    }
    var dayText = b.day ? '第' + b.day + '天' : '开局';
    var dm = next ? '【补给·' + dayText + '】' + nameOf(next) + '：轮到你选。可选：' + b.items.map(function (p, i) { return (i + 1) + '. ' + describe(p); }).join('；') + '。请私信回复编号。' : '';
    return h('div', { class: 'card inset batch' },
      h('div', { class: 'row between' }, h('h3', null, b.label + ' · ' + dayText), h('span', { class: 'badge' }, '已领 ' + b.picks.length + '／' + b.pickOrder.length)),
      h('p', null, h('b', null, '剩余候选：'), b.items.length ? b.items.map(function (p, i) { return (i + 1) + '. ' + describe(p); }).join('　') : '（已全部选完）'),
      h('div', { class: 'table-wrap' }, h('table', { class: 'tbl' },
        h('thead', null, h('tr', null, h('th', null, '顺序'), h('th', null, '玩家'), h('th', null, '选择'), h('th', null, '操作'))),
        h('tbody', null, b.pickOrder.map(function (pid, i) {
          var picked = b.picks.find(function (p) { return p.playerId === pid; });
          if (picked) {
            return h('tr', { class: 'done', 'data-picker': pid }, h('td', null, String(i + 1)), h('td', null, nameOf(pid)), h('td', null, '已选：' + describe(picked.piece)),
              h('td', null, h('div', { class: 'row tight' },
                h('button', { type: 'button', class: 'btn small', onclick: function () { showHandoff(handoffForPick(b, picked)); } }, '交接文本'),
                h('button', { type: 'button', class: 'btn small', onclick: function () { unpick(b.id, pid); } }, '撤回'))));
          }
          var sel = U.select(b.items.map(function (p, k) { return [p.id, (k + 1) + '. ' + describe(p)]; }), b.items[0] ? b.items[0].id : '', function () {});
          return h('tr', { class: pid === next ? 'current' : '', 'data-picker': pid }, h('td', null, String(i + 1)), h('td', null, nameOf(pid), pid === next ? ' ▶' : ''),
            h('td', null, b.items.length ? sel : '无可选物品'),
            h('td', null, h('button', { type: 'button', class: 'btn small primary', disabled: !b.items.length, onclick: function () { pick(b.id, pid, sel.value); } }, '记录选择')));
        })))),
      next ? h('details', null, h('summary', null, '给 ' + nameOf(next) + ' 的私信文本'), U.copyBlock(dm, { note: '暂停共享后私发' })) : null,
      h('div', { class: 'row' },
        h('button', { type: 'button', class: 'btn', onclick: function () { closeBatch(b.id); } }, '结束批次（未选的放回公共池）'),
        h('button', { type: 'button', class: 'btn danger', onclick: function () { undoBatch(b.id); } }, '撤销整个批次')));
  }

  function handoffForPick(b, pick) {
    return '【补给交接·' + (b.day ? '第' + b.day + '天' : '开局') + '】' + nameOf(pick.playerId) + '：请在玩家页「库存」手动添加「' + describe(pick.piece) + '」。主持人端不会自动发送到你的页面。';
  }

  function showHandoff(text, title) {
    U.modal({ title: title || '交接文本（需对方手动修改）', body: U.copyBlock(text, { note: '复制后私信对方' }) });
  }

  function findBatch(s, id) {
    return s.batches.find(function (b) { return b.id === id; });
  }

  function pick(batchId, pid, pieceId) {
    var text = '';
    var ok = commit('记录选择', function (s) {
      var b = findBatch(s, batchId);
      var r = C.pickFromBatch(b, pid, pieceId);
      if (!r.ok) throw new Error(r.reason);
      log(s, b.label + '：' + nameOf(pid) + ' 选择 ' + describe(r.pick.piece), true);
      log(s, b.label + '：' + nameOf(pid) + ' 已领取');
      text = handoffForPick(b, r.pick);
      if (!b.items.length && b.picks.length === b.pickOrder.length) markOpeningDone(s, b);
    });
    if (ok) showHandoff(text);
  }

  function unpick(batchId, pid) {
    commit('撤回选择', function (s) {
      var b = findBatch(s, batchId);
      var r = C.unpickFromBatch(b, pid);
      if (!r.ok) throw new Error(r.reason);
      log(s, b.label + '：撤回 ' + nameOf(pid) + ' 的选择（' + describe(r.pick.piece) + '）', true);
      log(s, b.label + '：撤回 ' + nameOf(pid) + ' 的选择');
    });
    U.toast('已撤回。若玩家已经把物品加进库存，请提醒其手动删除。');
  }

  function markOpeningDone(s, b) {
    if (b.kind === 'opening1') s.opening.done[0] = true;
    if (b.kind === 'opening2') s.opening.done[1] = true;
  }

  function closeBatch(batchId) {
    commit('结束批次', function (s) {
      var b = findBatch(s, batchId);
      var left = b.items.map(describe);
      var r = C.closeBatch(s.pool, b, s.customItems);
      if (!r.ok) throw new Error(r.reason);
      markOpeningDone(s, b);
      log(s, b.label + '：结束，' + r.returned + ' 件放回公共池' + (left.length ? '（' + left.join('、') + '）' : ''), true);
      log(s, b.label + '：结束');
    });
  }

  function undoBatch(batchId) {
    U.confirmBox('撤销整个批次？', '抽到的物品（含已被领取的）会全部原样归还公共池。已领取的玩家需要在自己的页面手动删除——系统不会替玩家改库存。', '撤销批次', 'danger').then(function (ok) {
      if (!ok) return;
      var takers = [];
      var label = '';
      var done = commit('撤销发放批次', function (s) {
        var b = findBatch(s, batchId);
        label = b.label;
        var r = C.undoBatch(s.pool, b, s.customItems);
        if (!r.ok) throw new Error(r.reason);
        takers = r.takers;
        if (b.kind === 'opening1') s.opening.done[0] = false;
        if (b.kind === 'opening2') s.opening.done[1] = false;
        log(s, b.label + '：整批撤销，物品已归还公共池' + (takers.length ? '；需手动撤销：' + takers.map(function (t) { return nameOf(t.playerId) + '（' + describe(t.piece) + '）'; }).join('、') : ''), true);
        log(s, b.label + '：整批撤销');
      });
      if (done && takers.length) {
        var text = '【发放撤销】' + label + '已撤销。以下玩家请在玩家页手动删除领到的物品：' + takers.map(function (t) { return nameOf(t.playerId) + '（' + describe(t.piece) + '）'; }).join('；') + '。';
        showHandoff(text, '需要提醒已领取者手动撤销');
      }
    });
  }

  // ---------------------------------------------------------------- 开局

  function openingCard() {
    var op = state.opening;
    var text = ui.drafts.opening != null ? ui.drafts.opening : C.formatItemList(op.items, state.customItems);
    if (ui.drafts.opening == null) ui.drafts.opening = text;
    return h('section', { class: 'card' },
      h('div', { class: 'card-head' }, h('h2', null, '开局物资'), h('span', { class: 'muted small' }, '主持人自行设计；每名玩家先领取两次')),
      h('p', { class: 'section-note' }, '不会自动设定食物、水、武器配比，也不会自动添加任何默认套装。'),
      U.field('开局模板（物品清单）', draftArea('opening', 2, '例如：面包×6，普通水×6，绷带×2')),
      op.note ? h('p', { class: 'muted small' }, op.note) : null,
      h('div', { class: 'row' },
        h('button', { type: 'button', class: 'btn', onclick: saveOpeningTemplate }, '保存开局模板'),
        h('button', { type: 'button', class: 'btn', onclick: openingToPool }, '把开局模板加入公共池')),
      h('div', { class: 'grid2' }, [0, 1].map(function (i) {
        var done = op.done[i];
        return h('div', { class: 'card inset' },
          h('h3', null, '开局领取第 ' + (i + 1) + ' 次 ', done ? chip('已完成', 'ok') : chip('未完成', '')),
          h('div', { class: 'row' },
            h('button', { type: 'button', class: 'btn small primary', onclick: function () { createBatch(i ? 'opening2' : 'opening1', seatedAlive()); } }, '公共池方式：抽取'),
            h('button', { type: 'button', class: 'btn small', onclick: function () { fixedAssignDialog(i); } }, '固定指定…'),
            h('button', {
              type: 'button', class: 'btn small', onclick: function () {
                commit('标记开局领取', function (s) {
                  s.opening.done[i] = !s.opening.done[i];
                  log(s, '开局领取第' + (i + 1) + '次：' + (s.opening.done[i] ? '标记完成' : '取消完成标记'));
                });
              }
            }, done ? '取消完成标记' : '标记完成')));
      })));
  }

  function saveOpeningTemplate() {
    var parsed = C.parseItemList(ui.drafts.opening || '', state.customItems);
    if (parsed.errors.length) { U.toast(parsed.errors[0], 'warn'); return; }
    if (parsed.items.some(function (i) { return i.qty < 0; })) { U.toast('开局模板不能有负数', 'warn'); return; }
    commit('保存开局模板', function (s) {
      s.opening.items = parsed.items;
      log(s, '保存开局模板：' + C.formatItemList(parsed.items, s.customItems), true);
    });
  }

  function openingToPool() {
    var parsed = C.parseItemList(ui.drafts.opening || '', state.customItems);
    if (parsed.errors.length || !parsed.items.length) { U.toast(parsed.errors[0] || '开局模板是空的', 'warn'); return; }
    if (parsed.items.some(function (i) { return i.qty < 0; })) { U.toast('开局模板不能有负数', 'warn'); return; }
    commit('开局模板加入公共池', function (s) {
      s.opening.items = parsed.items;
      C.applyPoolDelta(s.pool, parsed.items, { customItems: s.customItems, rules: s.rules });
      log(s, '开局模板加入公共池：' + C.formatItemList(parsed.items, s.customItems), true);
    });
  }

  function fixedAssignDialog(index) {
    var inputs = {};
    var body = h('div', { class: 'stack' },
      h('p', { class: 'muted small' }, '为每位玩家直接指定物品（不经过公共池）。会生成每人的交接文本，玩家手动加入库存。'),
      seatedAlive().map(function (id) {
        inputs[id] = h('input', { type: 'text', placeholder: '例如：面包，普通水' });
        return U.field(nameOf(id), inputs[id]);
      }));
    U.modal({ title: '开局领取第 ' + (index + 1) + ' 次：固定指定', body: body, wide: true, actions: [{ label: '取消', value: false }, { label: '生成交接文本', kind: 'primary', value: true }] }).then(function (ok) {
      if (!ok) return;
      var lines = [];
      var errors = [];
      Object.keys(inputs).forEach(function (id) {
        var parsed = C.parseItemList(inputs[id].value, state.customItems);
        if (parsed.errors.length) errors.push(nameOf(id) + '：' + parsed.errors[0]);
        else if (parsed.items.some(function (it) { return it.qty < 0; })) errors.push(nameOf(id) + '：不能有负数');
        else if (parsed.items.length) lines.push(nameOf(id) + '：请在玩家页「库存」手动添加 ' + C.formatItemList(parsed.items, state.customItems));
      });
      if (errors.length) { U.modal({ title: '无法解析', body: h('ul', null, errors.map(function (e) { return h('li', null, e); })) }); return; }
      if (!lines.length) { U.toast('没有填写任何物品', 'warn'); return; }
      var text = '【开局领取第' + (index + 1) + '次·固定指定】\n' + lines.join('\n') + '\n（主持人端不会自动发送，请各自手动添加。）';
      commit('开局固定指定', function (s) {
        s.opening.done[index] = true;
        log(s, '开局领取第' + (index + 1) + '次（固定指定）：' + lines.join('；'), true);
        log(s, '开局领取第' + (index + 1) + '次完成（固定指定）');
      });
      showHandoff(text, '开局交接文本');
    });
  }

  // ================================================================ 守夜（秘密）

  function renderWatch() {
    return gate('watch', '守夜（候选、名单与夜间结果）', function () {
      return h('div', { class: 'stack' }, candidatesCard(), finalCard(), nightCard(), watchTemplatesCard(), nightLibraryCard());
    });
  }

  function candidatesCard() {
    var t = state.today;
    var planners = t.plannerIds;
    return h('section', { class: 'card' },
      h('div', { class: 'card-head' }, h('h2', null, '今日计划者与候选'), h('span', { class: 'muted small' }, '只统计真正消耗行动计划的人')),
      planners.length ? null : h('p', { class: 'empty' }, '今天还没有人计划守夜名单。在「主持台」记录行动时选择「计划守夜名单」。'),
      planners.map(function (pid) {
        var cand = t.watchCandidates.find(function (c) { return c.plannerId === pid; });
        if (!cand) {
          return h('div', { class: 'card inset' }, h('b', null, nameOf(pid)), h('p', { class: 'muted' }, '没有候选（可能当时没有启用的名单模板）。'),
            h('button', { type: 'button', class: 'btn small', onclick: function () { commit('抽取守夜候选', function (s) { drawCandidatesFor(s, pid); }); } }, '抽取候选'));
        }
        var dm = '【守夜候选·第' + state.day + '天】' + nameOf(pid) + '：' + cand.options.map(function (o, i) { return (i ? '②' : '①') + C.describeWatchOption(o, nameOf); }).join('；') + '。请私信回复 ① 或 ②。';
        return h('div', { class: 'card inset', 'data-planner': pid },
          h('div', { class: 'row between' }, h('b', null, nameOf(pid)), C.isInt(cand.chosenIndex) ? chip('已提交：' + (cand.chosenIndex ? '②' : '①'), 'ok') : chip('等待回复', '')),
          cand.options.length < 2 ? h('div', { class: 'callout risk' }, '启用的名单模板不足两份，只抽到 ' + cand.options.length + ' 份。') : null,
          h('ol', { class: 'cands' }, cand.options.map(function (o) { return h('li', null, C.describeWatchOption(o, nameOf)); })),
          h('details', null, h('summary', null, '私信文本'), U.copyBlock(dm, { note: '暂停共享后私发' })),
          h('div', { class: 'row' },
            cand.options.map(function (o, i) {
              return h('button', { type: 'button', class: 'btn small ' + (cand.chosenIndex === i ? 'primary' : ''), disabled: !!t.finalWatch, onclick: function () { submitCandidate(cand.id, i); } }, '提交' + (i ? '②' : '①'));
            }),
            C.isInt(cand.chosenIndex) ? h('button', { type: 'button', class: 'btn small', disabled: !!t.finalWatch, onclick: function () { submitCandidate(cand.id, null); } }, '撤回提交') : null));
      }));
  }

  function submitCandidate(candId, index) {
    commit('提交守夜名单', function (s) {
      var c = s.today.watchCandidates.find(function (x) { return x.id === candId; });
      if (s.today.finalWatch) throw new Error('最终名单已确认');
      c.chosenIndex = index;
      c.submittedAt = index == null ? null : Date.now();
      s.today.watchDecision = null;
      log(s, nameOf(c.plannerId) + (index == null ? ' 撤回守夜名单提交' : ' 提交守夜名单' + (index ? '②' : '①') + '：' + C.describeWatchOption(c.options[index], nameOf)), true);
    });
  }

  function resolveCtx() {
    return { plannerIds: state.today.plannerIds, skillUserIds: state.today.skillUserIds, aliveIds: aliveIds() };
  }

  function finalCard() {
    var t = state.today;
    if (t.finalWatch) return finalSummary(t.finalWatch);
    var subs = C.submittedCandidates(t);
    var mode = C.watchMode(subs.length);
    var decider = C.lastSeat(seatedAlive());
    var option = null;
    var source = '';
    var extra = {};
    var body = [];
    if (mode === 'random') {
      body.push(h('p', null, '没有人提交名单：由系统随机一份名单（抽取后存档，刷新不变）。'));
      if (t.randomWatch) {
        option = t.randomWatch;
        source = '系统随机';
      } else {
        body.push(h('button', {
          type: 'button', class: 'btn primary', onclick: function () {
            commit('随机守夜名单', function (s) {
              var opts = C.drawWatchOptions(s.watchTemplates, aliveIds(s), Math.random, s.rules.watchSize);
              if (!opts.length) throw new Error('没有启用的名单模板');
              s.today.randomWatch = opts[0];
              log(s, '系统随机守夜名单：' + C.describeWatchOption(opts[0], nameOf), true);
            });
          }
        }, '系统随机一份名单'));
      }
    } else if (mode === 'single') {
      option = subs[0].options[subs[0].chosenIndex];
      source = '唯一提交（' + nameOf(subs[0].plannerId) + '）';
      extra.candidateId = subs[0].id;
      body.push(h('p', null, '只有一份提交：' + nameOf(subs[0].plannerId) + ' 选中的名单直接成为最终名单。'));
    } else {
      var dm = '【守夜拍板·第' + state.day + '天】' + (decider ? nameOf(decider) : '') + '：你是末位，请从以下名单中选择最终一份：' +
        subs.map(function (c, i) { return (i + 1) + '. ' + C.describeWatchOption(c.options[c.chosenIndex], nameOf); }).join('；') + '。请私信回复编号。';
      body.push(h('p', null, '收到 ' + subs.length + ' 份提交：由实际座次最后的人 ', h('b', null, decider ? nameOf(decider) : '（无人在座）'), ' 从所有提交中选择最终一份（仅拍板不算计划者）。'));
      body.push(h('details', null, h('summary', null, '给末位的私信文本'), U.copyBlock(dm, { note: '暂停共享后私发' })));
      body.push(h('div', { class: 'row' }, subs.map(function (c, i) {
        return h('button', {
          type: 'button', class: 'btn small ' + (t.watchDecision === c.id ? 'primary' : ''), onclick: function () {
            commit('末位选择名单', function (s) {
              s.today.watchDecision = c.id;
              log(s, '末位 ' + nameOf(decider) + ' 选择第 ' + (i + 1) + ' 份名单', true);
            });
          }
        }, '末位选第 ' + (i + 1) + ' 份');
      })));
      if (t.watchDecision) {
        var chosen = subs.find(function (c) { return c.id === t.watchDecision; });
        if (chosen) {
          option = chosen.options[chosen.chosenIndex];
          source = '末位 ' + nameOf(decider) + ' 从 ' + subs.length + ' 份提交中选择';
          extra.candidateId = chosen.id;
          extra.deciderId = decider;
        }
      }
    }
    if (option) body.push(finalPreview(option, source, extra));
    return h('section', { class: 'card' }, h('div', { class: 'card-head' }, h('h2', null, '确认最终名单')), body);
  }

  function finalPreview(option, source, extra) {
    var res = C.resolveWatchOption(option, resolveCtx());
    var chosen = {};
    res.memberIds.forEach(function (id) { chosen[id] = true; });
    return h('div', { class: 'card inset' },
      h('p', null, h('b', null, '名单：'), C.describeWatchOption(option, nameOf)),
      h('p', null, h('b', null, '按当日记录解析的人员：'), names(res.memberIds)),
      res.tendencies.length ? h('p', null, h('b', null, '风险倾向：'), res.tendencies.map(function (k) { return C.TENDENCY_NAMES[k]; }).join('、')) : null,
      res.notes.map(function (n) { return h('div', { class: 'callout risk' }, n); }),
      h('div', { class: 'row' }, h('span', { class: 'muted' }, '最终守夜人员（可由主持人调整）：'), aliveIds().map(function (id) {
        var box = h('input', { type: 'checkbox', checked: !!chosen[id], onchange: function () { chosen[id] = box.checked; } });
        return h('label', { class: 'check' }, box, nameOf(id));
      })),
      h('p', { class: 'muted small' }, '6人局通常 ' + state.rules.watchSize + ' 人，特殊条件可改变人数。是否实际守夜不会自动消耗本人额外行动。'),
      h('button', {
        type: 'button', class: 'btn primary', onclick: function () {
          var members = aliveIds().filter(function (id) { return chosen[id]; });
          if (!members.length) { U.toast('请至少选择一名守夜者', 'warn'); return; }
          commit('确认守夜名单', function (s) {
            if (s.today.finalWatch) throw new Error('今日最终名单已确认');
            s.today.finalWatch = {
              id: C.uid('fw'), day: s.day, source: source, option: C.clone(option), memberIds: members,
              memberNames: members.map(nameOf), tendencies: res.tendencies, deciderId: extra.deciderId || null,
              candidateId: extra.candidateId || null, confirmedAt: Date.now(), published: false, carried: {}
            };
            log(s, '确认守夜最终名单：' + names(members) + '（' + source + '）', true);
            log(s, '守夜最终名单已确认（是否公开由主持人决定）');
          });
        }
      }, '确认最终名单（保存人员快照）'));
  }

  function finalSummary(fw) {
    return h('section', { class: 'card' },
      h('div', { class: 'card-head' }, h('h2', null, '最终名单'), fw.published ? chip('已公开', 'ok') : chip('未公开', '')),
      h('p', null, h('b', null, '守夜人员：'), fw.memberNames.join('、')),
      h('p', { class: 'muted' }, '来源：' + fw.source + '；名单：' + C.describeWatchOption(fw.option, nameOf)),
      fw.tendencies.length ? h('p', null, '风险倾向：' + fw.tendencies.map(function (k) { return C.TENDENCY_NAMES[k]; }).join('、')) : null,
      h('div', { class: 'row' },
        fw.published ? null : h('button', {
          type: 'button', class: 'btn primary', onclick: function () {
            commit('公开守夜人员', function (s) {
              var f = s.today.finalWatch;
              publish(s, 'watch', '今晚守夜：' + f.memberNames.join('、'), f.id);
              f.published = true;
              log(s, '公开守夜人员：' + f.memberNames.join('、'));
            });
          }
        }, '公开到公开页'),
        h('button', {
          type: 'button', class: 'btn', onclick: function () {
            U.confirmBox('作废最终名单？', '将清除今日最终名单（已公开的内容会一并撤下），可重新确认。', '作废', 'danger').then(function (ok) {
              if (!ok) return;
              commit('作废守夜名单', function (s) {
                var f = s.today.finalWatch;
                s.publicFeed = s.publicFeed.filter(function (x) { return x.refId !== f.id; });
                s.today.finalWatch = null;
                log(s, '作废守夜最终名单');
              });
            });
          }
        }, '作废并重新确认')));
  }

  function nightCard() {
    var t = state.today;
    var fw = t.finalWatch;
    var pending = state.pendingNightResult;
    var lib = state.nightLibrary;
    var tendencies = fw ? fw.tendencies : [];
    var filtered = ui.showAllNight ? lib : lib.filter(function (e) {
      return tendencies.length ? tendencies.indexOf(e.tendency) >= 0 : e.tendency === 'neutral';
    });
    if (!filtered.length && !ui.showAllNight) filtered = lib;
    var draw = t.nightDraw;
    var drawn = draw ? lib.find(function (e) { return e.id === draw.resultId; }) : null;
    if (ui.drafts.nightText == null || ui.drafts.nightFor !== state.day + ':' + (draw ? draw.resultId : '')) {
      ui.drafts.nightFor = state.day + ':' + (draw ? draw.resultId : '');
      ui.drafts.nightText = (fw ? '守夜：' + fw.memberNames.join('、') + '。' : '') + (drawn ? drawn.text : '');
    }
    var manualSel = U.select([['', '手动选择结果…']].concat(filtered.map(function (e) { return [e.id, e.name + (C.isNum(e.weight) ? '（权重' + e.weight + '）' : '')]; })), draw ? draw.resultId : '', function () {});
    return h('section', { class: 'card' },
      h('div', { class: 'card-head' }, h('h2', null, '夜间结果'), h('span', { class: 'muted small' }, '名单决定对象与风险倾向，结果库决定实际后果')),
      fw ? h('div', { class: 'stack' },
        h('p', null, '守夜者可携带物品：食物可用于避免野兽袭击，其他工具按遭遇生效。请按玩家上报填写（主持人端不会自动获取玩家库存）。'),
        fw.memberIds.map(function (id) {
          var input = h('input', { type: 'text', value: (fw.carried && fw.carried[id]) || '', placeholder: '上报的携带物品' });
          input.addEventListener('change', function () {
            commit('记录守夜携带', function (s) {
              s.today.finalWatch.carried = s.today.finalWatch.carried || {};
              s.today.finalWatch.carried[id] = input.value;
              log(s, nameOf(id) + ' 守夜携带：' + input.value, true);
            }, { undo: false });
          });
          return U.field(nameOf(id) + ' 携带', input);
        })) : h('p', { class: 'muted' }, '还没有确认最终名单；仍可手动起草夜间结果。'),
      h('div', { class: 'row' },
        h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: ui.showAllNight, onchange: function (e) { ui.showAllNight = e.target.checked; render(); } }), '显示全部结果（不按倾向筛选）'),
        h('span', { class: 'muted small' }, '候选结果 ' + filtered.length + ' 条')),
      draw ? h('div', { class: 'callout ok' }, '已' + (draw.mode === 'auto' ? '按权重抽取（' + draw.roll.toFixed(1) + '）' : '手动选择') + '：' + (drawn ? drawn.name : '（结果已删除）') + '。抽取结果已存档，刷新不变。') : null,
      h('div', { class: 'row' },
        h('button', {
          type: 'button', class: 'btn', disabled: !!draw || !C.nightDrawable(filtered), onclick: function () {
            commit('抽取夜间结果', function (s) {
              var idx = C.weightedIndex(filtered, function (e) { return e.weight; });
              if (idx < 0) throw new Error('权重不完整，请手动选择');
              var total = filtered.reduce(function (a, e) { return a + e.weight; }, 0);
              s.today.nightDraw = { resultId: filtered[idx].id, roll: Math.random() * total, mode: 'auto', at: Date.now() };
              log(s, '夜间结果按权重抽取：' + filtered[idx].name, true);
            });
          }
        }, '按权重抽取'),
        C.nightDrawable(filtered) ? null : h('span', { class: 'muted small' }, '有结果未填权重：不能自动抽签，请手动选择。'),
        manualSel,
        h('button', {
          type: 'button', class: 'btn', disabled: !!draw, onclick: function () {
            if (!manualSel.value) { U.toast('请选择一条结果', 'warn'); return; }
            commit('手动选择夜间结果', function (s) {
              s.today.nightDraw = { resultId: manualSel.value, roll: null, mode: 'manual', at: Date.now() };
              log(s, '夜间结果手动选择：' + (lib.find(function (e) { return e.id === manualSel.value; }) || {}).name, true);
            });
          }
        }, '手动选择'),
        draw ? h('button', {
          type: 'button', class: 'btn small', onclick: function () {
            U.confirmBox('作废抽取结果？', '作废后可以重新抽取或选择（记入日志）。', '作废', 'danger').then(function (ok) {
              if (!ok) return;
              commit('作废夜间抽取', function (s) { s.today.nightDraw = null; log(s, '作废夜间结果抽取', true); });
            });
          }
        }, '作废抽取') : null),
      U.field('结果草稿（次日阶段1公布的文字）', draftArea('nightText', 4, '例如：守夜：A、B。一夜无事。')),
      h('div', { class: 'row' }, h('button', { type: 'button', class: 'btn primary', onclick: saveNightResult }, '保存为昨夜结果（次日阶段1公布）')),
      pending ? h('div', { class: 'callout ' + (pending.publishedDay == null ? 'info' : 'ok') },
        (pending.publishedDay == null ? '待公布' : '已于第' + pending.publishedDay + '天公布') + '（第' + pending.day + '天夜间）：' + pending.text) : null);
  }

  function saveNightResult() {
    var text = (ui.drafts.nightText || '').trim();
    if (!text) { U.toast('结果草稿是空的', 'warn'); return; }
    var prev = state.pendingNightResult;
    var chain = prev && prev.publishedDay == null && prev.day !== state.day
      ? U.confirmBox('上一晚的结果还没公布', '第' + prev.day + '天夜间的结果尚未公布，保存会覆盖它。确定吗？', '覆盖', 'danger')
      : Promise.resolve(true);
    chain.then(function (ok) {
      if (!ok) return;
      commit('保存夜间结果', function (s) {
        var fw = s.today.finalWatch;
        s.pendingNightResult = {
          id: C.uid('night'), day: s.day, text: text, memberIds: fw ? fw.memberIds.slice() : [],
          resultId: s.today.nightDraw ? s.today.nightDraw.resultId : null, createdAt: Date.now(), publishedDay: null
        };
        log(s, '保存第' + s.day + '天夜间结果草稿：' + text, true);
        log(s, '夜间结果已保存，次日阶段1公布');
      });
    });
  }

  function watchTemplatesCard() {
    return h('details', { class: 'card' },
      h('summary', null, h('b', null, '名单模板'), h('span', { class: 'muted small' }, ' 与夜间遭遇结果分开存储；条目之间不擅自混合')),
      h('p', { class: 'section-note' }, '计划者从启用的模板中加权无放回抽两份。条目之间是替代、叠加还是组合随机尚未确定：多条目模板请标明组合方式，最终由主持人预览确认。'),
      state.watchTemplates.map(function (t) {
        return h('div', { class: 'card inset tpl' },
          h('div', { class: 'row' },
            U.field('名称', tplInput(t, 'name')),
            U.field('权重', tplNumber(t, 'weight')),
            h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: t.enabled, onchange: function (e) { updateTemplate(t.id, function (x) { x.enabled = e.target.checked; }); } }), '启用'),
            h('button', { type: 'button', class: 'btn small', onclick: function () { updateTemplate(t.id, null); } }, '删除')),
          h('div', { class: 'row' }, C.WATCH_KINDS.map(function (k) {
            var entry = t.entries.find(function (e) { return e.kind === k.id; });
            var box = h('input', {
              type: 'checkbox', checked: !!entry, onchange: function () {
                updateTemplate(t.id, function (x) {
                  if (box.checked) x.entries.push({ kind: k.id, count: k.id === 'designated' ? state.rules.watchSize : null });
                  else x.entries = x.entries.filter(function (e) { return e.kind !== k.id; });
                });
              }
            });
            var count = null;
            if (k.id === 'designated' && entry) {
              count = h('input', { type: 'number', min: 1, class: 'num', value: entry.count || state.rules.watchSize });
              count.addEventListener('change', function () {
                var n = parseInt(count.value, 10);
                if (!(n > 0)) { U.toast('人数需为正整数', 'warn'); return; }
                updateTemplate(t.id, function (x) { x.entries.forEach(function (e) { if (e.kind === 'designated') e.count = n; }); });
              });
            }
            return h('label', { class: 'check' }, box, k.id === 'designated' ? '指定' : k.name, count, k.id === 'designated' ? '人' : null);
          })),
          t.entries.length > 1 ? U.field('组合方式', U.select(C.WATCH_COMBINE.map(function (c) { return [c.id, c.name]; }), t.combine, function (v) { updateTemplate(t.id, function (x) { x.combine = v; }); })) : null,
          t.note ? h('p', { class: 'muted small' }, t.note) : null);
      }),
      h('div', { class: 'row' },
        h('button', { type: 'button', class: 'btn', onclick: function () { commit('新增名单模板', function (s) { s.watchTemplates.push(C.newWatchTemplate()); log(s, '新增名单模板', true); }); } }, '+ 新增模板'),
        h('button', {
          type: 'button', class: 'btn', onclick: function () {
            U.confirmBox('恢复默认六条模板？', '会替换当前所有名单模板（已抽取的候选不受影响，它们保存了模板快照）。', '恢复默认').then(function (ok) {
              if (ok) commit('恢复默认名单模板', function (s) { s.watchTemplates = C.defaultWatchTemplates(); log(s, '恢复默认名单模板', true); });
            });
          }
        }, '恢复默认')));
  }

  function tplInput(t, key) {
    var el = h('input', { type: 'text', value: t[key] || '' });
    el.addEventListener('change', function () { updateTemplate(t.id, function (x) { x[key] = el.value; }); });
    return el;
  }

  function tplNumber(t, key) {
    var el = h('input', { type: 'number', min: 0, step: 'any', class: 'num', value: t[key] == null ? '' : t[key] });
    el.addEventListener('change', function () {
      var n = U.parseNumber(el.value, true);
      if (n == null || Number.isNaN(n) || n < 0) { U.toast('权重需为非负数字', 'warn'); el.value = t[key] == null ? '' : t[key]; return; }
      updateTemplate(t.id, function (x) { x[key] = n; });
    });
    return el;
  }

  function updateTemplate(id, fn) {
    commit(fn ? '修改名单模板' : '删除名单模板', function (s) {
      var idx = s.watchTemplates.findIndex(function (x) { return x.id === id; });
      if (idx < 0) return false;
      if (!fn) {
        log(s, '删除名单模板：' + s.watchTemplates[idx].name, true);
        s.watchTemplates.splice(idx, 1);
        return;
      }
      fn(s.watchTemplates[idx]);
      log(s, '修改名单模板：' + s.watchTemplates[idx].name, true);
    });
  }

  function nightLibraryCard() {
    return h('details', { class: 'card' },
      h('summary', null, h('b', null, '夜间遭遇结果库'), h('span', { class: 'muted small' }, ' 权重全部填写才允许自动抽签；不使用统一的80%')),
      state.nightLibrary.length ? state.nightLibrary.map(function (e) {
        var name = h('input', { type: 'text', value: e.name });
        name.addEventListener('change', function () { updateNight(e.id, function (x) { x.name = name.value; }); });
        var text = h('textarea', { rows: 2 });
        text.value = e.text;
        text.addEventListener('change', function () { updateNight(e.id, function (x) { x.text = text.value; }); });
        var weight = h('input', { type: 'number', min: 0, step: 'any', class: 'num', value: e.weight == null ? '' : e.weight, placeholder: '未填' });
        weight.addEventListener('change', function () {
          var n = U.parseNumber(weight.value, true);
          if (Number.isNaN(n) || (n != null && n < 0)) { U.toast('权重需为非负数字或留空', 'warn'); return; }
          updateNight(e.id, function (x) { x.weight = n; });
        });
        return h('div', { class: 'card inset' },
          h('div', { class: 'row' }, U.field('名称', name), U.field('倾向', U.select([['neutral', '中性'], ['rescue', '营救信息'], ['danger', '遭遇不测']], e.tendency, function (v) { updateNight(e.id, function (x) { x.tendency = v; }); })), U.field('权重', weight),
            e.isDemo ? chip('演示', 'demo') : null,
            h('button', { type: 'button', class: 'btn small', onclick: function () { updateNight(e.id, null); } }, '删除')),
          U.field('结果文字', text));
      }) : h('p', { class: 'empty' }, '结果库为空（正式内容待设计）。可以手动起草夜间结果，或新增条目。'),
      h('div', { class: 'row' },
        h('button', { type: 'button', class: 'btn', onclick: function () { commit('新增夜间结果', function (s) { s.nightLibrary.push(C.newNightResult()); }); } }, '+ 新增结果'),
        h('button', {
          type: 'button', class: 'btn', onclick: function () {
            commit('复制演示夜间结果', function (s) { DEMO_NIGHT.forEach(function (d) { s.nightLibrary.push(demoNight(d)); }); log(s, '复制演示夜间结果到结果库', true); });
          }
        }, '复制演示结果（标记为演示）')));
  }

  function updateNight(id, fn) {
    commit(fn ? '修改夜间结果' : '删除夜间结果', function (s) {
      var idx = s.nightLibrary.findIndex(function (x) { return x.id === id; });
      if (idx < 0) return false;
      if (!fn) { s.nightLibrary.splice(idx, 1); return; }
      fn(s.nightLibrary[idx]);
    });
  }

  // ================================================================ 公共事件

  function renderEvents() {
    return h('div', { class: 'stack' },
      eventTriggerCard(false),
      stageEventCard(),
      gate('events', '事件结算与事件库', function () {
        return h('div', { class: 'stack' }, eventFlowCard(), eventLibraryCard());
      }));
  }

  function eventTriggerCard(inPhasePanel) {
    var check = state.today.eventCheck;
    var pos = state.rules.eventPosition;
    var body = h('div', { class: 'stack' },
      h('p', { class: 'muted small' }, '每日一次判定：' + state.rules.eventChance + '% 触发需要投票的公共事件。判定只控制是否触发，不等于事件成功率；各分支结果另按概率结算。' +
        (pos ? '' : '事件位置未配置：由主持人手动触发。')),
      check ? h('div', { class: 'callout ' + (check.triggered ? 'ok' : 'info') },
        '今日判定：掷出 ' + check.roll + '（< ' + check.chance + ' 触发）→ ' + (check.triggered ? '触发公共事件' : '无事件') + (check.override ? '（主持人裁定改为' + (check.triggered ? '触发' : '无事件') + '）' : '')) : null,
      h('div', { class: 'row' },
        check ? null : h('button', {
          type: 'button', class: 'btn primary', disabled: !state.started, onclick: function () {
            commit('每日事件判定', function (s) {
              if (s.today.eventCheck) throw new Error('今日已判定，一次每日判定只能结算一次');
              var r = C.rollEventTrigger(s.rules.eventChance, Math.random);
              s.today.eventCheck = { roll: r.roll, chance: r.chance, triggered: r.triggered, at: Date.now(), override: false };
              log(s, '每日事件判定：掷出 ' + r.roll + '（< ' + r.chance + ' 触发）→ ' + (r.triggered ? '触发' : '无事件'));
            });
          }
        }, '进行今日事件判定（' + state.rules.eventChance + '%）'),
        check ? h('button', {
          type: 'button', class: 'btn small', onclick: function () {
            U.confirmBox('主持人裁定', '把今日判定改为「' + (check.triggered ? '无事件' : '触发') + '」？会记入日志。', '改判').then(function (ok) {
              if (!ok) return;
              commit('改判事件', function (s) {
                s.today.eventCheck.triggered = !s.today.eventCheck.triggered;
                s.today.eventCheck.override = true;
                log(s, '主持人裁定：今日事件改为' + (s.today.eventCheck.triggered ? '触发' : '无事件'));
              });
            });
          }
        }, '主持人裁定：改为' + (check.triggered ? '无事件' : '触发')) : null,
        inPhasePanel ? goSecret('events', '选择与结算事件（秘密）') : null));
    if (inPhasePanel) return body;
    return h('section', { class: 'card' }, h('div', { class: 'card-head' }, h('h2', null, '今日事件判定')), body);
  }

  function stageEventCard() {
    var ev = state.stage.event;
    return h('section', { class: 'card' },
      h('div', { class: 'card-head' }, h('h2', null, '公开页上的事件')),
      ev ? h('div', null, h('p', null, h('b', null, ev.name), ev.location ? ' · ' + ev.location : ''), h('p', null, ev.body), h('p', { class: 'muted' }, '投票选项：' + ev.options.join(' ／ ')),
        h('button', {
          type: 'button', class: 'btn', onclick: function () {
            commit('撤下公开事件', function (s) { s.stage.event = null; if (s.today.eventFlow) s.today.eventFlow.published = false; log(s, '撤下公开事件'); });
          }
        }, '撤下')) : h('p', { class: 'empty' }, '公开页目前没有事件。'));
  }

  function findOption(flow) {
    if (!flow || !flow.event) return null;
    return flow.event.options.find(function (o) { return o.id === flow.vote; }) || null;
  }

  function findOutcome(flow) {
    var op = findOption(flow);
    if (!op || !flow.preview) return null;
    return op.outcomes.find(function (o) { return o.id === flow.preview.outcomeId; }) || null;
  }

  function effectiveEffects(flow) {
    var oc = findOutcome(flow);
    var base = oc ? oc.effects : C.emptyEffects();
    var fx = { rescue: base.rescue, pool: (base.pool || []).slice(), personal: base.personal || C.emptyEffects().personal };
    if (flow.override) {
      if (Object.prototype.hasOwnProperty.call(flow.override, 'rescue')) fx.rescue = flow.override.rescue;
      if (flow.override.pool) fx.pool = flow.override.pool.slice();
    }
    return fx;
  }

  function eventFlowCard() {
    var flow = state.today.eventFlow;
    var check = state.today.eventCheck;
    if (!flow) {
      var formal = state.events.filter(function (e) { return !e.isDraft; });
      var pickSel = U.select([['', '手动选择事件…']].concat(state.events.map(function (e) { return [e.id, e.name + (e.isDraft ? '（草案）' : '') + (e.isDemo ? '（演示）' : '')]; })), '', function () {});
      return h('section', { class: 'card' },
        h('div', { class: 'card-head' }, h('h2', null, '今日事件结算')),
        !check ? h('div', { class: 'callout info' }, '今天还没做事件判定。也可以由主持人手动触发（记入日志）。') :
          !check.triggered ? h('div', { class: 'callout info' }, '今日判定为无事件。主持人仍可手动触发（记入日志）。') : null,
        h('div', { class: 'row' },
          h('button', {
            type: 'button', class: 'btn primary', disabled: !formal.length, onclick: function () {
              var ev = formal[Math.floor(Math.random() * formal.length)];
              startFlow(ev, '从事件库随机（非草案）');
            }
          }, '从事件库随机一件（不含草案）'),
          pickSel,
          h('button', { type: 'button', class: 'btn', onclick: function () { var ev = state.events.find(function (e) { return e.id === pickSel.value; }); if (!ev) { U.toast('请先选择事件', 'warn'); return; } startFlow(ev, '主持人手动选择'); } }, '使用所选事件'),
          h('button', { type: 'button', class: 'btn', onclick: adHocEvent }, '临时录入事件')),
        formal.length ? null : h('p', { class: 'muted small' }, '正式事件库为空（约20个公共事件的内容待设计）：请手动选择草案、临时录入，或在下方新建／导入。'));
    }
    var ev = flow.event;
    var op = findOption(flow);
    var st = op ? C.probabilityStatus(op) : null;
    var oc = findOutcome(flow);
    var res = flow.resolutionId ? state.resolutions.find(function (r) { return r.id === flow.resolutionId; }) : null;
    var voteSel = U.select([['', '选择 Discord 投票结果…']].concat(ev.options.map(function (o, i) { return [o.id, String.fromCharCode(65 + i) + '. ' + o.label]; })), flow.vote || '', function () {});
    return h('section', { class: 'card' },
      h('div', { class: 'card-head' }, h('h2', null, '今日事件结算'), h('span', { class: 'muted small' }, flow.source)),
      eventSummary(ev),
      h('div', { class: 'flow-steps' },
        flowStep('1', '公布事件正文', flow.published ? h('span', null, chip('已公布', 'ok'), ' ', h('button', { type: 'button', class: 'btn small', onclick: unpublishEvent }, '撤下')) :
          h('button', { type: 'button', class: 'btn primary', onclick: publishEvent }, '公布到公开页')),
        flowStep('2', '录入 Discord 投票结果', flow.vote ? h('span', null, '投票结果：' + (op ? op.label : '?'), ' ', res ? null : h('button', { type: 'button', class: 'btn small', onclick: function () { setVote(null); } }, '修改')) :
          h('span', { class: 'row' }, voteSel, h('button', { type: 'button', class: 'btn', onclick: function () { if (!voteSel.value) { U.toast('请选择投票结果', 'warn'); return; } setVote(voteSel.value); } }, '录入'))),
        op ? flowStep('3', '按该选项的结果概率结算', previewControls(flow, op, st)) : null,
        flow.preview && oc ? flowStep('4', '预览效果', previewEffects(flow, oc, res)) : null,
        res ? flowStep('5', '结算完成', resolutionView(res, flow, oc)) : null),
      res ? null : h('div', { class: 'row' }, h('button', {
        type: 'button', class: 'btn small', onclick: function () {
          U.confirmBox('放弃今日事件流程？', '会清除所选事件、投票与预览（记入日志），可以重新选择。', '放弃', 'danger').then(function (ok) {
            if (!ok) return;
            commit('放弃事件流程', function (s) {
              if (s.today.eventFlow && s.today.eventFlow.published) s.stage.event = null;
              s.today.eventFlow = null;
              log(s, '放弃今日事件流程', true);
            });
          });
        }
      }, '放弃并重新选择事件')));
  }

  function flowStep(no, title, content) {
    return h('div', { class: 'flow-step' }, h('div', { class: 'flow-no' }, no), h('div', { class: 'grow' }, h('div', { class: 'flow-title' }, title), content));
  }

  function eventSummary(ev) {
    return h('div', { class: 'card inset' },
      h('h3', null, ev.name, ev.isDemo ? chip('演示', 'demo') : null, ev.isDraft ? chip('草案', '') : null),
      h('p', { class: 'muted small' }, [ev.location ? '地点：' + ev.location : '', ev.tags.length ? '标签：' + ev.tags.join('、') : '', ev.participants ? '参与：' + ev.participants : '',
        ev.carryTicks != null ? '携带容量：' + C.fmtUnits(ev.carryTicks) + ' 单位' : ''].filter(Boolean).join('　')),
      ev.body ? h('p', null, ev.body) : null,
      ev.conditions || ev.itemUses ? h('p', { class: 'small' }, [ev.conditions ? '条件：' + ev.conditions : '', ev.itemUses ? '物品用途：' + ev.itemUses : ''].filter(Boolean).join('；')) : null,
      ev.modifiers ? h('p', { class: 'small muted' }, '修正：' + ev.modifiers) : null,
      h('p', { class: 'small' }, '选项：' + ev.options.map(function (o, i) { return String.fromCharCode(65 + i) + '. ' + o.label; }).join('　')));
  }

  function startFlow(ev, source) {
    commit('选择今日事件', function (s) {
      if (s.today.eventFlow) throw new Error('今日已有事件流程');
      var check = s.today.eventCheck;
      s.today.eventFlow = { id: C.uid('flow'), event: C.clone(ev), source: source, published: false, vote: null, preview: null, override: null, resolutionId: null, startedAt: Date.now() };
      if (!check || !check.triggered) log(s, '主持人手动触发公共事件');
      log(s, '选择今日事件：' + ev.name + '（' + source + '）', true);
    });
  }

  function adHocEvent() {
    openEventEditor(null, '临时录入事件').then(function (draft) {
      if (!draft) return;
      var saveToo = draft.__saveToLibrary;
      delete draft.__saveToLibrary;
      commit('临时录入事件', function (s) {
        if (saveToo) s.events.push(C.clone(draft));
        var check = s.today.eventCheck;
        s.today.eventFlow = { id: C.uid('flow'), event: C.clone(draft), source: '临时录入', published: false, vote: null, preview: null, override: null, resolutionId: null, startedAt: Date.now() };
        if (!check || !check.triggered) log(s, '主持人手动触发公共事件');
        log(s, '临时录入事件：' + draft.name, true);
      });
    });
  }

  function publishEvent() {
    commit('公布事件', function (s) {
      var f = s.today.eventFlow;
      s.stage.event = { name: f.event.name, location: f.event.location, body: f.event.body, options: f.event.options.map(function (o) { return o.label; }), flowId: f.id };
      f.published = true;
      log(s, '公布公共事件：' + f.event.name);
    });
  }

  function unpublishEvent() {
    commit('撤下公开事件', function (s) {
      s.stage.event = null;
      s.today.eventFlow.published = false;
      log(s, '撤下公开事件');
    });
  }

  function setVote(optionId) {
    commit('录入投票结果', function (s) {
      var f = s.today.eventFlow;
      if (f.resolutionId) throw new Error('已结算，请先撤销结算');
      f.vote = optionId;
      f.preview = null;
      f.override = null;
      var op = f.event.options.find(function (o) { return o.id === optionId; });
      log(s, optionId ? '投票结果：' + f.event.name + ' → ' + op.label : '清除投票结果');
    });
  }

  function previewControls(flow, op, st) {
    if (flow.preview) {
      return h('div', null,
        h('p', null, flow.preview.mode === 'auto' ? '已按概率抽签：掷出 ' + flow.preview.roll.toFixed(1) + '（抽签结果已存档，刷新不会重抽）' : '主持人手动指定结果'),
        flow.resolutionId ? null : h('button', {
          type: 'button', class: 'btn small', onclick: function () {
            U.confirmBox('作废预览？', '作废后可以重新抽签或手动指定（记入日志）。', '作废', 'danger').then(function (ok) {
              if (!ok) return;
              commit('作废事件预览', function (s) { s.today.eventFlow.preview = null; s.today.eventFlow.override = null; log(s, '作废事件结果预览', true); });
            });
          }
        }, '作废预览'));
    }
    var manualSel = U.select([['', '手动选择结果…']].concat(op.outcomes.map(function (o, i) { return [o.id, '结果' + (i + 1) + '：' + (o.text || '（无文字）') + (C.isNum(o.probability) ? '（' + o.probability + '%）' : '')]; })), '', function () {});
    return h('div', { class: 'stack' },
      st.complete ? h('p', { class: 'small' }, '概率合计100%：允许自动抽签。') : h('div', { class: 'callout risk' }, '概率未完成（' + st.reason + '）：不能自动抽签，请手动录入结果。'),
      h('div', { class: 'row' },
        h('button', {
          type: 'button', class: 'btn primary', disabled: !st.complete, onclick: function () {
            commit('事件抽签', function (s) {
              var f = s.today.eventFlow;
              if (f.preview) throw new Error('已有预览');
              var o = f.event.options.find(function (x) { return x.id === f.vote; });
              var d = C.drawOutcome(o, Math.random);
              if (!d) throw new Error('概率不完整，不能自动抽签');
              f.preview = { id: C.uid('pv'), optionId: o.id, outcomeId: d.outcomeId, roll: d.roll, mode: 'auto', at: Date.now() };
              log(s, '事件抽签：' + f.event.name + ' / ' + o.label + ' → 掷出 ' + d.roll.toFixed(1), true);
            });
          }
        }, '按概率抽签'),
        manualSel,
        h('button', {
          type: 'button', class: 'btn', onclick: function () {
            if (!manualSel.value) { U.toast('请选择结果', 'warn'); return; }
            commit('手动指定事件结果', function (s) {
              var f = s.today.eventFlow;
              if (f.preview) throw new Error('已有预览');
              f.preview = { id: C.uid('pv'), optionId: f.vote, outcomeId: manualSel.value, roll: null, mode: 'manual', at: Date.now() };
              log(s, '事件结果手动指定', true);
            });
          }
        }, '手动指定')));
  }

  function previewEffects(flow, oc, res) {
    var fx = effectiveEffects(flow);
    var shortages = res ? [] : C.poolShortages(state.pool, fx.pool);
    var personal = C.describePersonalEffects(fx.personal, state.customItems);
    return h('div', { class: 'stack' },
      h('p', null, h('b', null, '结果：'), oc.text || '（无文字）'),
      h('ul', null,
        h('li', null, '营救进度：' + (C.isNum(fx.rescue) && fx.rescue ? (fx.rescue > 0 ? '+' : '') + fx.rescue : '不变')),
        h('li', null, '公共池：' + (fx.pool.length ? C.formatItemList(fx.pool, state.customItems, true) : '不变')),
        h('li', null, '个人效果：' + (personal ? '（对象：' + (fx.personal.target || '由主持人宣布') + '）' + personal + ' —— 只生成通知，玩家自行录入' : '无'))),
      flow.override ? h('p', { class: 'small risk-text' }, '本次结算使用了主持人覆盖的效果。') : null,
      shortages.length ? h('div', { class: 'callout danger' }, '公共池不足，结算已暂停：' + shortages.map(function (s) { return defName(s.defId) + ' 需要 ' + s.need + '、现有 ' + s.have; }).join('；') +
        '。不会静默扣成负数——请修改效果或由主持人覆盖。') : null,
      res ? null : h('div', { class: 'row' },
        h('button', { type: 'button', class: 'btn', onclick: function () { overrideDialog(flow, fx); } }, '修改本次效果（主持人覆盖）'),
        shortages.length ? h('button', {
          type: 'button', class: 'btn risk', onclick: function () {
            commit('按现有数量扣除', function (s) {
              var f = s.today.eventFlow;
              var cur = effectiveEffects(f);
              f.override = Object.assign({}, f.override || {}, {
                pool: cur.pool.map(function (d) {
                  if (d.qty >= 0) return d;
                  return { defId: d.defId, qty: -Math.min(-d.qty, C.countDef(s.pool, d.defId)) };
                }).filter(function (d) { return d.qty !== 0; })
              });
              log(s, '主持人覆盖：公共池按现有数量扣除', true);
            });
          }
        }, '按现有数量扣除（主持人覆盖）') : null,
        h('button', {
          type: 'button', class: 'btn primary', disabled: shortages.length > 0, onclick: function (e) {
            e.currentTarget.disabled = true;
            confirmResolution();
          }
        }, '确认结算')));
  }

  function overrideDialog(flow, fx) {
    var rescue = h('input', { type: 'number', value: fx.rescue == null ? '' : fx.rescue, placeholder: '不变' });
    var pool = h('input', { type: 'text', value: C.formatItemList(fx.pool, state.customItems, true), placeholder: '例如：面包+2，子弹-1' });
    U.modal({
      title: '修改本次结算效果',
      body: h('div', { class: 'stack' },
        h('p', { class: 'muted small' }, '只影响本次结算，不改事件库。个人效果只生成通知，不在这里扣玩家物品。'),
        U.field('营救进度 ±', rescue),
        U.field('公共池增减', pool)),
      actions: [{ label: '取消', value: false }, { label: '应用', kind: 'primary', value: true }]
    }).then(function (ok) {
      if (!ok) return;
      var r = U.parseNumber(rescue.value, false);
      if (Number.isNaN(r)) { U.toast('营救进度需为整数', 'warn'); return; }
      var parsed = C.parseItemList(pool.value, state.customItems);
      if (parsed.errors.length) { U.toast(parsed.errors[0], 'warn'); return; }
      commit('覆盖事件效果', function (s) {
        s.today.eventFlow.override = { rescue: r, pool: parsed.items };
        log(s, '主持人覆盖本次事件效果：营救' + (r == null ? '不变' : r) + '；公共池 ' + (C.formatItemList(parsed.items, s.customItems, true) || '不变'), true);
      });
    });
  }

  /** 确认结算：一次确认产生唯一 resolutionId，重复点击不会重复增加营救进度或补给。 */
  function confirmResolution() {
    commit('确认事件结算', function (s) {
      var f = s.today.eventFlow;
      if (!f || !f.preview) throw new Error('没有可确认的预览');
      if (f.resolutionId) throw new Error('该结果已确认，不会重复结算');
      if (s.resolutions.some(function (r) { return r.previewId === f.preview.id && !r.undone; })) throw new Error('该结果已确认，不会重复结算');
      var fx = effectiveEffects(f);
      var shortages = C.poolShortages(s.pool, fx.pool);
      if (shortages.length) throw new Error('公共池不足，结算已暂停');
      var changes = C.applyPoolDelta(s.pool, fx.pool, { customItems: s.customItems, rules: s.rules });
      var rescueDelta = C.isNum(fx.rescue) ? fx.rescue : 0;
      s.rescueProgress += rescueDelta;
      var op = f.event.options.find(function (o) { return o.id === f.vote; });
      var oc = op.outcomes.find(function (o) { return o.id === f.preview.outcomeId; });
      var res = {
        id: C.uid('res'), day: s.day, sourceId: f.event.id, eventName: f.event.name, optionId: op.id, optionLabel: op.label,
        outcomeId: oc.id, outcomeText: oc.text, random: { mode: f.preview.mode, roll: f.preview.roll }, previewId: f.preview.id,
        effects: C.clone(fx), applied: { rescue: rescueDelta, poolChanges: changes }, appliedAt: Date.now(), public: false, undone: false
      };
      s.resolutions.push(res);
      f.resolutionId = res.id;
      log(s, '事件结算 ' + res.id + '：' + f.event.name + ' / ' + op.label + ' → ' + (oc.text || '（无文字）') +
        (rescueDelta ? '；营救' + (rescueDelta > 0 ? '+' : '') + rescueDelta : '') + (fx.pool.length ? '；公共池 ' + C.formatItemList(fx.pool, s.customItems, true) : ''), true);
      if (rescueDelta) log(s, '营救进度 ' + (s.rescueProgress - rescueDelta) + ' → ' + s.rescueProgress + '（事件结算）');
      log(s, '事件结算完成（结果待公布）');
    });
  }

  function personalNotice(res) {
    var personal = C.describePersonalEffects(res.effects.personal, state.customItems);
    var lines = ['【事件结果·第' + res.day + '天】' + res.eventName + '：投票「' + res.optionLabel + '」→ ' + (res.outcomeText || '')];
    if (personal) lines.push('个人效果（对象：' + (res.effects.personal.target || '见主持人说明') + '）：' + personal);
    lines.push('请相关玩家在玩家页手动修改。主持人端不会修改任何人的私人物品。');
    return lines.join('\n');
  }

  function resolutionView(res, flow, oc) {
    return h('div', { class: 'stack' },
      h('p', null, '结算编号 ', h('code', null, res.id), res.undone ? chip('已撤销', 'danger') : chip('已应用', 'ok')),
      h('p', { class: 'small' }, '营救 ' + (res.applied.rescue ? (res.applied.rescue > 0 ? '+' : '') + res.applied.rescue : '不变') + '；公共池 ' + (res.effects.pool.length ? C.formatItemList(res.effects.pool, state.customItems, true) : '不变')),
      U.copyBlock(personalNotice(res), { label: '复制结果通知', note: '玩家自行录入个人效果' }),
      h('div', { class: 'row' },
        res.public ? chip('结果已公布', 'ok') : h('button', {
          type: 'button', class: 'btn primary', onclick: function () {
            commit('公布事件结果', function (s) {
              var r = s.resolutions.find(function (x) { return x.id === res.id; });
              publish(s, 'event', r.eventName + '：投票「' + r.optionLabel + '」→ ' + (r.outcomeText || ''), r.id);
              r.public = true;
              log(s, '公布事件结果：' + r.eventName + ' → ' + (r.outcomeText || ''));
            });
          }
        }, '公布结果到公开页'),
        h('button', {
          type: 'button', class: 'btn danger', onclick: function () {
            U.confirmBox('撤销这次结算？', '营救进度与公共池的变化会按记录精确回滚；已公布的结果会撤下。玩家已手动录入的个人效果需要另行通知撤回。', '撤销结算', 'danger').then(function (ok) {
              if (ok) undoResolution(res.id);
            });
          }
        }, '撤销结算')));
  }

  function undoResolution(id) {
    var problems = [];
    var ok = commit('撤销事件结算', function (s) {
      var r = s.resolutions.find(function (x) { return x.id === id; });
      if (!r || r.undone) throw new Error('该结算已撤销');
      var rev = C.revertPoolChanges(s.pool, r.applied.poolChanges, s.customItems);
      problems = rev.problems;
      s.rescueProgress -= r.applied.rescue;
      r.undone = true;
      r.undoneAt = Date.now();
      r.undoProblems = rev.problems;
      s.publicFeed = s.publicFeed.filter(function (f) { return f.refId !== r.id; });
      r.public = false;
      if (s.today.eventFlow && s.today.eventFlow.resolutionId === r.id) s.today.eventFlow.resolutionId = null;
      log(s, '撤销事件结算 ' + r.id + (rev.problems.length ? '（问题：' + rev.problems.join('；') + '）' : ''), true);
      if (r.applied.rescue) log(s, '营救进度回滚：' + (s.rescueProgress + r.applied.rescue) + ' → ' + s.rescueProgress);
      log(s, '撤销一次事件结算');
    });
    if (ok && problems.length) U.modal({ title: '撤销已完成，但有物品无法收回', body: h('ul', null, problems.map(function (p) { return h('li', null, p); })) });
  }

  // ---------------------------------------------------------------- 事件库

  function eventLibraryCard() {
    var input = h('input', { type: 'file', accept: 'application/json,.json', class: 'offscreen' });
    input.addEventListener('change', function () {
      var file = input.files && input.files[0];
      if (!file) return;
      U.readFileText(file).then(importEvents, function (e) { U.toast(e.message, 'warn'); });
      input.value = '';
    });
    return h('section', { class: 'card' },
      h('div', { class: 'card-head' }, h('h2', null, '事件库'), h('span', { class: 'muted small' }, '正式库可为空；约20个事件的内容与概率待设计')),
      h('div', { class: 'row' },
        h('button', { type: 'button', class: 'btn primary', onclick: function () { editEvent(null); } }, '+ 新建事件'),
        h('button', { type: 'button', class: 'btn', onclick: function () { input.click(); } }, '导入 JSON'),
        h('button', { type: 'button', class: 'btn', onclick: function () { U.downloadJSON('shelter-events-' + U.stamp() + '.json', { kind: 'shelter-events', schemaVersion: C.SCHEMA_VERSION, events: state.events }); } }, '导出 JSON'),
        input),
      state.events.length ? h('ul', { class: 'list-plain' }, state.events.map(function (ev) {
        var issues = C.validateEvent(ev);
        return h('li', null, h('div', { class: 'row between' },
          h('div', { class: 'grow' },
            h('b', null, ev.name || '（未命名）'), ' ',
            ev.isDemo ? chip('演示', 'demo') : null, ev.isDraft ? chip('草案', '') : chip(ev.isDemo ? '参与随机' : '正式', 'ok'),
            h('div', { class: 'muted small' }, (ev.location ? ev.location + ' · ' : '') + ev.options.length + ' 个选项 · ' +
              ev.options.map(function (o) { return o.label + (C.probabilityStatus(o).complete ? '（可抽签）' : '（需手动）'); }).join('、')),
            issues.length ? h('div', { class: 'small risk-text' }, issues.join('；')) : null),
          h('div', { class: 'row tight' },
            h('button', { type: 'button', class: 'btn small', onclick: function () { editEvent(ev); } }, '编辑'),
            h('button', { type: 'button', class: 'btn small', onclick: function () { duplicateEvent(ev); } }, '复制'),
            h('button', { type: 'button', class: 'btn small', onclick: function () { deleteEvent(ev); } }, '删除'))));
      })) : h('p', { class: 'empty' }, '事件库为空。可以新建、导入，或复制下方的演示模板。'),
      h('details', { class: 'card inset' },
        h('summary', null, h('b', null, '演示模板'), ' ', chip('演示', 'demo'), h('span', { class: 'muted small' }, ' 明确标记为演示，不是用户确认的正式内容')),
        DEMO_EVENTS.map(function (raw) {
          return h('div', { class: 'row between' }, h('span', null, raw.name + '：' + raw.body), h('button', {
            type: 'button', class: 'btn small', onclick: function () {
              commit('复制演示事件', function (s) {
                var ev = demoEvent(raw);
                ev.isDraft = true;
                s.events.push(ev);
                log(s, '复制演示事件到事件库：' + ev.name, true);
              });
            }
          }, '复制到事件库'));
        })),
      h('details', null, h('summary', null, '导入格式说明'),
        h('pre', { class: 'code' }, '{\n  "kind": "shelter-events",\n  "schemaVersion": 1,\n  "events": [{\n    "name": "停电的售货机", "location": "地下通道", "tags": ["售货机"],\n    "body": "正文……", "isDraft": true, "participants": "1～2人", "carryTicks": 2,\n    "conditions": "", "itemUses": "", "modifiers": "",\n    "options": [{ "label": "参与", "outcomes": [\n      { "text": "得到两瓶水", "probability": 60,\n        "effects": { "rescue": null, "pool": [{ "defId": "water", "qty": 2 }],\n                     "personal": { "target": "参与者", "hp": -1, "items": [] } } }\n    ] }]\n  }]\n}\n（也可以直接导入事件数组。carryTicks 以半格计：2 = 1 单位。）')));
  }

  function importEvents(text) {
    var data;
    try { data = JSON.parse(text); } catch (e) { U.modal({ title: '导入失败', body: h('p', null, '不是有效的 JSON：' + e.message) }); return; }
    var list = Array.isArray(data) ? data : data && Array.isArray(data.events) ? data.events : null;
    if (!list) { U.modal({ title: '导入失败', body: h('p', null, '没有找到 events 数组。事件库未改动。') }); return; }
    var ids = state.events.map(function (e) { return e.id; });
    var normalized = list.map(function (raw) {
      var ev = C.normalizeEvent(raw, ids);
      ids.push(ev.id);
      return ev;
    });
    var problems = [];
    normalized.forEach(function (ev, i) { C.validateEvent(ev).forEach(function (p) { problems.push('第' + (i + 1) + '个事件：' + p); }); });
    U.modal({
      title: '导入 ' + normalized.length + ' 个事件？',
      body: h('div', { class: 'stack' }, h('p', null, normalized.map(function (e) { return e.name || '（未命名）'; }).join('、')),
        problems.length ? h('div', { class: 'callout risk' }, '有待补全的地方（仍可导入，之后编辑）：', h('ul', null, problems.slice(0, 8).map(function (p) { return h('li', null, p); }))) : null),
      actions: [{ label: '取消', value: false }, { label: '导入', kind: 'primary', value: true }]
    }).then(function (ok) {
      if (!ok) return;
      commit('导入事件', function (s) {
        normalized.forEach(function (ev) { s.events.push(ev); });
        log(s, '导入事件 ' + normalized.length + ' 个', true);
      });
    });
  }

  function editEvent(ev) {
    openEventEditor(ev, ev ? '编辑事件' : '新建事件').then(function (draft) {
      if (!draft) return;
      delete draft.__saveToLibrary;
      commit('保存事件', function (s) {
        var idx = s.events.findIndex(function (e) { return e.id === draft.id; });
        if (idx >= 0) s.events[idx] = draft;
        else s.events.push(draft);
        log(s, (idx >= 0 ? '修改事件：' : '新建事件：') + draft.name, true);
      });
    });
  }

  function duplicateEvent(ev) {
    commit('复制事件', function (s) {
      var copy = C.normalizeEvent(C.clone(ev), s.events.map(function (e) { return e.id; }));
      copy.id = C.uid('ev');
      copy.name = ev.name + '（副本）';
      s.events.push(copy);
      log(s, '复制事件：' + ev.name, true);
    });
  }

  function deleteEvent(ev) {
    U.confirmBox('删除事件？', '删除「' + (ev.name || '未命名') + '」。已结算的记录不受影响。', '删除', 'danger').then(function (ok) {
      if (!ok) return;
      commit('删除事件', function (s) {
        s.events = s.events.filter(function (e) { return e.id !== ev.id; });
        log(s, '删除事件：' + ev.name, true);
      });
    });
  }

  /** 事件编辑器：在草稿上编辑，保存时才写回存档。 */
  function openEventEditor(ev, title) {
    var draft = C.normalizeEvent(C.clone(ev || C.newEvent()));
    if (ev) draft.id = ev.id;
    var adHoc = title === '临时录入事件';
    var saveToLib = { on: false };
    var container = h('div', { class: 'event-editor' });

    function rerender() {
      U.clear(container).appendChild(body());
    }

    function itemsInput(target, key, placeholder) {
      var el = h('input', { type: 'text', value: C.formatItemList(target[key] || [], state.customItems, true), placeholder: placeholder });
      el.addEventListener('change', function () {
        var parsed = C.parseItemList(el.value, state.customItems);
        if (parsed.errors.length) { U.toast(parsed.errors[0], 'warn'); el.value = C.formatItemList(target[key] || [], state.customItems, true); return; }
        target[key] = parsed.items;
      });
      return el;
    }

    function tagsInput() {
      var el = h('input', { type: 'text', value: draft.tags.join('，'), placeholder: '例如：售货机，营救' });
      el.addEventListener('input', function () { draft.tags = el.value.split(/[，,]/).map(function (s) { return s.trim(); }).filter(Boolean); });
      return el;
    }

    function carryInput() {
      var el = h('input', { type: 'number', min: 0, step: 0.5, class: 'num', value: draft.carryTicks == null ? '' : draft.carryTicks / 2, placeholder: '空' });
      el.addEventListener('change', function () {
        var n = U.parseNumber(el.value, true);
        if (Number.isNaN(n) || (n != null && (n < 0 || Math.round(n * 2) !== n * 2))) { U.toast('携带容量需为 0.5 的倍数或留空', 'warn'); return; }
        draft.carryTicks = n == null ? null : Math.round(n * 2);
      });
      return el;
    }

    function outcomeEditor(op, oc, ci) {
      var fx = oc.effects;
      return h('div', { class: 'outcome' },
        h('div', { class: 'row between' }, h('b', null, '结果 ' + (ci + 1)),
          h('button', { type: 'button', class: 'btn small', disabled: op.outcomes.length < 2, onclick: function () { op.outcomes.splice(ci, 1); rerender(); } }, '删除结果')),
        h('div', { class: 'row' }, U.field('概率 %（留空＝待定）', bindNum(oc, 'probability', { after: rerender }))),
        U.field('结果文字（公布用）', bindArea(oc, 'text', 2)),
        h('details', null, h('summary', null, '效果（营救、公共池、个人通知）'),
          h('div', { class: 'grid2' },
            U.field('营救进度 ±', bindNum(fx, 'rescue')),
            U.field('公共池增减', itemsInput(fx, 'pool', '例如：面包+2，子弹-1'))),
          h('div', { class: 'grid3' },
            U.field('个人效果对象', bindText(fx.personal, 'target', { placeholder: '例如：参与者' })),
            U.field('生命 ±', bindNum(fx.personal, 'hp')),
            U.field('饥饿值 ±', bindNum(fx.personal, 'hunger'))),
          h('div', { class: 'grid3' },
            U.field('口渴', bindText(fx.personal, 'thirst', { placeholder: '例如：口渴' })),
            U.field('状态', bindText(fx.personal, 'status', { placeholder: '例如：流血伤口' })),
            U.field('地图笔记 ±', bindNum(fx.personal, 'mapNotes'))),
          U.field('个人物品增减（只生成通知）', itemsInput(fx.personal, 'items', '例如：绷带+1')),
          U.field('其他说明', bindText(fx.personal, 'note'))));
    }

    function optionEditor(op, oi) {
      var st = C.probabilityStatus(op);
      return h('div', { class: 'card inset' },
        h('div', { class: 'row between' }, h('b', null, '选项 ' + String.fromCharCode(65 + oi)),
          h('button', { type: 'button', class: 'btn small', disabled: draft.options.length < 2, onclick: function () { draft.options.splice(oi, 1); rerender(); } }, '删除选项')),
        U.field('选项名称（Discord 投票项）', bindText(op, 'label')),
        h('p', { class: 'small ' + (st.complete ? 'ok-text' : 'risk-text') }, st.complete ? '概率合计100%：允许自动抽签' : '概率未完成（' + st.reason + '）：结算时改为手动录入结果'),
        op.outcomes.map(function (oc, ci) { return outcomeEditor(op, oc, ci); }),
        h('button', { type: 'button', class: 'btn small', onclick: function () { op.outcomes.push(C.newOutcome()); rerender(); } }, '+ 添加结果'));
    }

    function body() {
      return h('div', { class: 'stack' },
        h('div', { class: 'grid2' }, U.field('名称', bindText(draft, 'name')), U.field('地点', bindText(draft, 'location'))),
        U.field('正文（公开展示）', bindArea(draft, 'body', 3)),
        h('div', { class: 'grid2' }, U.field('标签（逗号分隔）', tagsInput()), U.field('参与人数／对象', bindText(draft, 'participants'))),
        h('div', { class: 'grid2' }, U.field('携带容量（单位，可空）', carryInput()), U.field('条件', bindText(draft, 'conditions'))),
        U.field('物品用途', bindText(draft, 'itemUses')),
        U.field('修正（道具、饥饿状态、力量的影响；未定义时主持人裁定）', bindArea(draft, 'modifiers', 2)),
        h('label', { class: 'check' }, (function () {
          var box = h('input', { type: 'checkbox', checked: draft.isDraft, onchange: function () { draft.isDraft = box.checked; } });
          return box;
        })(), '草案（不参与「从事件库随机」）'),
        adHoc ? h('label', { class: 'check' }, (function () {
          var box = h('input', { type: 'checkbox', onchange: function () { saveToLib.on = box.checked; } });
          return box;
        })(), '同时存入事件库') : null,
        draft.options.map(optionEditor),
        h('button', { type: 'button', class: 'btn', onclick: function () { draft.options.push(C.newOption('新选项')); rerender(); } }, '+ 添加选项'));
    }

    rerender();
    return U.modal({
      title: title,
      wide: true,
      sticky: true,
      body: container,
      actions: [
        { label: '取消', value: null },
        {
          label: adHoc ? '使用这个事件' : '保存', kind: 'primary',
          validate: function () { var issues = C.validateEvent(draft); return issues.length ? issues[0] : ''; },
          value: function () {
            if (adHoc) draft.__saveToLibrary = saveToLib.on;
            return draft;
          }
        }
      ]
    });
  }

  // ================================================================ 记录与结算

  function renderRecords() {
    return h('div', { class: 'stack' },
      h('div', { class: 'grid2' }, rescueCard(), h('section', { class: 'card' }, h('div', { class: 'card-head' }, h('h2', null, '结果日志（公开）')), feedList(false))),
      gate('scores', '玩家分数、爱恨与私信记录', function () {
        return h('div', { class: 'stack' }, scoresCard(), settleCard(), dmNotesCard());
      }));
  }

  function scoreRow(id) {
    var row = state.scores[id] || {};
    return row;
  }

  function computedWealth(id) {
    var row = scoreRow(id);
    if (C.isNum(row.wealthOverride)) return { score: row.wealthOverride, text: '主持人裁定' };
    if (!isAlive(id)) return { score: 0, text: '死亡后不保留财富分' };
    if (row.cash == null && row.painting == null && row.jewel == null) return { score: null, text: '未上报' };
    return C.wealthScore({ cash: row.cash || 0, painting: row.painting || 0, jewel: row.jewel || 0 }, false);
  }

  function rowTotal(id) {
    var row = scoreRow(id);
    var w = computedWealth(id);
    return C.settlementTotal({ wealth: w.score, map: row.map, loveHate: row.loveHate, survival: row.survival, task: row.task, adjust: row.adjust });
  }

  function scoreInput(id, key) {
    var row = scoreRow(id);
    var el = h('input', { type: 'number', step: 'any', class: 'num', value: row[key] == null ? '' : row[key], placeholder: '待填', 'aria-label': key });
    el.addEventListener('change', function () {
      var n = U.parseNumber(el.value, true);
      if (Number.isNaN(n)) { U.toast('请输入数字或留空', 'warn'); el.value = row[key] == null ? '' : row[key]; return; }
      if ((key === 'cash' || key === 'painting' || key === 'jewel') && n != null && (!C.isInt(n) || n < 0)) { U.toast('件数需为非负整数', 'warn'); el.value = row[key] == null ? '' : row[key]; return; }
      commit('录入分数', function (s) {
        s.scores[id] = Object.assign({}, s.scores[id] || {});
        s.scores[id][key] = n;
        log(s, '分数：' + nameOf(id) + ' ' + key + ' = ' + (n == null ? '空' : n), true);
      }, { undo: true });
    });
    return el;
  }

  function scoresCard() {
    var rules = state.rules;
    return h('section', { class: 'card' },
      h('div', { class: 'card-head' }, h('h2', null, '玩家上报分数')),
      h('p', { class: 'section-note' }, '财富基础分＝钞票×1＋名画×6＋珠宝查表（1～5件：1、4、8、11、15；超过5件需主持人计分）；死亡后不保留财富分。地图分、爱恨分、生存分、任务分为手动项：留空＝待定，不当作0分。' +
        '规则值：生存 ' + (rules.scoreSurvival == null ? '待配置' : rules.scoreSurvival) + '、爱 ' + (rules.scoreLove == null ? '待配置' : rules.scoreLove) + '、恨 ' + (rules.scoreHate == null ? '待配置' : rules.scoreHate) + '、任务奖励 ' + (rules.scoreTaskReward == null ? '待配置' : rules.scoreTaskReward) + '。'),
      state.players.length ? h('div', { class: 'table-wrap' }, h('table', { class: 'tbl scores' },
        h('thead', null, h('tr', null, ['玩家', '钞票', '名画', '珠宝', '财富分', '财富裁定', '地图分', '爱恨分', '生存分', '任务分', '裁定调整', '合计'].map(function (t) { return h('th', null, t); }))),
        h('tbody', null, state.players.map(function (p) {
          var w = computedWealth(p.id);
          var tot = rowTotal(p.id);
          return h('tr', null,
            h('td', null, p.name, p.alive === false ? chip('已死亡', 'danger') : null),
            h('td', null, scoreInput(p.id, 'cash')), h('td', null, scoreInput(p.id, 'painting')), h('td', null, scoreInput(p.id, 'jewel')),
            h('td', null, w.score == null ? h('span', { class: 'pending-tag' }, w.text || '待定') : String(w.score), w.score != null && w.text ? h('div', { class: 'muted small' }, w.text) : null),
            h('td', null, scoreInput(p.id, 'wealthOverride')),
            h('td', null, scoreInput(p.id, 'map')), h('td', null, scoreInput(p.id, 'loveHate')), h('td', null, scoreInput(p.id, 'survival')),
            h('td', null, scoreInput(p.id, 'task')), h('td', null, scoreInput(p.id, 'adjust')),
            h('td', null, h('b', null, String(tot.total)), tot.partial ? h('div', { class: 'pending-tag' }, '部分分数／待裁定') : null));
        })))) : h('p', { class: 'empty' }, '还没有玩家。'),
      h('p', { class: 'muted small' }, '地图分：转移后笔记归属、损坏后分数及死亡后的地图分数由主持人裁定，不并入死亡即清零的财富类别。'));
  }

  function settleCard() {
    var st = state.settlement;
    return h('section', { class: 'card' },
      h('div', { class: 'card-head' }, h('h2', null, '主持人结算')),
      h('p', { class: 'section-note' }, '营救阈值未知时不会自动结束。点击结算会保存当前分数快照；存在未定项时显示「部分分数／待裁定」，不会显示为完整最终排名。'),
      h('button', {
        type: 'button', class: 'btn primary', disabled: !state.players.length, onclick: function () {
          commit('主持人结算', function (s) {
            var rows = s.players.map(function (p) {
              var t = rowTotal(p.id);
              return { playerId: p.id, name: p.name, alive: p.alive !== false, total: t.total, partial: t.partial, missing: t.missing };
            });
            rows.sort(function (a, b) { return b.total - a.total; });
            s.settlement = { at: Date.now(), day: s.day, rescue: s.rescueProgress, rows: rows, partial: rows.some(function (r) { return r.partial; }) };
            log(s, '主持人结算' + (s.settlement.partial ? '（部分分数／待裁定）' : ''), true);
          });
        }
      }, '结算（保存分数快照）'),
      st ? h('div', { class: 'stack' },
        h('h3', null, st.partial ? '部分分数／待裁定（不是最终排名）' : '最终排名', h('span', { class: 'muted small' }, ' · 第' + st.day + '天 · 营救进度 ' + st.rescue)),
        h('ol', { class: st.partial ? 'plain-ol' : '' }, st.rows.map(function (r) {
          return h('li', null, r.name + '：' + r.total + ' 分' + (r.alive ? '' : '（已死亡）') + (r.partial ? '（待定：' + r.missing.join('、') + '）' : ''));
        })),
        h('button', {
          type: 'button', class: 'btn', onclick: function () {
            commit('公布结算', function (s) {
              var st2 = s.settlement;
              publish(s, 'settle', (st2.partial ? '结算（部分分数／待裁定）：' : '最终结算：') + st2.rows.map(function (r) { return r.name + ' ' + r.total + (r.partial ? '*' : ''); }).join('，') + (st2.partial ? '（*含待定项）' : ''));
              log(s, '公布结算');
            });
          }
        }, '公布到公开页')) : null);
  }

  function dmNotesCard() {
    var professions = [['', '未分配']].concat(C.PROFESSIONS.map(function (p) { return [p.id, p.name + '（草案）']; }));
    var tasks = [['', '未分配']].concat(C.TASKS.map(function (t) { return [t.id, t.name + '（草案）']; }));
    var people = [['', '未分配']].concat(state.players.map(function (p) { return [p.id, p.name]; }));
    return h('section', { class: 'card' },
      h('div', { class: 'card-head' }, h('h2', null, '私信分配记录')),
      h('p', { class: 'section-note' }, '爱恨由主持人私信分配，可以指向自己；是否可以重合尚未确定，不擅自禁止。职业与任务为草案' + (state.rules.professionsEnabled || state.rules.tasksEnabled ? '' : '（当前均未启用）') + '。玩家在自己的页面手动填写。'),
      state.players.map(function (p) {
        var note = state.dmNotes[p.id] || {};
        function set(key, v) {
          commit('私信记录', function (s) {
            s.dmNotes[p.id] = Object.assign({}, s.dmNotes[p.id] || {});
            s.dmNotes[p.id][key] = v || null;
            log(s, '私信记录：' + p.name + ' ' + key, true);
          });
        }
        var text = '【私信·身份】' + p.name + '：爱的人 ' + (note.love ? nameOf(note.love) : '（未分配）') + '；恨的人 ' + (note.hate ? nameOf(note.hate) : '（未分配）') +
          (note.professionId ? '；职业 ' + C.getProfession(note.professionId).name + '（草案）' : '') + (note.taskId ? '；秘密任务 ' + C.getTask(note.taskId).name + '（草案）' : '') + '。请在玩家页「身份」手动填写。';
        return h('div', { class: 'card inset' },
          h('div', { class: 'row' }, h('b', null, p.name),
            U.field('爱的人', U.select(people, note.love || '', function (v) { set('love', v); })),
            U.field('恨的人', U.select(people, note.hate || '', function (v) { set('hate', v); })),
            U.field('职业', U.select(professions, note.professionId || '', function (v) { set('professionId', v); })),
            U.field('秘密任务', U.select(tasks, note.taskId || '', function (v) { set('taskId', v); }))),
          h('details', null, h('summary', null, '私信文本'), U.copyBlock(text, { note: '暂停共享后私发' })));
      }));
  }

  // ================================================================ 日志

  function renderLog() {
    var pub = state.log.filter(function (l) { return !l.secret; });
    return h('div', { class: 'stack' },
      h('section', { class: 'card' },
        h('div', { class: 'card-head' }, h('h2', null, '公开日志'), h('span', { class: 'muted small' }, '不含秘密内容；跳阶段、回退与手动调整都在这里')),
        pub.length ? logList(pub.slice(0, 200)) : h('p', { class: 'empty' }, '暂无日志。')),
      gate('logs', '完整日志（含秘密）', function () {
        return h('section', { class: 'card' }, h('div', { class: 'card-head' }, h('h2', null, '完整日志')), logList(state.log.slice(0, 500)));
      }));
  }

  function logList(list) {
    return h('ul', { class: 'log-list' }, list.map(function (l) {
      return h('li', { class: l.secret ? 'secret' : '' },
        h('span', { class: 'log-meta' }, U.fmtTime(l.at) + ' · ' + (l.day ? '第' + l.day + '天 ' : '') + C.phaseLabel(l.phase)),
        l.secret ? chip('秘密', '') : null, ' ', l.text);
    }));
  }

  // ================================================================ 设置与存档

  function renderSettings() {
    return h('div', { class: 'stack' }, playersCard(), rulesCard(), draftsCard(), customItemsCard(), dictionaryCard(), saveCard(), rulesPackCard());
  }

  function playersCard() {
    var nameInput = h('input', { type: 'text', placeholder: '玩家名字' });
    function add() {
      var name = nameInput.value.trim();
      if (!name) { U.toast('请输入名字', 'warn'); return; }
      commit('新增玩家', function (s) {
        var p = { id: C.uid('p'), name: name, alive: true };
        s.players.push(p);
        s.seatOrder.push(p.id);
        log(s, '新增玩家：' + name + '（加入座次末尾）');
      });
    }
    nameInput.addEventListener('keydown', function (e) { if (e.key === 'Enter') add(); });
    return h('section', { class: 'card' },
      h('div', { class: 'card-head' }, h('h2', null, '玩家名单'), h('span', { class: 'muted small' }, '计划 ' + state.rules.playerCount + ' 人；每人有稳定 ID，不以座位号当身份')),
      state.players.length ? h('ul', { class: 'list-plain' }, state.players.map(function (p) {
        var input = h('input', { type: 'text', value: p.name });
        input.addEventListener('change', function () {
          var v = input.value.trim();
          if (!v) { input.value = p.name; return; }
          commit('改名', function (s) { var x = s.players.find(function (y) { return y.id === p.id; }); log(s, '改名：' + x.name + ' → ' + v); x.name = v; });
        });
        return h('li', { class: 'row' },
          input,
          h('span', { class: 'muted small mono' }, p.id),
          h('label', { class: 'check' }, h('input', {
            type: 'checkbox', checked: p.alive === false, onchange: function (e) {
              var dead = e.target.checked;
              commit('存活状态', function (s) {
                var x = s.players.find(function (y) { return y.id === p.id; });
                x.alive = !dead;
                log(s, x.name + (dead ? ' 标记为死亡（座次、领取、守夜人数由主持人另行调整）' : ' 恢复为存活'));
              });
            }
          }), '已死亡'),
          h('button', {
            type: 'button', class: 'btn small', onclick: function () {
              U.confirmBox('删除玩家「' + p.name + '」？', '会从名单与座次移除。历史记录里会显示为「已删除的玩家」。若只是死亡，请勾选「已死亡」。', '删除', 'danger').then(function (ok) {
                if (!ok) return;
                commit('删除玩家', function (s) {
                  s.players = s.players.filter(function (x) { return x.id !== p.id; });
                  s.seatOrder = s.seatOrder.filter(function (x) { return x !== p.id; });
                  log(s, '删除玩家：' + p.name);
                });
              });
            }
          }, '删除'));
      })) : h('p', { class: 'empty' }, '还没有玩家。'),
      h('div', { class: 'row' }, nameInput, h('button', { type: 'button', class: 'btn primary', onclick: add }, '新增玩家'),
        h('button', {
          type: 'button', class: 'btn', disabled: state.players.length >= state.rules.playerCount, onclick: function () {
            commit('补足玩家', function (s) {
              for (var i = s.players.length; i < s.rules.playerCount; i++) {
                var p = { id: C.uid('p'), name: '玩家' + (i + 1), alive: true };
                s.players.push(p);
                s.seatOrder.push(p.id);
              }
              log(s, '按计划人数补足玩家：' + s.players.length + ' 人');
            });
          }
        }, '按计划人数补足')));
  }

  function ruleControl(f) {
    var v = state.rules[f.key];
    function set(nv) {
      commit('修改规则', function (s) {
        var old = s.rules[f.key];
        if (old === nv) return false;
        s.rules[f.key] = nv;
        log(s, '规则：' + f.label + ' ' + fmtRule(f, old) + ' → ' + fmtRule(f, nv));
      });
    }
    if (f.type === 'bool') return h('input', { type: 'checkbox', checked: !!v, onchange: function (e) { set(e.target.checked); } });
    if (f.type === 'select') return U.select([['', '未设置（' + C.PENDING_TEXT + '）']].concat(f.options), v || '', function (nv) { set(nv || null); });
    if (f.type === 'text') {
      var t = h('input', { type: 'text', value: v || '', placeholder: '待配置' });
      t.addEventListener('change', function () { set(t.value.trim() || null); });
      return t;
    }
    var units = f.type === 'units';
    var el = h('input', { type: 'number', class: 'num', step: units ? 0.5 : 1, value: v == null ? '' : units ? v / 2 : v, placeholder: '待配置' });
    el.addEventListener('change', function () {
      var n = U.parseNumber(el.value, units);
      if (n == null) {
        if (!f.nullable) { U.toast('该项不能留空', 'warn'); el.value = v == null ? '' : units ? v / 2 : v; return; }
        set(null);
        return;
      }
      if (Number.isNaN(n) || (units && Math.round(n * 2) !== n * 2) || (!units && !C.isInt(n)) || (f.min != null && n < f.min) || (f.max != null && n > f.max)) {
        U.toast(units ? '请输入 0.5 的倍数' : '请输入有效整数', 'warn');
        el.value = v == null ? '' : units ? v / 2 : v;
        return;
      }
      set(units ? Math.round(n * 2) : n);
    });
    return h('span', { class: 'row tight' }, el, units ? h('span', { class: 'muted small' }, '单位') : null);
  }

  function fmtRule(f, v) {
    if (v == null) return '待配置';
    if (f.type === 'units') return C.fmtUnits(v) + '单位';
    if (f.type === 'bool') return v ? '开' : '关';
    if (f.type === 'select') { var o = f.options.find(function (x) { return x[0] === v; }); return o ? o[1] : v; }
    return String(v);
  }

  function rulesCard() {
    return h('section', { class: 'card' },
      h('div', { class: 'card-head' }, h('h2', null, '规则配置'), h('span', { class: 'muted small' }, '暂定项必须可编辑；待定项留空＝「待配置／主持人裁定」，不会悄悄补值')),
      h('div', { class: 'rules-grid' }, C.RULE_FIELDS.filter(function (f) { return f.type !== 'bool'; }).map(function (f) {
        return h('div', { class: 'rule-row' },
          h('div', { class: 'rule-label' }, f.label, ' ', U.ruleBadge(f.status)),
          ruleControl(f),
          f.note ? h('div', { class: 'field-hint' }, f.note) : null);
      })),
      h('h3', null, '物品默认使用次数'),
      h('div', { class: 'rules-grid' }, C.ITEM_USE_FIELDS.map(function (f) {
        var v = state.rules.itemUses[f.key];
        var el = h('input', { type: 'number', class: 'num', min: 1, value: v == null ? '' : v, placeholder: '待配置' });
        el.addEventListener('change', function () {
          var n = U.parseNumber(el.value, false);
          if (Number.isNaN(n) || (n != null && n < 1)) { U.toast('请输入正整数或留空', 'warn'); el.value = v == null ? '' : v; return; }
          if (f.key === 'energy_bar' && n == null) { U.toast('能量棒使用3次是已确认规则，不能留空', 'warn'); el.value = v; return; }
          commit('修改使用次数', function (s) {
            var old = s.rules.itemUses[f.key];
            s.rules.itemUses[f.key] = n;
            log(s, '规则：' + f.label + ' ' + (old == null ? '待配置' : old) + ' → ' + (n == null ? '待配置' : n));
          });
        });
        return h('div', { class: 'rule-row' }, h('div', { class: 'rule-label' }, f.label, ' ', U.ruleBadge(f.status)), el);
      })));
  }

  function draftsCard() {
    var toggles = C.RULE_FIELDS.filter(function (f) { return f.type === 'bool'; });
    return h('section', { class: 'card' },
      h('div', { class: 'card-head' }, h('h2', null, '职业与秘密任务（草案）')),
      h('p', { class: 'section-note' }, '两端共享同一份内置列表与规则说明。默认停用，主持人明确启用后使用；职业与任务是独立开关。玩家页也有同样的开关，需由玩家按你的通知手动打开。'),
      h('div', { class: 'row' }, toggles.map(function (f) { return h('label', { class: 'check' }, ruleControl(f), f.label); })),
      h('div', { class: 'grid2' },
        h('div', null, h('h4', null, '职业草案'), h('ul', null, C.PROFESSIONS.map(function (p) { return h('li', null, h('b', null, p.name), '：' + p.text, h('span', { class: 'pending-tag' }, p.pending)); }))),
        h('div', null, h('h4', null, '秘密任务草案'), h('ul', null, C.TASKS.map(function (t) { return h('li', null, h('b', null, t.name), '：' + t.text); })),
          h('p', { class: 'muted small' }, '任务改为完成后统一固定奖励（奖励值待定）；完成即锁定还是结算时判断，按任务与配置处理。职业无专属分数。'),
          h('p', { class: 'muted small' }, '停用草案：' + C.RETIRED_DRAFTS.map(function (d) { return d.name + '——' + d.text; }).join('；')))),
      h('h4', null, '负面状态'),
      h('ul', null, C.STATUSES.map(function (st) {
        return h('li', null, h('b', null, st.name), ' ', U.ruleBadge(st.ruleStatus), ' ' + st.effectText, st.ruleStatus === 'draft' && !state.rules.draftStatusesEnabled ? h('span', { class: 'muted small' }, '（默认停用）') : null);
      })));
  }

  function customItemsCard() {
    var nameI = h('input', { type: 'text', placeholder: '物品名称' });
    var catSel = U.select(C.CATEGORIES.map(function (c) { return [c.id, c.name]; }), 'custom', function () {});
    var units = h('input', { type: 'number', class: 'num', min: 0, step: 0.5, value: 0.5 });
    var effect = h('input', { type: 'text', placeholder: '效果说明' });
    var toPool = h('input', { type: 'number', class: 'num', min: 0, value: 0, 'aria-label': '同时加入公共池的件数' });
    return h('section', { class: 'card' },
      h('div', { class: 'card-head' }, h('h2', null, '自定义物品')),
      h('p', { class: 'section-note' }, '支持主持人自定义物品。背包扩容只在概念阶段提过、没有具体数值，不内置为正式道具。玩家页也可以添加同名自定义物品，或导入你的规则包。'),
      state.customItems.length ? h('ul', { class: 'list-plain' }, state.customItems.map(function (d) {
        return h('li', { class: 'row between' }, h('span', { class: 'grow' }, h('b', null, d.name), ' · ' + (C.CATEGORIES.find(function (c) { return c.id === d.category; }) || {}).name + ' · 占' + C.fmtUnits(d.capacityTicks) + '单位 · ' + d.effectText),
          h('button', {
            type: 'button', class: 'btn small', onclick: function () {
              var used = state.pool.some(function (e) { return e.defId === d.id; });
              U.confirmBox('删除自定义物品？', used ? '公共池里还有这个物品，删除后会显示为「未知物品」。' : '删除「' + d.name + '」。', '删除', 'danger').then(function (ok) {
                if (ok) commit('删除自定义物品', function (s) { s.customItems = s.customItems.filter(function (x) { return x.id !== d.id; }); log(s, '删除自定义物品：' + d.name); });
              });
            }
          }, '删除'));
      })) : h('p', { class: 'empty' }, '暂无自定义物品。'),
      h('div', { class: 'row' }, nameI, catSel, h('span', { class: 'row tight' }, units, '单位'), effect,
        h('span', { class: 'row tight' }, '同时加入公共池', toPool, '件'),
        h('button', {
          type: 'button', class: 'btn primary', onclick: function () {
            var n = U.parseNumber(units.value, true);
            var count = parseInt(toPool.value, 10) || 0;
            var name = nameI.value.trim();
            var found = C.findDefByName(name, state.customItems);
            if (!name) { U.toast('请输入名称', 'warn'); return; }
            if (count < 0) { U.toast('件数不能是负数', 'warn'); return; }
            if (!found && (n == null || Number.isNaN(n) || n < 0 || Math.round(n * 2) !== n * 2)) { U.toast('占位需为 0.5 的倍数', 'warn'); return; }
            if (found && !count) { U.toast('已有同名物品「' + found.name + '」，不必重复创建；填写件数即可直接加入公共池', 'warn'); return; }
            commit('新增自定义物品', function (s) {
              var d = found;
              if (!d) {
                d = C.newCustomItem({ name: name, category: catSel.value, capacityTicks: Math.round(n * 2), effectText: effect.value });
                s.customItems.push(d);
                log(s, '新增自定义物品：' + d.name);
              }
              if (count) {
                C.addItem(s.pool, d.id, count, { customItems: s.customItems, rules: s.rules });
                log(s, '公共池加入：' + d.name + '×' + count, true);
              }
            });
          }
        }, '新增')));
  }

  function dictionaryCard() {
    return h('details', { class: 'card' },
      h('summary', null, h('b', null, '道具字典（内置）')),
      h('div', { class: 'table-wrap' }, h('table', { class: 'tbl' },
        h('thead', null, h('tr', null, h('th', null, 'ID'), h('th', null, '名称'), h('th', null, '占位'), h('th', null, '已确认效果'), h('th', null, '待定'))),
        h('tbody', null, C.ITEMS.map(function (d) {
          return h('tr', null, h('td', { class: 'mono small' }, d.id), h('td', null, d.name), h('td', null, C.fmtUnits(d.capacityTicks)), h('td', null, d.effectText),
            h('td', null, (d.pending || []).map(function (p) { return h('div', { class: 'pending-tag' }, p); })));
        })))));
  }

  // ---------------------------------------------------------------- 存档操作

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
      h('div', { class: 'card-head' }, h('h2', null, '存档'), store.available ? chip('自动保存到本机浏览器', 'ok') : chip('本地保存不可用：仅内存运行', 'danger')),
      h('p', { class: 'section-note' }, '主持人存档与玩家存档使用不同的命名空间，互不覆盖。导入前会校验结构并备份旧存档；导入失败不会改动当前存档。'),
      h('div', { class: 'row' },
        h('button', { type: 'button', class: 'btn primary', onclick: function () { U.downloadJSON('shelter-host-' + (slot === 'demo' ? 'demo-' : '') + U.stamp() + '.json', state); } }, '导出 JSON'),
        h('button', { type: 'button', class: 'btn', onclick: function () { U.copyText(JSON.stringify(state)).then(function (ok) { U.toast(ok ? '已复制存档 JSON' : '复制失败', ok ? 'ok' : 'warn'); }); } }, '复制 JSON'),
        h('button', { type: 'button', class: 'btn', onclick: function () { fileInput.click(); } }, '导入 JSON 文件'),
        h('button', { type: 'button', class: 'btn', onclick: pasteImport }, '粘贴导入'),
        h('button', { type: 'button', class: 'btn', onclick: undoLast, disabled: !undo.peek() }, U.icon('undo'), '撤销最近操作'),
        h('button', { type: 'button', class: 'btn danger', onclick: resetSave }, '重置存档'),
        fileInput),
      backups.length ? h('details', null, h('summary', null, '备份（' + backups.length + '）'), h('ul', { class: 'list-plain' }, backups.map(function (b, i) {
        return h('li', { class: 'row between' }, h('span', null, U.fmtTime(b.at) + ' · ' + (b.reason || '')), h('button', { type: 'button', class: 'btn small', onclick: function () { restoreBackup(i); } }, '恢复此备份'));
      }))) : null,
      h('div', { class: 'card inset' },
        h('h3', null, '演示存档'),
        h('p', { class: 'muted small' }, '演示存档使用独立的存储位置，载入、修改、清空都不会碰到正式存档。'),
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
    var v = C.validateSave(data, 'shelter-host');
    if (!v.ok) {
      U.modal({ title: '导入失败：当前存档未改动', body: h('ul', null, v.errors.slice(0, 10).map(function (e) { return h('li', null, e); })) });
      return;
    }
    U.confirmBox('导入存档？', '将用导入的存档替换当前' + (slot === 'demo' ? '演示' : '正式') + '存档。当前存档会先备份。', '导入').then(function (ok) {
      if (!ok) return;
      store.backup(JSON.stringify(state), '导入前自动备份');
      undo.push('导入存档', C.clone(state));
      state = C.normalizeSave(data, 'shelter-host');
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

  function restoreBackup(i) {
    var b = store.backups()[i];
    if (!b) return;
    importSave(b.raw);
  }

  function resetSave() {
    U.confirmBox('重置存档？', '会清空当前' + (slot === 'demo' ? '演示' : '正式') + '存档（先自动备份，可在「备份」恢复）。', '重置', 'danger').then(function (ok) {
      if (!ok) return;
      store.backup(JSON.stringify(state), '重置前自动备份');
      undo.push('重置存档', C.clone(state));
      state = slot === 'demo' ? buildDemoState() : C.newHostState();
      log(state, '重置存档');
      save();
      render();
    });
  }

  function switchSlot(next) {
    slot = next;
    U.writeKey(KEY_SLOT, next);
    undo.clear();
    ui.revealed = {};
    state = loadState();
    save();
    render();
  }

  function enterDemo() {
    switchSlot('demo');
    U.toast('已切换到演示存档（正式存档未改动）', 'ok');
  }

  function exitDemo() {
    switchSlot('main');
    U.toast('已返回正式存档', 'ok');
  }

  function clearDemo() {
    U.confirmBox('清空演示数据？', '只删除演示存档，正式存档不受影响。', '清空', 'danger').then(function (ok) {
      if (!ok) return;
      new U.Store(KEY_DEMO).remove();
      switchSlot('main');
      U.toast('演示数据已清空', 'ok');
    });
  }

  function rulesPackCard() {
    var pack = C.makeRulesPack(state, null);
    return h('details', { class: 'card' },
      h('summary', null, h('b', null, '规则包（发给玩家）')),
      h('p', { class: 'section-note' }, '只包含规则配置与自定义物品，不含任何秘密。玩家在自己页面的「存档」里粘贴导入。'),
      U.copyBlock(JSON.stringify(pack), { label: '复制规则包', rows: 3 }),
      h('button', { type: 'button', class: 'btn small', onclick: function () { U.downloadJSON('shelter-rules-' + U.stamp() + '.json', pack); } }, '下载规则包'));
  }

  // ================================================================ 启动

  function boot() {
    var tab = U.readKey(KEY_TAB);
    if (tab && TABS.some(function (t) { return t.id === tab; })) ui.tab = tab;
    state = loadState();
    save();
    render();
    setInterval(timerTick, 250);
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && ui.present && !document.querySelector('.overlay')) exitPresent();
    });
    document.addEventListener('fullscreenchange', function () {
      // 用浏览器自己的方式（Esc／F11）退出全屏时，一并退出展示模式
      if (!document.fullscreenElement && ui.present && ui.presentFs) exitPresent();
    });
    window.addEventListener('storage', function (e) {
      if (e.key === (slot === 'demo' ? KEY_DEMO : KEY_MAIN)) {
        notices.push({ kind: 'risk', text: '另一个标签页修改了同一份主持人存档。为避免互相覆盖，请只保留一个主持人标签页，然后刷新本页。' });
        render();
      }
    });
  }

  boot();
})();
