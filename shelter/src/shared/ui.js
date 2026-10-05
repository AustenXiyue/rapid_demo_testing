/*
 * 避难所 Playtest · 共享界面工具
 * DOM 构建、弹窗、提示、复制、导出，以及带降级提示的本地存档。
 * 用户输入一律以文本节点写入，不拼 innerHTML。
 */
(function (root) {
  'use strict';

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
        else el.setAttribute(k, v === true ? '' : String(v));
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
      else el.appendChild(document.createTextNode(String(c)));
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

  root.ShelterUI = {
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
