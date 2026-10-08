/*
 * 避难所 Playtest · 共享界面工具
 * DOM 构建、弹窗、提示、复制、导出，以及带降级提示的本地存档。
 * 用户输入一律以文本节点写入，不拼 innerHTML。
 */
(function (root) {
  'use strict';

  // ---------------------------------------------------------------- 语言

  /* 所有界面文字都经过 h() 写入，因此只在这里翻译一次（存档里的数据保持原样）。 */
  var I18N = root.ShelterI18n || { T: function (s) { return s; }, TC: function (c, s) { return s; }, isEn: function () { return false; }, getLang: function () { return 'zh'; }, setLang: function () {} };
  var T = I18N.T;
  var TRANSLATED_ATTRS = { placeholder: 1, title: 1, 'aria-label': 1, alt: 1 };

  // ---------------------------------------------------------------- DOM

  var PROPS = { value: 1, checked: 1, disabled: 1, selected: 1, htmlFor: 1, indeterminate: 1 };

  function h(tag, attrs) {
    var el = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        var v = attrs[k];
        if (v == null || v === false) return;
        if (k === 'class') el.className = v;
        else if (k.slice(0, 2) === 'on' && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
        else if (PROPS[k]) el[k] = v;
        else el.setAttribute(k, v === true ? '' : TRANSLATED_ATTRS[k] ? T(String(v)) : String(v));
      });
    }
    appendKids(el, Array.prototype.slice.call(arguments, 2));
    return el;
  }

  function appendKids(el, kids) {
    kids.forEach(function (c) {
      if (c == null || c === false || c === true) return;
      if (Array.isArray(c)) appendKids(el, c);
      else if (c instanceof Node) el.appendChild(c);
      else el.appendChild(document.createTextNode(T(String(c))));
    });
  }

  function clear(el) {
    while (el.firstChild) el.removeChild(el.firstChild);
    return el;
  }

  /* 常量 SVG 图标（不含任何用户数据，可安全写入）。 */
  var ICONS = {
    lock: '<path d="M7 10V7a5 5 0 0 1 10 0v3"/><rect x="5" y="10" width="14" height="10" rx="2"/>',
    unlock: '<path d="M7 10V7a5 5 0 0 1 9.6-1.9"/><rect x="5" y="10" width="14" height="10" rx="2"/>',
    eyeOff: '<path d="M3 3l18 18"/><path d="M10.6 6.1A9.8 9.8 0 0 1 12 6c5 0 9 6 9 6a17 17 0 0 1-3.2 3.7M6.6 7.6C4.4 9.1 3 12 3 12s4 6 9 6a8.6 8.6 0 0 0 4-1"/>',
    copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3"/>',
    undo: '<path d="M9 14L4 9l5-5"/><path d="M4 9h11a5 5 0 0 1 0 10h-3"/>',
    warn: '<path d="M12 3l10 18H2z"/><path d="M12 10v4M12 17.5v.5"/>',
    check: '<circle cx="12" cy="12" r="9"/><path d="M8 12.5l2.8 2.8L16.5 9.5"/>',
    stop: '<path d="M8.3 3h7.4L21 8.3v7.4L15.7 21H8.3L3 15.7V8.3z"/><path d="M12 7.5v5.5M12 16.5v.5"/>',
    info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.5v.5"/>',
    arrow: '<path d="M5 12h14M13 6l6 6-6 6"/>',
    expand: '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>',
    exitFull: '<path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5"/>',
    skill: '<path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z"/><path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z"/>',
    plan: '<rect x="6" y="4" width="12" height="17" rx="2"/><path d="M9 4h6v3H9zM9 11h6M9 15h4"/>',
    timer: '<circle cx="12" cy="13" r="8"/><path d="M12 9v4l2.5 2.5M9 2h6"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    minus: '<path d="M5 12h14"/>',
    dice: '<rect x="4" y="4" width="16" height="16" rx="3"/><circle cx="9" cy="9" r="1"/><circle cx="15" cy="15" r="1"/><circle cx="15" cy="9" r="1"/><circle cx="9" cy="15" r="1"/>'
  };

  function icon(name) {
    var span = document.createElement('span');
    span.className = 'icon';
    span.setAttribute('aria-hidden', 'true');
    span.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + (ICONS[name] || '') + '</svg>';
    return span;
  }

  function fmtTime(ts) {
    if (!ts) return '';
    var d = new Date(ts);
    function p(n) { return n < 10 ? '0' + n : String(n); }
    return p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
  }

  function fmtClock(ms) {
    var total = Math.max(0, Math.ceil(ms / 1000));
    var m = Math.floor(total / 60);
    var s = total % 60;
    return (m < 10 ? '0' + m : m) + ':' + (s < 10 ? '0' + s : s);
  }

  /** 数字输入：空字符串 → null（表示待配置），否则取整数／小数。 */
  function parseNumber(text, allowDecimal) {
    var t = String(text == null ? '' : text).trim();
    if (t === '') return null;
    var n = allowDecimal ? parseFloat(t) : parseInt(t, 10);
    return isFinite(n) ? n : NaN;
  }

  // ---------------------------------------------------------------- 提示与弹窗

  /* 提示里只放不含秘密的通用文字：隐藏时也不能通过通知泄露。 */
  function toast(message, kind) {
    var host = document.getElementById('toast');
    if (!host) return;
    var el = h('div', { class: 'toast ' + (kind || '') }, message);
    host.appendChild(el);
    setTimeout(function () { el.classList.add('out'); }, 3200);
    setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, 3700);
  }

  var modalStack = [];

  /**
   * 弹窗。body 可以是节点或文字；actions: [{label, value, kind}]。
   * 返回 Promise：点按钮得到 value，取消（Esc／点遮罩）得到 undefined。
   */
  function modal(opts) {
    return new Promise(function (resolve) {
      var rootEl = document.getElementById('modal-root') || document.body;
      var done = false;
      function close(value) {
        if (done) return;
        done = true;
        document.removeEventListener('keydown', onKey, true);
        if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
        modalStack.pop();
        resolve(value);
      }
      function onKey(e) {
        if (modalStack[modalStack.length - 1] !== overlay) return;
        if (e.key === 'Escape') { e.preventDefault(); close(undefined); }
      }
      var actions = (opts.actions || [{ label: '知道了', value: true, kind: 'primary' }]).map(function (a) {
        return h('button', {
          type: 'button',
          class: 'btn ' + (a.kind || ''),
          onclick: function () {
            if (a.validate) {
              var msg = a.validate();
              if (msg) { toast(msg, 'warn'); return; }
            }
            close(typeof a.value === 'function' ? a.value() : a.value);
          }
        }, a.label);
      });
      var dialog = h('div', { class: 'modal ' + (opts.wide ? 'wide' : ''), role: 'dialog', 'aria-modal': 'true', 'aria-label': opts.title || '对话框' },
        opts.title ? h('h3', { class: 'modal-title' }, opts.title) : null,
        h('div', { class: 'modal-body' }, opts.body || null),
        h('div', { class: 'modal-actions' }, actions));
      var overlay = h('div', { class: 'overlay', onclick: function (e) { if (e.target === overlay && !opts.sticky) close(undefined); } }, dialog);
      modalStack.push(overlay);
      rootEl.appendChild(overlay);
      document.addEventListener('keydown', onKey, true);
      var focusTarget = dialog.querySelector('[autofocus]') || dialog.querySelector('input, textarea, select') || actions[actions.length - 1];
      if (focusTarget) setTimeout(function () { focusTarget.focus(); }, 0);
    });
  }

  function confirmBox(title, text, okLabel, kind) {
    return modal({
      title: title,
      body: h('p', null, text),
      actions: [{ label: '取消', value: false }, { label: okLabel || '确定', value: true, kind: kind || 'primary' }]
    });
  }

  // ---------------------------------------------------------------- 复制与导出

  function fallbackCopy(text) {
    var ta = h('textarea', { class: 'offscreen', readonly: true });
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    var ok = false;
    try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
    document.body.removeChild(ta);
    return ok;
  }

  function copyText(text) {
    if (navigator.clipboard && root.isSecureContext) {
      return navigator.clipboard.writeText(text).then(function () { return true; }, function () { return fallbackCopy(text); });
    }
    return Promise.resolve(fallbackCopy(text));
  }

  /** 可复制的交接文本框：一律提醒「需要对方手动修改」，不假装跨端同步。 */
  function copyBlock(text, opts) {
    opts = opts || {};
    text = T(text); // 交接文本按当前语言生成，复制出去的就是看到的
    var ta = h('textarea', { class: 'copy-text', readonly: true, rows: opts.rows || Math.min(8, Math.max(2, text.split('\n').length + 1)) });
    ta.value = text;
    var btn = h('button', {
      type: 'button',
      class: 'btn small',
      onclick: function () {
        copyText(text).then(function (ok) {
          toast(ok ? '已复制，请粘贴到 Discord' : '复制失败，请手动全选复制', ok ? 'ok' : 'warn');
        });
      }
    }, icon('copy'), opts.label || '复制');
    return h('div', { class: 'copy-block' }, ta, h('div', { class: 'copy-row' }, btn, opts.note ? h('span', { class: 'muted small' }, opts.note) : null));
  }

  function downloadJSON(filename, obj) {
    var blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' });
    var url = URL.createObjectURL(blob);
    var a = h('a', { href: url, download: filename, class: 'offscreen' });
    document.body.appendChild(a);
    a.click();
    setTimeout(function () {
      URL.revokeObjectURL(url);
      if (a.parentNode) a.parentNode.removeChild(a);
    }, 1500);
  }

  function readFileText(file) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onload = function () { resolve(String(reader.result || '')); };
      reader.onerror = function () { reject(reader.error || new Error('读取文件失败')); };
      reader.readAsText(file, 'utf-8');
    });
  }

  function stamp() {
    var d = new Date();
    function p(n) { return n < 10 ? '0' + n : String(n); }
    return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes());
  }

  // ---------------------------------------------------------------- 本地存档

  function probeStorage() {
    try {
      var k = '__shelter_probe__';
      root.localStorage.setItem(k, '1');
      root.localStorage.removeItem(k);
      return true;
    } catch (e) {
      return false;
    }
  }

  /**
   * 一个命名空间下的存档。浏览器本地保存不可用时 available=false，
   * 页面仍可在内存中运行，并提示用户导出文件。
   */
  function Store(key) {
    this.key = key;
    this.available = probeStorage();
    this.lastError = null;
  }

  Store.prototype.read = function () {
    if (!this.available) return { status: 'unavailable' };
    var raw;
    try {
      raw = root.localStorage.getItem(this.key);
    } catch (e) {
      this.lastError = e;
      return { status: 'error', error: e };
    }
    if (raw == null) return { status: 'empty' };
    try {
      return { status: 'ok', data: JSON.parse(raw), raw: raw };
    } catch (e2) {
      return { status: 'corrupt', raw: raw, error: e2 };
    }
  };

  Store.prototype.write = function (obj) {
    if (!this.available) return false;
    try {
      root.localStorage.setItem(this.key, JSON.stringify(obj));
      this.lastError = null;
      return true;
    } catch (e) {
      this.lastError = e;
      return false;
    }
  };

  Store.prototype.remove = function () {
    if (!this.available) return;
    try { root.localStorage.removeItem(this.key); } catch (e) { this.lastError = e; }
  };

  /** 覆盖前把旧存档留一份（最多保留 5 份）。 */
  Store.prototype.backup = function (raw, reason) {
    if (!this.available || raw == null) return false;
    var key = this.key + ':backups';
    try {
      var list = JSON.parse(root.localStorage.getItem(key) || '[]');
      if (!Array.isArray(list)) list = [];
      list.unshift({ at: Date.now(), reason: reason || '', raw: typeof raw === 'string' ? raw : JSON.stringify(raw) });
      root.localStorage.setItem(key, JSON.stringify(list.slice(0, 5)));
      return true;
    } catch (e) {
      this.lastError = e;
      return false;
    }
  };

  Store.prototype.backups = function () {
    if (!this.available) return [];
    try {
      var list = JSON.parse(root.localStorage.getItem(this.key + ':backups') || '[]');
      return Array.isArray(list) ? list : [];
    } catch (e) {
      return [];
    }
  };

  function readKey(key) {
    try { return root.localStorage.getItem(key); } catch (e) { return null; }
  }

  function writeKey(key, value) {
    try { root.localStorage.setItem(key, value); return true; } catch (e) { return false; }
  }

  function removeKey(key) {
    try { root.localStorage.removeItem(key); } catch (e) { /* 忽略 */ }
  }

  // ---------------------------------------------------------------- 联机存档

  /**
   * 联机模式（网址带 ?game=<id>）：面板存档放在服务器上，主持人存档跟着对局，玩家存档跟着自己的座位。
   * kind：'host' | 'seat'。返回 Promise<ctx>：ctx.state 是载入的存档，ctx.store 与本地 Store 同接口（write 即保存），
   * ctx.game 是对局信息（随推送更新）。之后服务器那边的变化通过回调告诉页面：
   *   onState(state, reason, detail)  reason：device 另一台设备保存了｜conflict 本机保存时撞上了更新的版本｜
   *                                   rules 主持人更新了规则或名单（detail＝{rules, roster}）｜reload 服务器拒绝写入后重新载入
   *   onGame(game)   对局状态或座位变化（如暂停）
   *   onGone()       自己已经不在这局（座位被释放、对局被删除）
   *   onError(code)  保存失败（网络断开会自动重试）
   *   onPublic(view) 公开信息变化（玩家面板用；ctx.publicView 是最新的一份）
   *   onMessage(msg) 收到或发出了一条私信（ctx.inbox 里已经加上）
   *   onTransfer(t)  交接单新建或状态变化（ctx.transfers 里已经更新）
   * onState 的 reason 还可能是 transfer：服务端处理交接时改了这份存档（页面静默重载）
   * 同一时间只有一个保存请求在路上，期间的修改合并成最新一份再发。
   */
  function connectOnline(gameId, kind, handlers) {
    var base = location.pathname.replace(/[^/]*$/, '');
    var url = base + 'api/games/' + encodeURIComponent(gameId) + '/state/' + kind;
    var socket = null;
    var toastAt = 0;
    var store = { available: true, lastError: null, version: 0, pending: null, busy: false };
    var gameUrl = base + 'api/games/' + encodeURIComponent(gameId) + '/';
    var ctx = {
      store: store, game: null, state: null, publicView: null,
      // 私信：主持人面板以「主持人」身份收发，玩家面板以自己座位的身份收发
      inbox: { as: kind === 'host' ? 'host' : 'seat', me: null, messages: [], current: null, drafts: {}, focus: false },
      // 交接单：玩家看到和自己有关的，主持人看到全部
      transfers: [],
      readOnly: function () { return !ctx.game || ctx.game.status !== 'active'; },
      /** 只读时拦下修改并提示（提示最多 5 秒一次）。 */
      blocked: function () {
        if (!ctx.readOnly()) return false;
        if (Date.now() - toastAt > 5000) {
          toastAt = Date.now();
          toast(ctx.game && ctx.game.status === 'paused' ? '对局已暂停，现在只能查看' : '对局不在进行中，现在只能查看', 'warn');
        }
        return true;
      }
    };

    function getJSON(r) {
      return r.json().catch(function () { return {}; }).then(function (d) { return { ok: r.ok, d: d }; });
    }
    function call(method, path, body) {
      return fetch(gameUrl + path, {
        method: method, credentials: 'same-origin',
        headers: body ? { 'Content-Type': 'application/json' } : {},
        body: body ? JSON.stringify(body) : undefined
      }).then(getJSON, function () { throw { code: 'network' }; }).then(function (res) {
        if (!res.ok) throw { code: res.d.error || 'unknown' };
        return res.d;
      });
    }
    function addMessage(m) {
      var box = ctx.inbox;
      if (m.from !== box.me && m.to !== box.me) return false;
      if (box.messages.some(function (x) { return x.id === m.id; })) return false;
      box.messages.push(m);
      return true;
    }

    function upsertTransfer(t) {
      var i = ctx.transfers.findIndex(function (x) { return x.id === t.id; });
      if (i >= 0) ctx.transfers[i] = t; else ctx.transfers.push(t);
    }
    // 等本机的存档保存完，免得服务端改存档时和还在路上的保存撞版本
    function whenSaved() {
      return new Promise(function (resolve) {
        (function check() { if (!store.busy && store.pending == null) resolve(); else setTimeout(check, 50); })();
      });
    }
    /** 交接单操作（发起、接收、拒收、撤回）：path 相对 transfers/，body 自动带上身份。 */
    ctx.transfer = function (path, body) {
      return whenSaved().then(function () {
        return call('POST', 'transfers' + (path ? '/' + path : ''), Object.assign({ as: ctx.inbox.as }, body || {}));
      }).then(function (d) {
        upsertTransfer(d.transfer);
        if (handlers.onTransfer) handlers.onTransfer(d.transfer);
        return d.transfer;
      });
    };

    /** 发私信；成功后（推送到之前）就先放进收件箱。 */
    ctx.sendMessage = function (to, text) {
      return call('POST', 'messages', { as: ctx.inbox.as, to: to, text: text }).then(function (d) {
        if (addMessage(d.message)) handlers.onMessage(d.message);
        return d.message;
      });
    };
    /** 打开某个对话时把对方发来的标为已读（本地立即生效，服务器那边失败也不影响使用）。 */
    ctx.markRead = function (other) {
      var changed = false;
      ctx.inbox.messages.forEach(function (m) {
        if (m.to === ctx.inbox.me && m.from === other && !m.readAt) { m.readAt = Date.now(); changed = true; }
      });
      if (changed) call('POST', 'messages/read', { as: ctx.inbox.as, with: other }).catch(function () {});
      return changed;
    };
    /** 未读条数：不传 other 时是全部未读。 */
    ctx.unread = function (other) {
      return ctx.inbox.messages.filter(function (m) {
        return m.to === ctx.inbox.me && !m.readAt && (other == null || m.from === other);
      }).length;
    };
    function load() {
      return fetch(url, { credentials: 'same-origin' }).then(getJSON, function () { throw { code: 'network' }; }).then(function (res) {
        if (!res.ok) throw { code: res.d.error || 'unknown' };
        store.version = res.d.version;
        ctx.game = res.d.game;
        return res.d.state;
      });
    }

    store.write = function (obj) {
      store.pending = JSON.stringify(obj);
      flush();
      return true;
    };
    store.backup = function () { return false; };
    store.backups = function () { return []; };

    function flush() {
      if (store.busy || store.pending == null) return;
      var body = store.pending;
      store.pending = null;
      store.busy = true;
      fetch(url, {
        method: 'PUT', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
        body: '{"version":' + store.version + ',"from":' + JSON.stringify(socket ? socket.id : null) + ',"state":' + body + '}'
      }).then(getJSON).then(function (res) {
        store.busy = false;
        if (res.ok) { store.version = res.d.version; store.lastError = null; return flush(); }
        var code = res.d.error || 'unknown';
        store.pending = null;
        if (code === 'version_conflict') {
          store.version = res.d.version;
          handlers.onState(res.d.state, 'conflict');
        } else if (code === 'read_only') {
          load().then(function (s) { handlers.onState(s, 'reload'); handlers.onGame(ctx.game); }, function (e) { handlers.onError(e.code); });
        } else {
          store.lastError = { name: code };
          handlers.onError(code);
        }
      }, function () {
        // 网络断开：留着这份（若期间没有更新的）稍后重试
        store.busy = false;
        if (store.pending == null) store.pending = body;
        if (!store.lastError || store.lastError.name !== 'network') handlers.onError('network'); // 重试期间只提示一次
        store.lastError = { name: 'network' };
        setTimeout(flush, 3000);
      });
    }

    // 实时连接：订阅房间（状态、座位变化）和自己的存档推送。Socket.IO 客户端由服务端提供，按需加载
    function connectSocket() {
      var script = document.createElement('script');
      script.src = base + 'socket.io/socket.io.js';
      script.onload = function () {
        socket = root.io({ path: base + 'socket.io' });
        socket.on('connect', function () { socket.emit('game:watch', gameId); });
        socket.on('game:update', function (g) {
          if (g.id !== gameId) return;
          ctx.game = g;
          handlers.onGame(g);
        });
        socket.on('game:gone', function (m) { if (m.id === gameId) handlers.onGone(); });
        socket.on('public:update', function (m) {
          if (m.gameId !== gameId || kind !== 'seat') return;
          ctx.publicView = m.view;
          if (handlers.onPublic) handlers.onPublic(m.view);
        });
        socket.on('transfer:update', function (m) {
          if (m.gameId !== gameId) return;
          upsertTransfer(m.transfer);
          if (handlers.onTransfer) handlers.onTransfer(m.transfer);
        });
        socket.on('message:new', function (m) {
          if (m.gameId === gameId && addMessage(m.message) && handlers.onMessage) handlers.onMessage(m.message);
        });
        // 另一台设备读过了：这边也去掉未读
        socket.on('message:read', function (m) {
          if (m.gameId !== gameId || m.me !== ctx.inbox.me) return;
          ctx.inbox.messages.forEach(function (x) { if (x.to === m.me && x.from === m.with && !x.readAt) x.readAt = m.at; });
          if (handlers.onMessage) handlers.onMessage(null);
        });
        socket.on('state:update', function (m) {
          if (m.gameId !== gameId || m.kind !== kind || m.from === socket.id || m.version <= store.version) return;
          store.version = m.version;
          store.pending = null;
          handlers.onState(m.state, m.reason || 'device', m.detail);
        });
      };
      document.head.appendChild(script);
    }

    root.addEventListener('beforeunload', function (e) {
      if (store.busy || store.pending != null) { e.preventDefault(); e.returnValue = ''; }
    });

    return load().then(function (s) {
      ctx.state = s;
      return Promise.all([
        call('GET', 'messages?as=' + ctx.inbox.as),
        kind === 'seat' ? call('GET', 'public') : null,
        call('GET', 'transfers?as=' + ctx.inbox.as)
      ]);
    }).then(function (r) {
      ctx.inbox.me = r[0].me;
      ctx.inbox.messages = r[0].messages;
      if (r[1]) ctx.publicView = r[1].view;
      ctx.transfers = r[2].transfers;
      connectSocket();
      return ctx;
    });
  }

  /**
   * 私信界面（主持人面板与玩家面板共用）：左边联系人与未读数，右边对话与输入框。
   * 状态（当前对话、草稿）存在 ctx.inbox 里，页面整体重绘时不会丢。onChange：需要页面重绘时调用。
   */
  function messenger(ctx, onChange) {
    var box = ctx.inbox;
    var g = ctx.game;
    var contacts = [];
    if (box.me !== 'host' && !g.ownerDeleted) contacts.push({ id: 'host', name: g.owner.username, tag: '主持人' });
    g.seats.forEach(function (s) {
      if (s.id === box.me) return;
      contacts.push({ id: s.id, name: s.user ? s.user.username : null, tag: '座位 ' + s.seatNo });
    });
    // 只有历史私信、此刻已经不在名单上的对象（如主导删除了对局）也列出来，能看记录
    box.messages.forEach(function (m) {
      var other = m.from === box.me ? m.to : m.from;
      if (!contacts.some(function (c) { return c.id === other; })) contacts.push({ id: other, name: null, tag: other === 'host' ? '主持人' : '已离开的座位' });
    });
    // 默认打开最近有私信往来的对话，没有就打开第一个
    if (!box.current || !contacts.some(function (c) { return c.id === box.current; })) {
      var latest = box.messages[box.messages.length - 1];
      box.current = latest ? (latest.from === box.me ? latest.to : latest.from) : contacts.length ? contacts[0].id : null;
    }
    var current = contacts.filter(function (c) { return c.id === box.current; })[0];
    var thread = box.messages.filter(function (m) {
      return (m.from === box.me && m.to === box.current) || (m.to === box.me && m.from === box.current);
    });
    if (current && ctx.markRead(current.id)) setTimeout(onChange, 0);

    function label(c) {
      return [h('b', null, c.name ? document.createTextNode(c.name) : '（空座位）'), ' ', h('span', { class: 'muted small' }, c.tag)];
    }
    var input = h('textarea', { rows: 2, maxlength: 2000, placeholder: '输入私信…', 'aria-label': '私信内容', class: 'msg-input' });
    input.value = box.drafts[box.current] || '';
    input.addEventListener('input', function () { box.drafts[box.current] = input.value; });
    input.addEventListener('focus', function () { box.focus = true; });
    input.addEventListener('blur', function () { box.focus = false; });
    function send() {
      var text = input.value.trim();
      if (!text || !current) return;
      if (!current.name) { toast('这个座位现在没有人', 'warn'); return; }
      ctx.sendMessage(current.id, text).then(function () {
        box.drafts[current.id] = '';
        box.focus = true;
        onChange();
      }, function (e) { toast(MESSAGE_FAIL[e.code] || '发送失败：' + e.code, 'warn'); });
    }
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); }
    });
    // 重绘后把光标放回输入框，打字时收到新私信不会被打断
    if (box.focus) setTimeout(function () { if (input.isConnected) { input.focus(); input.selectionStart = input.selectionEnd = input.value.length; } }, 0);

    return h('div', { class: 'messenger' },
      h('ul', { class: 'msg-contacts', role: 'list' }, contacts.length ? contacts.map(function (c) {
        var n = ctx.unread(c.id);
        return h('li', null, h('button', {
          type: 'button', class: 'msg-contact' + (c.id === box.current ? ' on' : ''), 'data-contact': c.id,
          onclick: function () { box.current = c.id; onChange(); }
        }, label(c), n ? h('span', { class: 'badge danger msg-unread' }, String(n)) : null));
      }) : h('li', { class: 'empty' }, '这局里还没有别人。')),
      current ? h('div', { class: 'msg-thread' },
        h('div', { class: 'msg-head' }, label(current)),
        h('ol', { class: 'msg-list' }, thread.length ? thread.map(function (m) {
          return h('li', { class: 'msg' + (m.from === box.me ? ' mine' : '') },
            h('div', { class: 'msg-text' }, document.createTextNode(m.text)),
            h('div', { class: 'msg-meta' }, fmtTime(m.at)));
        }) : h('li', { class: 'empty' }, '还没有私信。')),
        ctx.game.status === 'finished' ? h('p', { class: 'muted small' }, '对局已结束，不能再发私信。') : h('div', { class: 'msg-compose' },
          input, h('button', { type: 'button', class: 'btn primary', onclick: send }, '发送'))) : null);
  }

  // ---------------------------------------------------------------- 交接单（联机）

  var TRANSFER_KIND = { gift: '赠予', trade: '交易', pool: '交公', scavenge: '搜刮交公', supply: '补给', opening: '开局领取', grant: '主持人发放' };
  var TRANSFER_STATUS = { pending: ['warning', '待确认'], accepted: ['ok', '已接收'], rejected: ['info', '已拒收'], cancelled: ['info', '已撤回'] };
  var TRANSFER_FAIL = {
    network: '连不上服务器，请稍后再试。',
    read_only: '对局不在进行中，现在不能处理交接。',
    not_enough: '数量不够。',
    in_loadout: '携带中的物品被锁定：先结束携带再转出。',
    wants_mismatch: '交出的物品和对方要的不一致。',
    already_resolved: '这张交接单已经处理过了。',
    no_recipient: '对方现在不在座位上。',
    already_sent: '这件补给已经发过了。'
  };
  function transferFail(e) { toast(TRANSFER_FAIL[e.code] || '交接失败：' + e.code + (e.detail ? '（' + e.detail + '）' : ''), 'warn'); }

  /** 交接单里身份的显示名：主持人、公共池或座位上的人。 */
  function partyName(ctx, who, asRecipient) {
    if (who === 'host') return asRecipient ? '公共池' : '主持人';
    var s = ctx.game.seats.filter(function (x) { return x.id === who; })[0];
    return s ? (s.user ? s.user.username : '座位 ' + s.seatNo) : '已离开的座位';
  }

  function transferItems(t, list, customItems) {
    var Core = root.ShelterCore;
    var defs = (customItems || []).concat(t.defs || []);
    return list.map(function (e) { return Core.describeEntry(e, defs); }).join('、');
  }

  /**
   * 交易时由接收方选出对方要的物品：普通物品自动按数量取；带实例的物品（能量棒、地图……）逐件勾选。
   * inventory：接收方的库存；locked：携带中被锁定的条目 id。返回 Promise<give 或 null>。
   */
  function pickForTrade(t, inventory, customItems, locked) {
    var Core = root.ShelterCore;
    var defs = (customItems || []).concat(t.defs || []);
    var rows = t.wants.map(function (w) {
      var def = Core.getDef(w.defId, defs);
      var pool = inventory.filter(function (e) { return e.defId === w.defId && locked.indexOf(e.id) < 0; });
      var have = pool.reduce(function (n, e) { return n + e.qty; }, 0);
      var checks = [];
      var node;
      if (have < w.qty) node = h('p', { class: 'callout danger' }, def.name + '：需要 ' + w.qty + '，你只有 ' + have);
      else if (Core.isStackable(def)) node = h('p', null, def.name + ' ×' + w.qty);
      else {
        node = h('div', { class: 'stack' }, h('b', null, def.name + '：选 ' + w.qty + ' 件'), pool.map(function (e, i) {
          var box = h('input', { type: 'checkbox', checked: i < w.qty });
          checks.push({ box: box, entry: e });
          return h('label', { class: 'check' }, box, Core.describeEntry(e, defs));
        }));
      }
      return { want: w, def: def, pool: pool, have: have, checks: checks, node: node };
    });
    return modal({
      title: '交易：交出对方要的物品',
      body: h('div', { class: 'stack' }, h('p', null, '收到：', transferItems(t, t.items, customItems)), h('p', null, h('b', null, '你需要交出：')), rows.map(function (r) { return r.node; })),
      actions: [
        { label: '取消', value: null },
        {
          label: '确认交易', kind: 'primary',
          validate: function () {
            for (var i = 0; i < rows.length; i++) {
              var r = rows[i];
              if (r.have < r.want.qty) return '物品不够，不能完成这笔交易';
              if (r.checks.length && r.checks.filter(function (c) { return c.box.checked; }).length !== r.want.qty) return r.def.name + '需要正好选 ' + r.want.qty + ' 件';
            }
            return '';
          },
          value: function () {
            var give = [];
            rows.forEach(function (r) {
              if (r.checks.length) { r.checks.forEach(function (c) { if (c.box.checked) give.push({ entryId: c.entry.id, qty: 1 }); }); return; }
              var need = r.want.qty;
              r.pool.forEach(function (e) { if (!need) return; var n = Math.min(need, e.qty); give.push({ entryId: e.id, qty: n }); need -= n; });
            });
            return give;
          }
        }
      ]
    });
  }

  /**
   * 交接卡片（主持人与玩家共用）：待我处理（接收／拒收）、我发出的（撤回），以及最近的记录。
   * opts：{ customItems, inventory, locked（携带锁定的 id）, onChange, ledger（主持人：显示全部记录）, title }
   */
  function transferCards(ctx, opts) {
    var me = ctx.inbox.me;
    var busy = false;
    function act(t, path, body) {
      if (busy) return;
      busy = true;
      ctx.transfer(t.id + '/' + path, body).then(function () { busy = false; opts.onChange(); }, function (e) { busy = false; transferFail(e); });
    }
    function line(t, actions) {
      var st = TRANSFER_STATUS[t.status];
      return h('li', { class: 'transfer', 'data-transfer': t.id },
        h('div', { class: 'transfer-head' },
          h('span', { class: 'badge' }, TRANSFER_KIND[t.kind] || t.kind),
          h('b', null, document.createTextNode(partyName(ctx, t.from, false))), ' → ', h('b', null, document.createTextNode(partyName(ctx, t.to, true))),
          sevBadge(st[0], st[1]),
          h('span', { class: 'muted small' }, fmtTime(t.at))),
        h('div', null, transferItems(t, t.items, opts.customItems),
          t.wants ? h('span', null, ' ⇄ 换取 ', root.ShelterCore.formatItemList(t.wants, (opts.customItems || []).concat(t.defs || []))) : null),
        t.given ? h('div', { class: 'muted small' }, '对方交出：', transferItems(t, t.given, opts.customItems)) : null,
        t.note ? h('div', { class: 'muted small' }, '附言：', document.createTextNode(t.note)) : null,
        actions ? h('div', { class: 'row' }, actions) : null);
    }
    var incoming = ctx.transfers.filter(function (t) { return t.status === 'pending' && t.to === me; });
    var outgoing = ctx.transfers.filter(function (t) { return t.status === 'pending' && t.from === me; });
    var done = ctx.transfers.filter(function (t) { return t.status !== 'pending' && (opts.ledger || t.from === me || t.to === me); }).slice().reverse();
    var others = opts.ledger ? ctx.transfers.filter(function (t) { return t.status === 'pending' && t.from !== me && t.to !== me; }) : [];
    return h('section', { class: 'card transfers', id: 'transfers' },
      h('div', { class: 'card-head' }, h('h2', null, opts.title || '交接'), incoming.length ? h('span', { class: 'badge danger' }, incoming.length + ' 件待你处理') : null),
      incoming.length ? h('div', null, h('h3', null, '待你处理'), h('ul', { class: 'list-plain' }, incoming.map(function (t) {
        return line(t, [
          h('button', {
            type: 'button', class: 'btn small primary', onclick: function () {
              if (!t.wants) return act(t, 'accept');
              pickForTrade(t, opts.inventory || [], opts.customItems, opts.locked || []).then(function (give) { if (give) act(t, 'accept', { give: give }); });
            }
          }, t.wants ? '交易…' : '接收'),
          h('button', { type: 'button', class: 'btn small', onclick: function () { act(t, 'reject'); } }, '拒收')
        ]);
      }))) : null,
      outgoing.length ? h('div', null, h('h3', null, '你发出的（等对方确认）'), h('ul', { class: 'list-plain' }, outgoing.map(function (t) {
        return line(t, [h('button', { type: 'button', class: 'btn small', onclick: function () { act(t, 'cancel'); } }, '撤回')]);
      }))) : null,
      others.length ? h('div', null, h('h3', null, '玩家之间待确认'), h('ul', { class: 'list-plain' }, others.map(function (t) { return line(t, null); }))) : null,
      !incoming.length && !outgoing.length && !others.length ? h('p', { class: 'empty' }, '没有待处理的交接。') : null,
      done.length ? h('details', { open: !!opts.ledger }, h('summary', null, (opts.ledger ? '全部记录' : '最近的记录') + '（' + done.length + '）'),
        h('ul', { class: 'list-plain' }, (opts.ledger ? done : done.slice(0, 20)).map(function (t) { return line(t, null); }))) : null);
  }

  var MESSAGE_FAIL = {
    network: '连不上服务器，请稍后再试。',
    no_recipient: '这个座位现在没有人。',
    game_closed: '对局已结束，不能再发私信。',
    bad_text: '私信需要 1～2000 个字。'
  };

  var ONLINE_RELOADED = {
    device: '另一台设备更新了存档：已载入最新',
    conflict: '服务器上的存档刚被更新：已载入最新，你最后一步操作没有保存，请重做',
    reload: '对局现在不能修改：已恢复为服务器上的存档'
  };
  var ONLINE_FAIL = {
    network: '连不上服务器，请稍后刷新重试。',
    unauthorized: '登录已失效：请回到大厅重新登录。',
    not_found: '找不到这局对局，或者你已经不在其中。',
    no_seat: '你在这局里没有座位。',
    not_started: '对局还没开始：主导在大厅点「开始对局」后才能进入面板。'
  };

  function onlineReloadedText(reason) { return ONLINE_RELOADED[reason] || '存档已更新'; }

  /** 联机面板顶部：对局名（玩家输入，原样显示）、是否只读、返回大厅。 */
  function onlineBanner(ctx) {
    var g = ctx.game;
    return h('div', { class: 'banner ' + (g.status === 'active' ? 'info' : 'risk') },
      h('span', { class: 'grow' },
        g.status === 'active' ? '联机对局：' : g.status === 'paused' ? '对局已暂停，现在只能查看：' : '对局不在进行中，现在只能查看：',
        document.createTextNode(g.title)),
      h('a', { class: 'btn small', href: 'index.html#game=' + g.id }, '返回大厅'));
  }

  function onlineFailCard(code) {
    return h('section', { class: 'card' },
      h('p', null, ONLINE_FAIL[code] || '载入失败：' + code),
      h('a', { class: 'btn primary', href: 'index.html' }, '返回大厅'));
  }

  // ---------------------------------------------------------------- 撤销

  /** 最近操作撤销：保存操作前的完整快照（内存中，最多 limit 步）。 */
  function UndoStack(limit) {
    this.items = [];
    this.limit = limit || 30;
  }

  UndoStack.prototype.push = function (label, snapshot) {
    this.items.push({ label: label, snapshot: snapshot, at: Date.now() });
    if (this.items.length > this.limit) this.items.shift();
  };

  UndoStack.prototype.pop = function () {
    return this.items.pop() || null;
  };

  UndoStack.prototype.peek = function () {
    return this.items.length ? this.items[this.items.length - 1] : null;
  };

  UndoStack.prototype.clear = function () {
    this.items = [];
  };

  // ---------------------------------------------------------------- 小组件

  /** 规则标记徽章：已确认／暂定／待定／实现建议／草案。 */
  function ruleBadge(status) {
    var names = { confirmed: '已确认', tentative: '暂定', pending: '待定', impl: '实现建议', draft: '草案', custom: '自定义', demo: '演示' };
    return h('span', { class: 'badge rule-' + status }, names[status] || status);
  }

  function pendingTag(text) {
    return h('span', { class: 'pending-tag' }, text || '待配置／主持人裁定');
  }

  /**
   * 只有单个输入框／下拉框才用 <label> 包裹。按钮组、步进器等放进 <label> 时，
   * 点击会被浏览器转发给 label 里的第一个按钮（重绘后尤其明显），所以改用带 aria-label 的分组。
   */
  function field(label, control, hint) {
    var single = control && control.nodeType === 1 && /^(INPUT|SELECT|TEXTAREA)$/.test(control.tagName);
    return h(single ? 'label' : 'div', { class: 'field', role: single ? null : 'group', 'aria-label': single ? null : label },
      h('span', { class: 'field-label' }, label), control, hint ? h('span', { class: 'field-hint' }, hint) : null);
  }

  function select(options, value, onchange, attrs) {
    var el = h('select', Object.assign({ onchange: function () { onchange(el.value); } }, attrs || {}),
      options.map(function (o) {
        var v = Array.isArray(o) ? o[0] : o.value;
        var t = Array.isArray(o) ? o[1] : o.label;
        return h('option', { value: v, selected: String(v) === String(value) }, t);
      }));
    return el;
  }

  /** 由 n 个按钮组成的单选组（状态同时显示文字）。 */
  function segmented(options, value, onchange, attrs) {
    return h('div', Object.assign({ class: 'segmented', role: 'group' }, attrs || {}), options.map(function (o) {
      var v = Array.isArray(o) ? o[0] : o;
      var t = Array.isArray(o) ? o[1] : o;
      return h('button', {
        type: 'button',
        class: 'seg ' + (v === value ? 'on' : ''),
        'aria-pressed': v === value ? 'true' : 'false',
        onclick: function () { onchange(v); }
      }, t);
    }));
  }

  function stepper(value, onchange, opts) {
    opts = opts || {};
    var input = h('input', { type: 'number', class: 'num', value: value == null ? '' : value, placeholder: opts.placeholder || '待配置', step: opts.step || 1, 'aria-label': opts.label || '数值' });
    input.addEventListener('change', function () {
      var n = parseNumber(input.value, opts.decimal);
      if (Number.isNaN(n)) { toast('请输入数字', 'warn'); input.value = value == null ? '' : value; return; }
      onchange(n);
    });
    return h('span', { class: 'stepper' },
      h('button', { type: 'button', class: 'btn icon-btn', 'aria-label': '减少', onclick: function () { onchange((value || 0) - (opts.delta || 1)); } }, icon('minus')),
      input,
      h('button', { type: 'button', class: 'btn icon-btn', 'aria-label': '增加', onclick: function () { onchange((value || 0) + (opts.delta || 1)); } }, icon('plus')));
  }

  // ---------------------------------------------------------------- 仪表盘部件（主持人与玩家共用）

  /* 状态一律「图标形状＋文字＋颜色」三重编码：橙与红在色觉差异下难以区分，颜色从不单独表达含义。 */
  var SEV = {
    ok: { cls: 'ok', icon: 'check', word: '正常' },
    info: { cls: 'info', icon: 'info', word: '提示' },
    warning: { cls: 'warn', icon: 'warn', word: '注意' },
    critical: { cls: 'crit', icon: 'stop', word: '危险' }
  };

  function sevBadge(level, word) {
    var sv = SEV[level] || SEV.info;
    return h('span', { class: 'sev sev-' + sv.cls }, icon(sv.icon), word || sv.word);
  }

  /** 进度条：填充色表示严重度，轨道是同一色相的浅色阶。 */
  function meter(value, max, level, label) {
    var pct = max > 0 ? Math.max(0, Math.min(100, (value / max) * 100)) : 0;
    return h('span', {
      class: 'meter2 m-' + (SEV[level] || SEV.ok).cls, role: 'meter', 'aria-label': label,
      'aria-valuemin': '0', 'aria-valuemax': String(max), 'aria-valuenow': String(value)
    }, h('span', { class: 'meter2-fill', style: 'width:' + pct + '%' }));
  }

  /** 指标卡：标签 · 状态徽章 · 数值（＋单位）· 可视化 · 说明。整张卡可点击跳转。 */
  function statTile(o) {
    return h(o.onclick ? 'button' : 'div', { type: o.onclick ? 'button' : null, class: 'tile ' + (o.cls || ''), 'data-tile': o.key, onclick: o.onclick || null },
      h('span', { class: 'tile-head' }, h('span', { class: 'tile-label' }, o.label), o.badge || null),
      h('span', { class: 'tile-value' }, o.value, o.unit ? h('span', { class: 'tile-unit' }, o.unit) : null),
      o.viz || null,
      o.sub ? h('span', { class: 'tile-sub' }, o.sub) : null);
  }

  /**
   * 演示存档在英文界面下用英文内容生成（名字、事件、笔记……）。
   * 规则判断要用的中文状态值（口渴、意识、饥饿状态）不翻译，否则逻辑比较会失效。
   */
  var KEEP_KEYS = { thirst: 1, consciousness: 1, hungerManual: 1 };
  function localizeDemo(obj) {
    if (!I18N.isEn()) return obj;
    (function walk(o) {
      Object.keys(o).forEach(function (k) {
        var v = o[k];
        if (typeof v === 'string') { if (!KEEP_KEYS[k]) o[k] = T(v); }
        else if (v && typeof v === 'object') walk(v);
      });
    })(obj);
    return obj;
  }

  /**
   * 守夜候选卡。t 来自 ShelterCore.watchCardText：{ title, who, tendency, tendencyKind, effects }。
   * opts: { label（①／②）, selected, onclick（可点选时整张卡是按钮）, id }
   */
  function watchCard(t, opts) {
    opts = opts || {};
    var clickable = typeof opts.onclick === 'function';
    return h(clickable ? 'button' : 'div', {
      type: clickable ? 'button' : null,
      class: 'watch-card' + (opts.selected ? ' on' : ''),
      'aria-pressed': clickable ? (opts.selected ? 'true' : 'false') : null,
      'data-watch-card': opts.id || null,
      onclick: clickable ? opts.onclick : null
    },
      h('span', { class: 'watch-card-head' },
        opts.label ? h('span', { class: 'watch-card-label' }, opts.label) : null,
        h('span', { class: 'watch-card-title' }, t.title),
        opts.selected ? h('span', { class: 'watch-card-picked' }, icon('check'), '已选') : null),
      h('span', { class: 'watch-card-who' }, t.who),
      t.tendency ? h('span', { class: 'watch-card-tend tend-' + t.tendencyKind }, t.tendency) : null,
      t.effects.length ? h('span', { class: 'watch-card-fx' }, t.effects.map(function (e) { return h('span', { class: 'fx' }, e); })) : null);
  }

  /**
   * 第2版守夜卡的卡面。face 来自 ShelterCore.watchCardFace。
   * 全员卡整张只写一句话；普通卡：正上方倾向句（可无）、中央人名、左下技能图标、右下计划图标。
   * opts.onclick 时整张卡是按钮（可选中）；选中标记放在卡面外，不改卡面内容。
   */
  function watchCardFace(face, opts) {
    opts = opts || {};
    var inner = face.all
      ? h('span', { class: 'wcard-all' }, face.text)
      : [
        h('span', { class: 'wcard-line' }, face.line || ''),
        h('span', { class: 'wcard-names' }, face.names.map(function (n) { return h('span', { class: 'wcard-name' }, n); })),
        h('span', { class: 'wcard-corners' },
          h('span', { class: 'wcard-corner left' }, face.skill ? [icon('skill'), h('span', null, face.skill)] : null),
          h('span', { class: 'wcard-corner right' }, face.plan ? [h('span', null, face.plan), icon('plan')] : null))
      ];
    var clickable = typeof opts.onclick === 'function';
    var card = h(clickable ? 'button' : 'div', {
      type: clickable ? 'button' : null,
      class: 'wcard' + (face.all ? ' is-all' : '') + (opts.selected ? ' on' : ''),
      'aria-pressed': clickable ? (opts.selected ? 'true' : 'false') : null,
      'data-wcard': opts.id || null,
      onclick: clickable ? opts.onclick : null
    }, inner);
    return h('div', { class: 'wcard-slot' }, card,
      opts.selected ? h('span', { class: 'wcard-picked' }, icon('check'), opts.pickedText || '已选这张') : (opts.caption ? h('span', { class: 'wcard-caption' }, opts.caption) : null));
  }

  /**
   * 一键重置：删除本机上以 prefixes 开头的所有本地数据（存档、演示、备份、页面设置），
   * 然后带上时间戳重新载入，绕开浏览器对旧页面的缓存。语言选择保留。
   */
  function wipeLocal(prefixes) {
    var removed = 0;
    try {
      var keys = [];
      for (var i = 0; i < root.localStorage.length; i++) keys.push(root.localStorage.key(i));
      keys.forEach(function (k) {
        if (k && prefixes.some(function (p) { return k.indexOf(p) === 0; })) { root.localStorage.removeItem(k); removed++; }
      });
    } catch (e) { /* 存储不可用时没有可删的 */ }
    try { root.sessionStorage.clear(); } catch (e) { /* 忽略 */ }
    try { if (root.caches && root.caches.keys) root.caches.keys().then(function (ks) { ks.forEach(function (k) { root.caches.delete(k); }); }); } catch (e) { /* 忽略 */ }
    return removed;
  }

  function reloadFresh() {
    var url = location.href.replace(/#.*$/, '').replace(/([?&])fresh=\d+&?/, '$1').replace(/[?&]$/, '');
    location.replace(url + (url.indexOf('?') >= 0 ? '&' : '?') + 'fresh=' + Date.now());
  }

  /** 「从剪贴板粘贴」：浏览器不允许时提示手动粘贴。 */
  function pasteButton(onText) {
    return h('button', {
      type: 'button', class: 'btn', onclick: function () {
        var fail = function () { toast('浏览器不允许读取剪贴板：请长按或右键粘贴到框里', 'warn'); };
        try {
          if (!navigator.clipboard || !navigator.clipboard.readText) { fail(); return; }
          navigator.clipboard.readText().then(function (text) { if (text) onText(text); else fail(); }, fail);
        } catch (e) { fail(); }
      }
    }, '从剪贴板粘贴');
  }

  /** 语言切换按钮：显示「要切换到的语言」，点了保存选择并重画页面。 */
  function langToggle(onChange) {
    var en = I18N.isEn();
    return h('button', {
      type: 'button', class: 'btn small lang-btn', lang: en ? 'zh-CN' : 'en',
      'aria-label': en ? '切换到中文' : 'Switch to English', title: en ? '切换到中文' : 'Switch to English',
      onclick: function () {
        I18N.setLang(en ? 'zh' : 'en');
        if (onChange) onChange();
      }
    }, en ? '中文' : 'EN');
  }

  root.ShelterUI = {
    T: T,
    TC: I18N.TC,
    i18n: I18N,
    langToggle: langToggle,
    localizeDemo: localizeDemo,
    watchCard: watchCard,
    watchCardFace: watchCardFace,
    wipeLocal: wipeLocal,
    reloadFresh: reloadFresh,
    pasteButton: pasteButton,
    sevBadge: sevBadge,
    meter: meter,
    statTile: statTile,
    h: h,
    clear: clear,
    icon: icon,
    fmtTime: fmtTime,
    fmtClock: fmtClock,
    parseNumber: parseNumber,
    toast: toast,
    modal: modal,
    confirmBox: confirmBox,
    copyText: copyText,
    copyBlock: copyBlock,
    downloadJSON: downloadJSON,
    readFileText: readFileText,
    stamp: stamp,
    Store: Store,
    connectOnline: connectOnline,
    messenger: messenger,
    transferCards: transferCards,
    transferFail: transferFail,
    onlineBanner: onlineBanner,
    onlineFailCard: onlineFailCard,
    onlineReloadedText: onlineReloadedText,
    readKey: readKey,
    writeKey: writeKey,
    removeKey: removeKey,
    UndoStack: UndoStack,
    ruleBadge: ruleBadge,
    pendingTag: pendingTag,
    field: field,
    select: select,
    segmented: segmented,
    stepper: stepper
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
