/*
 * 避难所 Playtest · 联机大厅
 *
 * 一个页面三种视图（按网址 # 切换）：首页（创建／加入入口 + 我的对局）、#join（邀请码 + 公开对局）、#game=<id>（房间）。
 * 没登录时显示登录／注册。数据都在服务器上：HTTP 接口做操作，Socket.IO 推送房间变化与在线状态。
 * 界面组件、配色和中英切换与主持人／玩家面板共用（base.css、ui.js、i18n.js）。
 * 用户名和对局标题是玩家输入的内容，用 raw() 原样写入，不经过翻译。
 */
(function () {
  'use strict';

  // 网址没有结尾斜杠时（如 /Misc/ShelterPT）补上，否则相对路径会落到上一级目录
  if (location.protocol !== 'file:' && !/\/$/.test(location.pathname) && !/\.html?$/.test(location.pathname)) {
    location.replace(location.pathname + '/' + location.search + location.hash);
    return;
  }

  var U = window.ShelterUI;
  var h = U.h;
  var PAGE_TITLE = '避难所 Playtest';
  // 接口与 Socket.IO 都按页面所在目录拼路径：本地是 /api、/socket.io，线上自动带上 /Misc/ShelterPT/
  var BASE = location.pathname.replace(/[^/]*$/, '');

  var ERRORS = {
    network: '连不上服务器，请稍后再试。',
    unauthorized: '登录已失效，请重新登录。',
    rate_limited: '尝试次数太多，请过几分钟再试。',
    bad_username: '用户名需要 3～20 个字符：中英文、数字、下划线。',
    bad_password: '密码至少 8 位。',
    username_taken: '这个用户名已经被注册了。',
    wrong_credentials: '用户名或密码不对。',
    bad_title: '对局名称需要 1～40 个字。',
    bad_max_seats: '人数上限需要在 1～12 之间。',
    bad_code: '没有找到这个邀请码。',
    game_full: '这局已经满员了。',
    no_open_seat: '这局已经开始，目前没有空出来的座位。',
    game_closed: '这局已经结束了。',
    not_found: '找不到这局对局，或者你已经不在其中。',
    owner_only: '只有主导能这样做。',
    bad_transition: '当前状态下不能这样做。',
    no_players: '至少要有一名玩家才能开始。',
    already_started: '对局已经开始，不能这样做了。',
    not_started: '对局还没开始。',
    use_host_plays: '主导自己的座位请用「参与扮演／只主持」切换。',
    owner_cannot_leave: '主导不能退出，可以删除对局。',
    already_open: '这个座位已经是空的。'
  };
  var STATUS = { lobby: ['info', '招募中'], active: ['ok', '进行中'], paused: ['warning', '已暂停'], finished: ['info', '已结束'] };
  var ROLE = { host: '主导', 'host-player': '主导兼角色', player: '玩家' };

  var me = null;
  var socket = null;
  var ui = { page: 'home', gameId: null, mine: null, open: null, game: null, code: '', authMode: 'login', authUser: '', authError: '' };

  function raw(s) { return document.createTextNode(String(s == null ? '' : s)); }
  // 「已结束」「加入」等词在主持人／玩家页另有译法，大厅里按语境 lobby 取词
  function statusBadge(s) { var v = STATUS[s] || STATUS.info; return U.sevBadge(v[0], U.TC('lobby', v[1])); }
  function presence(on) { return h('span', { class: 'presence' + (on ? ' on' : '') }, on ? '在线' : '离线'); }

  // ---------------------------------------------------------------- 接口

  function api(method, path, body) {
    return fetch(BASE + 'api/' + path, {
      method: method,
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
      credentials: 'same-origin'
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (data) {
        if (!r.ok) throw { code: data.error || 'http_' + r.status };
        return data;
      });
    }, function () { throw { code: 'network' }; });
  }

  function fail(e) {
    var code = (e && e.code) || 'unknown';
    U.toast(ERRORS[code] || '出错了：' + code, 'warn');
    if (code === 'unauthorized') signedOut();
  }

  // ---------------------------------------------------------------- 实时连接

  function connect() {
    if (socket || !window.io) return;
    socket = window.io({ path: BASE + 'socket.io' });
    socket.on('connect', function () { if (ui.page === 'room') watch(); });
    socket.on('games:changed', function () { if (ui.page === 'home') loadMine(); });
    socket.on('lobby:changed', function () { if (ui.page === 'join') loadOpen(); });
    socket.on('game:update', function (g) {
      if (ui.page === 'room' && g.id === ui.gameId) { ui.game = g; render(); }
    });
    socket.on('game:gone', function (msg) {
      if (ui.page === 'room' && msg.id === ui.gameId) { U.toast('你已经不在这局对局里了。', 'warn'); location.hash = ''; }
    });
    socket.on('connect_error', function (e) { if (e.message === 'unauthorized') signedOut(); });
  }

  function watch() {
    if (!socket) return;
    socket.emit('game:watch', ui.gameId, function (res) {
      if (res.error) { fail({ code: res.error }); location.hash = ''; return; }
      if (ui.page === 'room') { ui.game = res.game; render(); }
    });
  }

  function signedOut() {
    me = null;
    if (socket) { socket.disconnect(); socket = null; }
    render();
  }

  // ---------------------------------------------------------------- 导航与数据

  function route() {
    var m = /^#game=([\w-]+)$/.exec(location.hash);
    var prev = ui.page;
    ui.page = m ? 'room' : location.hash === '#join' ? 'join' : 'home';
    if (prev === 'room' && (!m || m[1] !== ui.gameId) && socket) socket.emit('game:unwatch');
    ui.gameId = m ? m[1] : null;
    if (!me) return render();
    if (ui.page === 'home') loadMine();
    if (ui.page === 'join') loadOpen();
    if (ui.page === 'room') { ui.game = null; watch(); }
    render();
    window.scrollTo(0, 0);
  }

  function loadMine() { api('GET', 'games').then(function (d) { ui.mine = d.games; if (ui.page === 'home') render(); }, fail); }
  function loadOpen() { api('GET', 'games/open').then(function (d) { ui.open = d.games; if (ui.page === 'join') render(); }, fail); }
  function enter(id) { location.hash = 'game=' + id; }

  // ---------------------------------------------------------------- 渲染

  function onLangChange() {
    document.title = U.T(PAGE_TITLE);
    render();
  }

  function render() {
    renderTop();
    var main = U.clear(document.getElementById('main'));
    if (!me) main.appendChild(renderAuth());
    else if (ui.page === 'join') renderJoin(main);
    else if (ui.page === 'room') renderRoom(main);
    else renderHome(main);
  }

  function renderTop() {
    var top = U.clear(document.getElementById('topbar'));
    top.appendChild(h('div', { class: 'l-top' },
      h('button', { type: 'button', class: 'l-brand', onclick: function () { location.hash = ''; } }, h('b', null, '避难所'), h('span', { class: 'brand-role badge' }, '联机大厅')),
      h('div', { class: 'l-top-tools' },
        me ? h('span', { class: 'l-user', title: me.id }, raw(me.username)) : null,
        U.langToggle(onLangChange),
        me ? h('button', { type: 'button', class: 'btn small', onclick: logout }, '退出登录') : null)));
  }

  function renderAuth() {
    var reg = ui.authMode === 'register';
    var user = h('input', { name: 'username', autocomplete: 'username', maxlength: 20, required: true, value: ui.authUser });
    var pass = h('input', { name: 'password', type: 'password', autocomplete: reg ? 'new-password' : 'current-password', maxlength: 200, required: true });
    var submit = h('button', { type: 'submit', class: 'btn primary big' }, reg ? '注册并登录' : '登录');
    var form = h('form', {
      novalidate: true,
      onsubmit: function (ev) {
        ev.preventDefault();
        submit.disabled = true;
        ui.authUser = user.value.trim();
        api('POST', reg ? 'register' : 'login', { username: ui.authUser, password: pass.value }).then(function (d) {
          ui.authError = '';
          me = d.user;
          connect();
          route();
        }, function (e) {
          ui.authError = ERRORS[e.code] || '出错了：' + e.code;
          render();
        });
      }
    },
      U.field('用户名', user, reg ? '3～20 个字符：中英文、数字、下划线。' : null),
      U.field('密码', pass, reg ? '至少 8 位。忘记密码请找管理员重置。' : null),
      ui.authError ? h('div', { class: 'callout danger', role: 'alert' }, ui.authError) : null,
      submit);
    return h('div', { class: 'l-hero auth' },
      h('div', { class: 'eyebrow' }, 'PLAYTEST · 联机'),
      h('h1', null, '避难所 Playtest'),
      h('section', { class: 'card' },
        U.segmented([['login', '登录'], ['register', '注册']], ui.authMode, function (v) { ui.authMode = v; ui.authError = ''; render(); }),
        form));
  }

  function renderHome(main) {
    main.appendChild(h('section', { class: 'l-hero' },
      h('div', { class: 'eyebrow' }, 'PLAYTEST · 规则测试工具'),
      h('h1', null, '避难所 Playtest'),
      h('p', { class: 'lead' }, '末日里，军方把身份各异的人安置进废弃城市的避难所，承诺撤离，然后失约。你们一边求生、一边争取营救，一边因为爱恨、财富和各自的秘密目标做出不同的选择。'),
      h('p', { class: 'quote' }, '军方热线目前忙音。请保持冷静，并清点你的面包。')));
    main.appendChild(h('div', { class: 'l-actions' },
      h('button', { type: 'button', class: 'entry', 'data-entry': 'create', onclick: createGame },
        h('span', { class: 'tag' }, '主导'),
        h('h2', null, '创建对局'),
        h('p', null, '开一局新的游戏：设定人数，选择自己只主持还是也扮演角色，然后把邀请码发给朋友。'),
        h('span', { class: 'go' }, '创建对局', U.icon('arrow'))),
      h('button', { type: 'button', class: 'entry', 'data-entry': 'join', onclick: function () { location.hash = 'join'; } },
        h('span', { class: 'tag' }, '玩家'),
        h('h2', null, '加入对局'),
        h('p', null, '输入朋友给的邀请码，或者在公开列表里挑一局还有空位的。'),
        h('span', { class: 'go' }, '去加入', U.icon('arrow')))));

    var list = ui.mine;
    main.appendChild(h('section', { class: 'card', id: 'my-games' },
      h('div', { class: 'card-head' }, h('h2', null, '我的对局'), list ? h('span', { class: 'muted small' }, list.length + ' 局') : null),
      !list ? h('p', { class: 'empty' }, '载入中…')
        : !list.length ? h('p', { class: 'empty' }, '还没有对局。创建一局，或者加入朋友的对局。')
          : h('ul', { class: 'game-list' }, list.map(function (g) {
            return h('li', { class: 'game-row' + (g.status === 'finished' ? ' closed' : ''), 'data-game': g.id },
              h('div', null,
                h('div', { class: 'game-title' }, raw(g.title)),
                h('div', { class: 'game-meta' },
                  statusBadge(g.status),
                  h('span', { class: 'badge' }, ROLE[g.role]),
                  h('span', null, '主导：', raw(g.owner.username)),
                  h('span', null, g.taken + '／' + g.maxSeats + ' 人'),
                  g.ownerDeleted ? h('span', null, '主导已删除这局') : null,
                  h('span', null, '更新于 ' + U.fmtTime(g.updatedAt)))),
              h('button', { type: 'button', class: 'btn primary', onclick: function () { enter(g.id); } }, U.TC('lobby', '进入')));
          }))));
  }

  function renderJoin(main) {
    var input = h('input', {
      class: 'code-input', maxlength: 6, value: ui.code, autocomplete: 'off', spellcheck: 'false', 'aria-label': '邀请码', placeholder: 'ABC234',
      oninput: function () { ui.code = input.value; }
    });
    main.appendChild(h('div', null, h('button', { type: 'button', class: 'btn ghost small', onclick: function () { location.hash = ''; } }, '← 返回大厅')));
    main.appendChild(h('section', { class: 'card' },
      h('div', { class: 'card-head' }, h('h2', null, '用邀请码加入')),
      h('form', {
        class: 'code-form',
        onsubmit: function (ev) {
          ev.preventDefault();
          api('POST', 'games/join', { code: input.value }).then(function (d) { ui.code = ''; enter(d.id); }, fail);
        }
      }, U.field('邀请码', input, '6 位，不分大小写'), h('button', { type: 'submit', class: 'btn primary' }, U.TC('lobby', '加入')))));

    var list = ui.open;
    main.appendChild(h('section', { class: 'card', id: 'open-games' },
      h('div', { class: 'card-head' },
        h('h2', null, '公开对局'),
        h('button', { type: 'button', class: 'btn small', onclick: loadOpen }, '刷新')),
      h('p', { class: 'section-note' }, '招募中的对局有空位就能加入；已经开始的对局只有被主导空出来的座位可以接手。'),
      !list ? h('p', { class: 'empty' }, '载入中…')
        : !list.length ? h('p', { class: 'empty' }, '现在没有可以加入的对局。')
          : h('ul', { class: 'game-list' }, list.map(function (g) {
            return h('li', { class: 'game-row', 'data-game': g.id },
              h('div', null,
                h('div', { class: 'game-title' }, raw(g.title)),
                h('div', { class: 'game-meta' },
                  statusBadge(g.status),
                  h('span', null, '主导：', raw(g.owner.username)),
                  h('span', null, g.taken + '／' + g.maxSeats + ' 人'),
                  h('span', { class: 'badge ok' }, '空位 ' + g.free))),
              h('button', {
                type: 'button', class: 'btn primary',
                onclick: function () { api('POST', 'games/' + g.id + '/join', {}).then(function (d) { enter(d.id); }, fail); }
              }, g.status === 'lobby' ? U.TC('lobby', '加入') : '接手空座位'));
          }))));
  }

  function renderRoom(main) {
    main.appendChild(h('div', null, h('button', { type: 'button', class: 'btn ghost small', onclick: function () { location.hash = ''; } }, '← 返回大厅')));
    var g = ui.game;
    if (!g) { main.appendChild(h('p', { class: 'empty' }, '载入中…')); return; }
    var isOwner = g.owner.id === me.id;
    var mySeat = g.seats.filter(function (s) { return s.user && s.user.id === me.id; })[0];
    var taken = g.seats.filter(function (s) { return s.user; }).length;
    var open = g.seats.length - taken;

    main.appendChild(h('section', { class: 'card' },
      h('div', { class: 'room-head' },
        h('div', null,
          h('h1', null, raw(g.title)),
          h('div', { class: 'room-sub' },
            statusBadge(g.status),
            h('span', null, '主导：', raw(g.owner.username)), presence(g.owner.online),
            h('span', null, taken + '／' + g.maxSeats + ' 人'))),
        g.status !== 'finished' ? h('div', { class: 'invite' },
          h('span', { class: 'muted small' }, '邀请码'),
          h('span', { class: 'invite-code', id: 'invite-code' }, g.code),
          h('button', {
            type: 'button', class: 'btn small',
            onclick: function () { U.copyText(g.code).then(function (ok) { U.toast(ok ? '邀请码已复制' : '复制失败，请手动抄写', ok ? 'ok' : 'warn'); }); }
          }, U.icon('copy'), '复制')) : null),
      h('div', { class: 'callout ' + (g.status === 'paused' ? 'risk' : 'info'), style: 'margin-top:12px' },
        g.ownerDeleted ? '主导已经删除了这局；记录保留，状态为已结束。'
          : g.status === 'lobby' ? '招募中：把邀请码发给朋友，或者让他们在「加入对局」的公开列表里找到这局。人齐后由主导开始。'
            : g.status === 'active' ? '对局进行中：从下面进入面板。存档保存在服务器上，换设备登录也能接着玩。'
              : g.status === 'paused' ? '已暂停：数据都保存在服务器上，面板现在只能查看。主导点「继续」后，大家回到原来的座位接着玩。'
                : '这局已经结束，面板只能查看。'),
      // 开局后才有面板存档：主导进主持人面板，有座位的进自己的玩家面板（主导兼角色两个都有）
      g.status !== 'lobby' && ((isOwner && !g.ownerDeleted) || mySeat) ? h('div', { class: 'room-actions', id: 'panels', style: 'margin-top:12px' },
        isOwner && !g.ownerDeleted ? h('a', { class: 'btn primary', href: 'host.html?game=' + encodeURIComponent(g.id) }, '进入主持人面板') : null,
        // 主导兼角色：玩家面板在新窗口打开，两个面板可以同时开着（存档和私信各归各的身份）
        mySeat ? h('a', Object.assign({ class: 'btn ' + (isOwner ? '' : 'primary'), href: 'player.html?game=' + encodeURIComponent(g.id) },
          isOwner ? { target: '_blank', rel: 'noopener' } : {}), '进入玩家面板') : null,
        isOwner && mySeat ? h('span', { class: 'muted small' }, '玩家面板会在新窗口打开，可以和主持人面板同时使用。') : null) : null));

    main.appendChild(h('section', { class: 'card', id: 'seats' },
      h('div', { class: 'card-head' }, h('h2', null, '座位'), open ? h('span', { class: 'badge ok' }, '空座位 ' + open) : null),
      !g.seats.length ? h('p', { class: 'empty' }, '还没有人入座。') : h('ul', { class: 'seat-list' }, g.seats.map(function (s) {
        var mine = s.user && s.user.id === me.id;
        return h('li', { class: 'seat' + (mine ? ' me' : '') + (s.user ? '' : ' open'), 'data-seat': s.seatNo },
          h('div', { class: 'seat-head' },
            h('span', { class: 'seat-no' }, String(s.seatNo)),
            h('span', { class: 'seat-name' }, s.user ? raw(s.user.username) : '空座位'),
            s.user ? presence(s.user.online) : null),
          h('div', { class: 'seat-foot' },
            s.user && s.user.id === g.owner.id ? h('span', { class: 'badge' }, '主导') : null,
            mine ? h('span', { class: 'badge ok' }, '你') : null,
            s.user ? null : h('span', { class: 'muted small' }, '座位上的数据保留，等新玩家接手'),
            isOwner ? seatAction(g, s) : null));
      }))));

    main.appendChild(renderControls(g, isOwner, mySeat));
  }

  function seatAction(g, s) {
    if (!s.user) return null;
    if (g.status === 'lobby' && s.user.id !== g.owner.id) {
      return h('button', {
        type: 'button', class: 'btn small danger',
        onclick: function () {
          U.confirmBox('移除玩家', [h('b', null, raw(s.user.username)), '：', '移出这局后，对方还可以用邀请码再加入。'], '移除', 'danger').then(function (ok) {
            if (ok) api('POST', 'games/' + g.id + '/seats/' + s.id, { action: 'remove' }).catch(fail);
          });
        }
      }, '移除');
    }
    if (g.status === 'active' || g.status === 'paused') {
      return h('button', {
        type: 'button', class: 'btn small risk',
        onclick: function () {
          U.confirmBox('释放座位', [h('b', null, raw(s.user.username)), '：', '座位上的资源、状态等数据都会保留，但这名玩家会失去这局的访问，座位开放给新玩家接手。'],
            '释放座位', 'risk').then(function (ok) {
            if (ok) api('POST', 'games/' + g.id + '/seats/' + s.id, { action: 'release' }).catch(fail);
          });
        }
      }, '释放座位');
    }
    return null;
  }

  function renderControls(g, isOwner, mySeat) {
    function status(next) { return api('POST', 'games/' + g.id + '/status', { status: next }).catch(fail); }
    var box = h('section', { class: 'card', id: 'controls' }, h('div', { class: 'card-head' }, h('h2', null, isOwner ? '主导操作' : '操作')));
    if (!isOwner) {
      box.appendChild(g.status === 'lobby'
        ? h('div', { class: 'room-actions' }, h('button', {
          type: 'button', class: 'btn danger',
          onclick: function () {
            U.confirmBox('退出对局', '退出后你的座位会空出来，之后还可以用邀请码再加入。', '退出', 'danger').then(function (ok) {
              if (ok) api('POST', 'games/' + g.id + '/leave', {}).then(function () { location.hash = ''; }, fail);
            });
          }
        }, '退出对局'))
        : h('p', { class: 'muted' }, g.status === 'finished' ? '这局已经结束，记录会一直保留。' : '开局后如果要离开，请联系主导释放你的座位。'));
      return box;
    }
    var row = h('div', { class: 'room-actions' });
    if (g.status === 'lobby') {
      row.appendChild(h('button', { type: 'button', class: 'btn primary', disabled: !g.seats.length, onclick: function () { status('active'); } }, '开始对局'));
    }
    if (g.status === 'active') row.appendChild(h('button', { type: 'button', class: 'btn risk', onclick: function () { status('paused'); } }, '暂停'));
    if (g.status === 'paused') row.appendChild(h('button', { type: 'button', class: 'btn primary', onclick: function () { status('active'); } }, U.TC('lobby', '继续')));
    if (g.status === 'active' || g.status === 'paused') {
      row.appendChild(h('button', {
        type: 'button', class: 'btn',
        onclick: function () {
          U.confirmBox('结束对局', '结束后不能再继续，记录会一直保留。', '结束对局', 'danger').then(function (ok) { if (ok) status('finished'); });
        }
      }, '结束对局'));
    }
    row.appendChild(h('button', {
      type: 'button', class: 'btn danger',
      onclick: function () {
        var text = g.status === 'lobby'
          ? '对局和所有座位都会被删除，无法恢复。'
          : '这局会从你的列表里移除并记为已结束。记录仍保存在服务器上，玩家还能查看。';
        U.confirmBox('删除对局', text, '删除', 'danger').then(function (ok) {
          if (ok) api('DELETE', 'games/' + g.id).then(function () { location.hash = ''; }, fail);
        });
      }
    }, '删除对局'));
    box.appendChild(row);
    if (g.status === 'lobby') {
      box.appendChild(h('div', { class: 'field', style: 'margin-top:14px' },
        h('span', { class: 'field-label' }, '我在这局里'),
        U.segmented([['play', '参与扮演'], ['host', '只主持']], mySeat ? 'play' : 'host', function (v) {
          api('POST', 'games/' + g.id + '/host-plays', { on: v === 'play' }).catch(fail);
        }),
        h('span', { class: 'field-hint' }, '开局后不能再切换。')));
    }
    return box;
  }

  // ---------------------------------------------------------------- 操作

  function createGame() {
    var title = h('input', { maxlength: 40, value: U.i18n.isEn() ? me.username + "'s game" : me.username + '的对局' });
    var seats = h('input', { type: 'number', class: 'num', min: 1, max: 12, value: 6 });
    var plays = 'play';
    var seg = h('div', null);
    function drawSeg() { U.clear(seg).appendChild(U.segmented([['play', '参与扮演'], ['host', '只主持']], plays, function (v) { plays = v; drawSeg(); })); }
    drawSeg();
    U.modal({
      title: '创建对局',
      body: [
        U.field('对局名称', title),
        U.field('人数上限', seats, '包括主导自己（如果参与扮演）。1～12，规则建议约 6 人。'),
        h('div', { class: 'field' }, h('span', { class: 'field-label' }, '我在这局里'), seg)
      ],
      actions: [
        { label: '取消', value: null },
        {
          label: '创建', kind: 'primary',
          validate: function () {
            var n = Number(seats.value);
            if (!title.value.trim()) return '请填写对局名称';
            if (!Number.isInteger(n) || n < 1 || n > 12) return '人数上限需要在 1～12 之间。';
            return null;
          },
          value: function () { return { title: title.value.trim(), maxSeats: Number(seats.value), hostPlays: plays === 'play' }; }
        }
      ]
    }).then(function (body) {
      if (body) api('POST', 'games', body).then(function (d) { enter(d.game.id); }, fail);
    });
  }

  function logout() {
    api('POST', 'logout', {}).then(signedOut, fail);
  }

  // ---------------------------------------------------------------- 启动

  document.title = U.T(PAGE_TITLE);
  window.addEventListener('hashchange', route);
  api('GET', 'me').then(function (d) {
    me = d.user;
    if (me) connect();
    route();
  }, function (e) { render(); fail(e); });
})();
