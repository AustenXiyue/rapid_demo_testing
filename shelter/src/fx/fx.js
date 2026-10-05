/*
 * 避难所 Playtest · 动画与音效
 *
 * 内联在主持人页、玩家页最后（页面脚本之后）。
 * 不改页面逻辑：每次页面保存存档时，对比前后两份存档得知「刚发生了什么」，
 * 等页面画好后给对应元素加动画（Web Animations），并播放现场合成的音效（Web Audio，没有音频文件，离线可用）。
 *
 * 设置（本机记住）：动画 跟随系统／开／关；音效 开／关；音量。系统开了「减少动态效果」时只淡入淡出。
 * 主持人端只给公开时刻配声音（阶段、计时、事件揭晓、营救、公开结果），秘密页里的操作不出声。
 * window.ShelterFX.log 记录触发过的效果名，供测试检查。
 */
(function () {
  'use strict';

  var U = window.ShelterUI;
  var C = window.ShelterCore;
  var T = U && U.T ? U.T : function (s) { return s; };
  var TC = U && U.TC ? U.TC : function (c, s) { return s; };
  var PAGE = document.body.classList.contains('host') ? 'host' : 'player';
  var NS = 'shelter-playtest:';
  var KEY_FX = NS + 'fx';
  var STATE_KEY = new RegExp('^' + NS.replace(/[-:]/g, '\\$&') + '(host|player)(-demo)?:v1$');
  var reduceMQ = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : { matches: false };

  var FX = { log: [], played: [] };
  window.ShelterFX = FX;

  // ---------------------------------------------------------------- 设置

  var settings = readSettings();

  function readSettings() {
    var s = null;
    try { s = JSON.parse(localStorage.getItem(KEY_FX)); } catch (e) { s = null; }
    s = s && typeof s === 'object' ? s : {};
    return {
      motion: s.motion === 'on' || s.motion === 'off' ? s.motion : 'auto',
      sound: s.sound !== false,
      volume: typeof s.volume === 'number' && s.volume >= 0 && s.volume <= 1 ? s.volume : 0.6
    };
  }

  function saveSettings() {
    try { localStorage.setItem(KEY_FX, JSON.stringify(settings)); } catch (e) { /* 只在本页生效 */ }
    if (master) master.gain.value = settings.volume;
  }

  /** 'full'：完整动画；'reduce'：只淡入淡出；'off'：不动 */
  function motion() {
    if (settings.motion === 'off') return 'off';
    if (settings.motion === 'auto' && reduceMQ.matches) return 'reduce';
    return 'full';
  }

  function note(name) {
    FX.log.push(name);
    if (FX.log.length > 300) FX.log.shift();
  }

  // ---------------------------------------------------------------- 声音（现场合成）

  var ctx = null;
  var master = null;
  var noiseBuf = null;
  var unlocked = false;
  var lastAt = {};
  var lastAny = 0;

  // 浏览器只允许在用户点过页面之后出声：第一次点按时才建立音频环境
  function unlock() {
    unlocked = true;
    if (!ctx) {
      var AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      try {
        ctx = new AC();
        master = ctx.createGain();
        master.gain.value = settings.volume;
        master.connect(ctx.destination);
      } catch (e) { ctx = null; return; }
    }
    if (ctx.state === 'suspended' && ctx.resume) ctx.resume();
  }
  ['pointerdown', 'keydown', 'touchstart'].forEach(function (ev) {
    document.addEventListener(ev, unlock, { capture: true, passive: true });
  });

  function tone(freq, start, dur, o) {
    o = o || {};
    var t0 = ctx.currentTime + start;
    var osc = ctx.createOscillator();
    var g = ctx.createGain();
    osc.type = o.type || 'sine';
    osc.frequency.setValueAtTime(freq, t0);
    if (o.to) osc.frequency.exponentialRampToValueAtTime(o.to, t0 + dur);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(o.gain == null ? 0.2 : o.gain, t0 + (o.attack || 0.006));
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(g);
    g.connect(master);
    osc.start(t0);
    osc.stop(t0 + dur + 0.03);
  }

  function noise(start, dur, o) {
    o = o || {};
    if (!noiseBuf) {
      noiseBuf = ctx.createBuffer(1, Math.floor(ctx.sampleRate * 0.6), ctx.sampleRate);
      var d = noiseBuf.getChannelData(0);
      for (var i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    }
    var t0 = ctx.currentTime + start;
    var src = ctx.createBufferSource();
    var f = ctx.createBiquadFilter();
    var g = ctx.createGain();
    src.buffer = noiseBuf;
    f.type = o.filter || 'bandpass';
    f.Q.value = o.q || 1;
    f.frequency.setValueAtTime(o.from || 1200, t0);
    if (o.to) f.frequency.exponentialRampToValueAtTime(o.to, t0 + dur);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(o.gain == null ? 0.25 : o.gain, t0 + (o.attack || 0.004));
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    src.connect(f);
    f.connect(g);
    g.connect(master);
    src.start(t0);
    src.stop(t0 + dur + 0.03);
  }

  function bell(freq, start, gain) {
    gain = gain == null ? 0.12 : gain;
    tone(freq, start, 1.3, { gain: gain });
    tone(freq * 2.01, start, 0.8, { gain: gain * 0.35 });
    tone(freq * 3.02, start, 0.45, { gain: gain * 0.15 });
  }

  var SOUNDS = {
    deal: function () { noise(0, 0.17, { from: 700, to: 3400, q: 0.8, gain: 0.32 }); },
    flip: function () { noise(0, 0.035, { filter: 'highpass', from: 2600, gain: 0.35 }); tone(330, 0.01, 0.09, { type: 'triangle', gain: 0.14 }); },
    select: function () { tone(880, 0, 0.35, { gain: 0.16 }); tone(1320, 0.05, 0.42, { gain: 0.09 }); },
    light: function () { tone(660, 0, 0.09, { gain: 0.12, to: 990 }); bell(990, 0.06, 0.08); },
    off: function () { tone(520, 0, 0.14, { type: 'triangle', gain: 0.1, to: 360 }); },
    pop: function () { tone(620, 0, 0.09, { gain: 0.13, to: 940 }); },
    remove: function () { tone(520, 0, 0.12, { gain: 0.1, to: 240 }); },
    tick: function () { tone(1250, 0, 0.045, { type: 'square', gain: 0.05 }); },
    urgent: function () { tone(1650, 0, 0.07, { type: 'square', gain: 0.08 }); },
    alarm: function () {
      [0, 0.24, 0.48].forEach(function (s) { tone(880, s, 0.17, { type: 'square', gain: 0.1 }); tone(1320, s, 0.17, { gain: 0.06 }); });
    },
    success: function () {
      [523.25, 659.25, 783.99, 1046.5].forEach(function (f, i) { tone(f, i * 0.075, 0.32, { type: 'triangle', gain: 0.13 }); });
    },
    hurt: function () { tone(160, 0, 0.32, { gain: 0.38, to: 52 }); noise(0, 0.09, { filter: 'lowpass', from: 420, gain: 0.25 }); },
    heal: function () { tone(440, 0, 0.26, { gain: 0.11, to: 660 }); tone(660, 0.09, 0.32, { gain: 0.09, to: 990 }); },
    warn: function () { tone(330, 0, 0.12, { type: 'triangle', gain: 0.14 }); tone(262, 0.13, 0.17, { type: 'triangle', gain: 0.14 }); },
    lock: function () { noise(0, 0.03, { filter: 'highpass', from: 3000, gain: 0.3 }); tone(220, 0.025, 0.13, { type: 'square', gain: 0.07 }); },
    phase: function () { bell(659.25, 0); bell(987.77, 0.13); },
    dawn: function () { bell(523.25, 0); bell(659.25, 0.18); bell(783.99, 0.36); },
    reveal: function () { noise(0, 0.55, { from: 300, to: 4200, q: 1.1, gain: 0.18 }); bell(880, 0.5, 0.14); },
    dice: function () { for (var i = 0; i < 6; i++) noise(i * 0.065, 0.03, { from: 1500 + Math.random() * 1500, q: 5, gain: 0.32 }); },
    shuffle: function () { [0, 0.09, 0.18].forEach(function (s) { noise(s, 0.12, { from: 900, to: 2800, q: 0.9, gain: 0.22 }); }); },
    rescue: function () { [392, 523.25, 659.25, 783.99].forEach(function (f, i) { tone(f, i * 0.09, 0.4, { gain: 0.12 }); }); },
    announce: function () { bell(783.99, 0, 0.1); }
  };

  /** 播放一个音效。opts.quiet：刚有别的声音时让一让（提示框这类附带音）。 */
  function play(name, opts) {
    var now = Date.now();
    if (lastAt[name] && now - lastAt[name] < 70) return;
    if (opts && opts.quiet && now - lastAny < 250) return;
    lastAt[name] = now;
    lastAny = now;
    if (!settings.sound || !unlocked || !ctx || !SOUNDS[name]) return;
    try {
      if (ctx.state === 'suspended' && ctx.resume) ctx.resume();
      SOUNDS[name]();
      FX.played.push(name);
    } catch (e) { /* 声音失败不影响页面 */ }
  }

  function later(ms, fn) { if (ms <= 0) fn(); else setTimeout(fn, ms); }

  // ---------------------------------------------------------------- 动画

  function anim(el, frames, opts, reduced) {
    var m = motion();
    if (!el || m === 'off' || typeof el.animate !== 'function') return null;
    var o = { duration: 300, easing: 'cubic-bezier(.2,.8,.2,1)', fill: 'backwards' };
    for (var k in opts) if (Object.prototype.hasOwnProperty.call(opts, k)) o[k] = opts[k];
    try {
      return el.animate(m === 'reduce' ? (reduced || [{ opacity: 0.35 }, { opacity: 1 }]) : frames, o);
    } catch (e) { return null; }
  }

  function $(sel, root) { return (root || document).querySelector(sel); }
  function $$(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }

  function pulse(el, scale) {
    var s = scale || 1.06;
    return anim(el, [{ transform: 'scale(1)' }, { transform: 'scale(' + s + ')' }, { transform: 'scale(1)' }], { duration: 320 });
  }

  function glow(el, color) {
    return anim(el, [{ boxShadow: '0 0 0 0 ' + color }, { boxShadow: '0 0 0 16px rgba(0,0,0,0)' }], { duration: 650, easing: 'ease-out' }, []);
  }

  function shake(el) {
    return anim(el, [
      { transform: 'translateX(0)' }, { transform: 'translateX(-5px)' }, { transform: 'translateX(5px)' },
      { transform: 'translateX(-3px)' }, { transform: 'translateX(2px)' }, { transform: 'translateX(0)' }
    ], { duration: 420, easing: 'ease-out' });
  }

  function flash(el, rgba) {
    return anim(el, [{ boxShadow: 'inset 0 0 0 999px ' + rgba }, { boxShadow: 'inset 0 0 0 999px rgba(0,0,0,0)' }], { duration: 700, easing: 'ease-out' }, []);
  }

  function slideIn(el, delay, dx, dy) {
    return anim(el, [
      { opacity: 0, transform: 'translate(' + (dx || 0) + 'px,' + (dy == null ? 10 : dy) + 'px)' },
      { opacity: 1, transform: 'translate(0,0)' }
    ], { duration: 320, delay: delay || 0 });
  }

  function popIn(el, delay) {
    return anim(el, [
      { opacity: 0, transform: 'scale(.88)' }, { opacity: 1, transform: 'scale(1.03)', offset: 0.7 }, { opacity: 1, transform: 'scale(1)' }
    ], { duration: 360, delay: delay || 0 });
  }

  // ---------------------------------------------------------------- 卡片：发牌、翻面、选中

  /** 牌背朝上滑进来，翻到一半拿掉牌背，再翻到正面。withSound=false 用在主持人的秘密弹窗里。 */
  function dealCards(els, withSound) {
    note('deal');
    els.forEach(function (el, i) {
      var d = i * 170;
      if (withSound !== false) {
        later(d, function () { play('deal'); });
        later(d + 530, function () { play('flip'); });
      }
      var m = motion();
      if (m === 'off') return;
      if (m === 'reduce') { anim(el, [{ opacity: 0 }, { opacity: 1 }], { duration: 300, delay: d }); return; }
      var back = document.createElement('span');
      back.className = 'fx-cardback';
      back.setAttribute('aria-hidden', 'true');
      el.appendChild(back);
      var drop = function () { if (back.parentNode) back.parentNode.removeChild(back); };
      var a1 = anim(el, [
        { transform: 'translateY(52px) rotate(-8deg) scale(.82)', opacity: 0 },
        { transform: 'translateY(0) rotate(0deg) scale(1)', opacity: 1 }
      ], { duration: 380, delay: d });
      if (!a1 || !a1.finished) { drop(); return; }
      a1.finished.then(function () {
        var a2 = el.animate([{ transform: 'perspective(700px) rotateY(0deg)' }, { transform: 'perspective(700px) rotateY(90deg)' }], { duration: 150, easing: 'ease-in' });
        return a2.finished;
      }).then(function () {
        drop();
        var a3 = el.animate([{ transform: 'perspective(700px) rotateY(-90deg)' }, { transform: 'perspective(700px) rotateY(0deg)' }], { duration: 230, easing: 'cubic-bezier(.2,.8,.2,1)' });
        if (el.classList.contains('is-all')) a3.finished.then(function () { glow(el, 'rgba(180,84,14,.6)'); });
      }).catch(drop);
      // 保险：无论动画怎样结束，牌背都不会留在卡面上
      setTimeout(drop, d + 1500);
    });
  }

  function pickCard(el) {
    note('select');
    play('select');
    if (!el) return;
    pulse(el, 1.06);
    glow(el, 'rgba(15,110,102,.45)');
  }

  // ---------------------------------------------------------------- 玩家页：对比前后两份存档

  function cardKey(plan) {
    return plan && plan.v === 2 && plan.cards ? plan.cards.map(function (c) { return c.id; }).join(',') : '';
  }

  function todayAction(s) {
    var a = s.action;
    return a && a.used && s.publicInfo && a.day === s.publicInfo.day ? a.type || 'other' : null;
  }

  function invMap(list) {
    var m = {};
    (list || []).forEach(function (e) { if (e && e.id) m[e.id] = e.qty == null ? 1 : e.qty; });
    return m;
  }

  function playerDiff(a, b) {
    var fx = [];

    // 守夜卡：抽到新的一对 → 发牌；换了选中的那张 → 选中
    var ka = cardKey(a.watchPlan);
    var kb = cardKey(b.watchPlan);
    if (kb && kb !== ka) {
      fx.push(function () { dealCards($$('.watch-section .wcard')); });
    } else if (kb && b.watchPlan.chosen != null && b.watchPlan.chosen !== a.watchPlan.chosen) {
      fx.push(function () {
        pickCard($('.watch-section .wcard.on'));
        if (a.watchPlan.chosen == null) slideIn($('.watch-section .share-row'), 120);
      });
    }

    // 今天的行动：点亮／取消
    var oa = todayAction(a);
    var ob = todayAction(b);
    if (ob && ob !== oa) {
      fx.push(function () {
        note('light');
        play('light');
        var btn = $('[data-action="' + ob + '"]');
        pulse(btn, 1.05);
        glow(btn, 'rgba(15,110,102,.45)');
        if (ob === 'plan') slideIn($('.watch-section'), 80);
      });
    } else if (!ob && oa && a.publicInfo.day === b.publicInfo.day) {
      fx.push(function () { note('off'); play('off'); });
    }

    // 生命
    if (typeof a.hp === 'number' && typeof b.hp === 'number' && a.hp !== b.hp) {
      var down = b.hp < a.hp;
      fx.push(function () {
        var cell = $('[data-vital="hp"]');
        note(down ? 'hurt' : 'heal');
        play(down ? 'hurt' : 'heal');
        if (down) { shake(cell); flash(cell, 'rgba(200,45,30,.28)'); } else { glow(cell, 'rgba(15,110,102,.45)'); }
      });
    }

    // 搜刮：新一轮发选项；选完或超时；全部结束
    var sa = a.scavenge;
    var sb = b.scavenge;
    if (sb && sb.status === 'running') {
      var na = sa && sa.id === sb.id && sa.status === 'running' ? sa.rounds.length : 0;
      if (sb.rounds.length > na) {
        var prevRound = na ? sb.rounds[na - 1] : null;
        fx.push(function () {
          if (prevRound && prevRound.choice != null) { note(prevRound.auto ? 'auto' : 'choose'); play(prevRound.auto ? 'warn' : 'select'); }
          note('round');
          later(prevRound ? 140 : 0, function () { play('shuffle'); });
          $$('.scav-option').forEach(function (el, i) { slideIn(el, 60 + i * 90, 0, 18); });
        });
      }
    }
    if (sa && sa.status === 'running' && sb && sb.id === sa.id && sb.status !== 'running') {
      var last = sb.rounds[sb.rounds.length - 1];
      fx.push(function () {
        if (last && last.choice != null) play(last.auto ? 'warn' : 'select');
        note('scavenge-done');
        later(260, function () { play('success'); });
      });
    }

    // 携带：确认后锁定；结束携带
    var la = !!(a.loadout && a.loadout.confirmed);
    var lb = !!(b.loadout && b.loadout.confirmed);
    if (lb && !la) fx.push(function () { note('lock'); play('lock'); $$('.inv-card.is-carried').forEach(function (el, i) { later(i * 60, function () { pulse(el, 1.04); }); }); });
    else if (la && !lb) fx.push(function () { note('unlock'); play('off'); });

    // 库存：新物品弹出来；数量变多跳一下；少了只出声
    var ia = invMap(a.inventory);
    var ib = invMap(b.inventory);
    var added = [];
    var grew = [];
    var lost = false;
    Object.keys(ib).forEach(function (id) {
      if (ia[id] == null) added.push(id);
      else if (ib[id] > ia[id]) grew.push(id);
      else if (ib[id] < ia[id]) lost = true;
    });
    Object.keys(ia).forEach(function (id) { if (ib[id] == null) lost = true; });
    if (added.length || grew.length) {
      fx.push(function () {
        note('item');
        play('pop');
        added.forEach(function (id, i) {
          var el = $('.inv-card[data-entry="' + id + '"]');
          popIn(el, i * 45);
          later(i * 45 + 200, function () { glow(el, 'rgba(15,110,102,.35)'); });
        });
        grew.forEach(function (id) { pulse($('.inv-card[data-entry="' + id + '"] .qty'), 1.3); });
      });
    } else if (lost) {
      fx.push(function () { note('item-out'); play('remove'); });
    }

    fx.push(vitalsCheck);
    return fx;
  }

  // 状态栏其他格子（饥饿、口渴、意识、库存、负面状态）：按格子的严重程度变化决定动画
  var RANK = { ok: 0, info: 1, warn: 2, crit: 3 };
  var vitals = {};
  function readVital(el) {
    var m = /\blv-(\w+)\b/.exec(el.className);
    return { rank: m && RANK[m[1]] != null ? RANK[m[1]] : 0, text: (el.querySelector('.vcell-value') || el).textContent };
  }
  function vitalsCheck(silent) {
    $$('[data-vital]').forEach(function (el) {
      var key = el.getAttribute('data-vital');
      var now = readVital(el);
      var was = vitals[key];
      vitals[key] = now;
      if (silent === true || !was || key === 'hp' || was.text === now.text) return;
      if (now.rank > was.rank) { note('worse:' + key); shake(el); flash(el, 'rgba(180,84,14,.25)'); play('warn', { quiet: true }); }
      else if (now.rank < was.rank) { note('better:' + key); glow(el, 'rgba(15,110,102,.45)'); play('heal', { quiet: true }); }
      else pulse(el, 1.04);
    });
  }

  // ---------------------------------------------------------------- 主持人页：对比前后两份存档（只给公开时刻配声音）

  function hostDiff(a, b) {
    var fx = [];

    if (a.phase !== b.phase || a.day !== b.day) {
      var dawn = b.day > a.day;
      fx.push(function () {
        note(dawn ? 'dawn' : 'phase');
        play(dawn ? 'dawn' : 'phase');
        slideIn($('.hero-phase'), 0, 0, 12);
        anim($('.track-seg.on .track-bar'), [{ transform: 'scaleX(0)', transformOrigin: 'left center' }, { transform: 'scaleX(1)', transformOrigin: 'left center' }], { duration: 520 });
        var step = $('.rail-step.on button');
        pulse(step, 1.12);
        glow(step, 'rgba(15,110,102,.45)');
      });
    }

    var ta = a.timer || {};
    var tb = b.timer || {};
    if (ta.running && !tb.running && tb.remainingMs === 0) {
      fx.push(function () {
        note('alarm');
        play('alarm');
        anim($('#timer-display'), [{ opacity: 1 }, { opacity: 0.2 }, { opacity: 1 }, { opacity: 0.2 }, { opacity: 1 }, { opacity: 0.2 }, { opacity: 1 }], { duration: 1100, easing: 'linear' }, []);
        flash($('.timer'), 'rgba(180,84,14,.22)');
      });
    } else if (!ta.running && tb.running) {
      fx.push(function () { note('timer-start'); play('pop'); pulse($('#timer-display'), 1.05); });
    }

    var ea = a.stage && a.stage.event;
    var eb = b.stage && b.stage.event;
    if (eb && (!ea || ea.flowId !== eb.flowId || ea.name !== eb.name)) {
      fx.push(function () {
        note('reveal');
        play('reveal');
        anim($('.stage-event'), [
          { opacity: 0, transform: 'perspective(900px) rotateX(-75deg)', transformOrigin: 'top center' },
          { opacity: 1, transform: 'perspective(900px) rotateX(0deg)', transformOrigin: 'top center' }
        ], { duration: 650 });
        $$('.stage-event .vote-option').forEach(function (el, i) { slideIn(el, 450 + i * 110, 0, 8); });
      });
    }

    var ca = a.today && a.today.eventCheck;
    var cb = b.today && b.today.eventCheck;
    if (cb && (!ca || ca.at !== cb.at)) {
      fx.push(function () { note('dice'); play('dice'); later(420, function () { pulse($('.event-check'), 1.08); }); });
    }

    if (typeof a.rescueProgress === 'number' && typeof b.rescueProgress === 'number' && a.rescueProgress !== b.rescueProgress) {
      var up = b.rescueProgress > a.rescueProgress;
      fx.push(function () {
        note(up ? 'rescue' : 'rescue-down');
        play(up ? 'rescue' : 'remove');
        pulse($('.rescue-value'), 1.18);
        if (up) glow($('.rescue-panel'), 'rgba(15,110,102,.45)');
      });
    }

    var fa = (a.publicFeed || []).length;
    var fb = (b.publicFeed || []).length;
    if (fb > fa) {
      fx.push(function () {
        note('announce');
        play('announce');
        $$('.feed li').slice(0, fb - fa).forEach(function (el, i) { slideIn(el, i * 90, -14, 0); });
      });
    }

    var sa = (a.seatOrder || []).join(',');
    var sb = (b.seatOrder || []).join(',');
    if (sa && sb && sa !== sb && (a.seatOrder || []).length === (b.seatOrder || []).length) {
      fx.push(function () {
        note('shuffle');
        play('shuffle');
        $$('.seat-list li, tr[data-player]').forEach(function (el, i) { slideIn(el, i * 50, -10, 0); });
      });
    }
    return fx;
  }

  // ---------------------------------------------------------------- 听存档写入

  var prev = {};
  var cur = null;

  function activeKey() {
    var slot = null;
    try { slot = localStorage.getItem(NS + PAGE + ':slot'); } catch (e) { slot = null; }
    return NS + PAGE + (slot === 'demo' ? '-demo' : '') + ':v1';
  }

  try { cur = JSON.parse(localStorage.getItem(activeKey())); prev[activeKey()] = cur; } catch (e) { cur = null; }

  function sameSave(a, b) {
    return a && b && a.createdAt === b.createdAt && (PAGE === 'host' || a.playerId === b.playerId);
  }

  function isUndo(a, b) {
    var n = b.log && b.log[0];
    var o = a.log && a.log[0];
    return !!(n && /^撤销：/.test(n.text || '') && (!o || o.id !== n.id));
  }

  function onSave(key, json) {
    var next;
    try { next = JSON.parse(json); } catch (e) { return; }
    var before = prev[key];
    prev[key] = next;
    cur = next;
    // 换了存档（新建、导入、重置、切换演示）或撤销：只记下新状态，不放效果
    if (!sameSave(before, next) || isUndo(before, next)) {
      if (PAGE === 'player') requestAnimationFrame(function () { vitalsCheck(true); });
      return;
    }
    var list;
    try { list = PAGE === 'host' ? hostDiff(before, next) : playerDiff(before, next); } catch (e) { return; }
    if (!list.length) return;
    // 页面在保存之后立刻重画：等到下一帧，元素都在了再动
    requestAnimationFrame(function () {
      list.forEach(function (fn) { try { fn(); } catch (e) { /* 效果出错不影响页面 */ } });
    });
  }

  var origSet = Storage.prototype.setItem;
  Storage.prototype.setItem = function (k, v) {
    origSet.apply(this, arguments);
    if (this === window.localStorage && STATE_KEY.test(k)) onSave(k, v);
  };

  // ---------------------------------------------------------------- 倒计时：最后几秒滴答

  var lastSec = null;
  setInterval(function () {
    if (!cur) return;
    var deadline = null;
    var warnFrom = 3;
    var el = null;
    if (PAGE === 'host') {
      var tm = cur.timer;
      if (tm && tm.running && tm.endsAt) { deadline = tm.endsAt; warnFrom = 10; el = document.getElementById('timer-display'); }
    } else if (cur.scavenge && cur.scavenge.status === 'running' && C && C.currentScavengeRound) {
      var r = C.currentScavengeRound(cur.scavenge);
      if (r) { deadline = r.deadline; el = document.getElementById('scav-clock'); }
    }
    if (!deadline) { lastSec = null; return; }
    var sec = Math.ceil((deadline - Date.now()) / 1000);
    if (el) el.classList.toggle('fx-hot', sec <= warnFrom && sec > 0);
    if (sec === lastSec) return;
    lastSec = sec;
    if (sec < 1 || sec > warnFrom) return;
    note(sec <= 3 ? 'urgent' : 'tick');
    play(sec <= 3 ? 'urgent' : 'tick');
    if (el) pulse(el, sec <= 3 ? 1.18 : 1.08);
  }, 100);

  // ---------------------------------------------------------------- 页面里的其他时刻

  // 按下的手感：按钮、卡片、状态格子轻轻一沉
  document.addEventListener('pointerdown', function (e) {
    var el = e.target && e.target.closest && e.target.closest('.btn, .action-btn, .wcard, .scav-option, .vcell, .tab, .fx-pill');
    if (el && !el.disabled) anim(el, [{ transform: 'scale(1)' }, { transform: 'scale(.96)' }, { transform: 'scale(1)' }], { duration: 180, easing: 'ease-out' }, []);
  }, { capture: true, passive: true });

  // 弹窗里出现守夜卡（主持人打开玩家的链接）：翻牌，但不出声（秘密页）
  var modalRoot = document.getElementById('modal-root');
  if (modalRoot && window.MutationObserver) {
    new MutationObserver(function (records) {
      records.forEach(function (r) {
        Array.prototype.forEach.call(r.addedNodes, function (n) {
          if (n.nodeType !== 1) return;
          var cards = n.matches && n.matches('.wcard') ? [n] : $$('.modal .wcard', n);
          if (cards.length) requestAnimationFrame(function () { dealCards(cards, false); });
        });
      });
    }).observe(modalRoot, { childList: true, subtree: true });
  }

  // 提示框：成功轻响一声，警告低两声（刚有别的声音时让一让）
  var toastRoot = document.getElementById('toast');
  if (toastRoot && window.MutationObserver) {
    new MutationObserver(function (records) {
      records.forEach(function (r) {
        Array.prototype.forEach.call(r.addedNodes, function (n) {
          if (n.nodeType !== 1 || !n.classList.contains('toast')) return;
          if (n.classList.contains('warn')) play('warn', { quiet: true });
          else if (n.classList.contains('ok')) play('pop', { quiet: true });
        });
      });
    }).observe(toastRoot, { childList: true });
  }

  // ---------------------------------------------------------------- 左下角的设置

  var SVG_NS = 'http://www.w3.org/2000/svg';
  function noteIcon() {
    var svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '2');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    var p = document.createElementNS(SVG_NS, 'path');
    p.setAttribute('d', settings.sound ? 'M9 18V5l11-2v13M9 18a3 3 0 1 1-6 0 3 3 0 0 1 6 0Zm11-2a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z' : 'M9 18V5l11-2v13M9 18a3 3 0 1 1-6 0 3 3 0 0 1 6 0ZM3 3l18 18');
    svg.appendChild(p);
    return svg;
  }

  function el(tag, attrs, kids) {
    var n = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) {
      if (k === 'text') n.textContent = attrs[k];
      else if (k === 'onclick') n.addEventListener('click', attrs[k]);
      else if (attrs[k] != null && attrs[k] !== false) n.setAttribute(k, attrs[k] === true ? '' : attrs[k]);
    });
    (kids || []).forEach(function (c) { if (c) n.appendChild(c); });
    return n;
  }

  function seg(options, value, onPick) {
    return el('div', { class: 'fx-seg', role: 'group' }, options.map(function (o) {
      return el('button', { type: 'button', 'aria-pressed': o[0] === value ? 'true' : 'false', 'data-fx': String(o[0]), text: o[1] === '开' || o[1] === '关' ? TC('switch', o[1]) : T(o[1]), onclick: function () { onPick(o[0]); } });
    }));
  }

  var TRY = [['deal', '发牌'], ['flip', '翻牌'], ['select', '选中'], ['tick', '滴答'], ['alarm', '时间到'], ['phase', '阶段'], ['reveal', '揭晓'], ['hurt', '受伤'], ['success', '完成']];
  var dock = null;
  var panelOpen = false;

  function buildDock() {
    var keep = panelOpen;
    if (dock && dock.parentNode) dock.parentNode.removeChild(dock);
    var panel = el('div', { class: 'fx-panel', role: 'dialog', 'aria-label': T('动画与音效'), hidden: !keep }, [
      el('div', { class: 'fx-head' }, [el('b', { text: T('动画与音效') })]),
      el('p', { class: 'fx-note', text: PAGE === 'host'
        ? T('只在公开时刻出声（阶段、计时、事件、营救、公开结果），秘密页里的操作不出声；屏幕共享带声音时大家都能听到。')
        : T('浏览器要求先点一下页面才会出声。设置只记在这台设备上。') }),
      el('div', { class: 'fx-row' }, [el('span', { text: T('动画') }), seg([['auto', '跟随系统'], ['on', '开'], ['off', '关']], settings.motion, function (v) { settings.motion = v; saveSettings(); buildDock(); })]),
      el('div', { class: 'fx-row' }, [el('span', { text: T('音效') }), seg([[true, '开'], [false, '关']], settings.sound, function (v) { settings.sound = v; saveSettings(); unlock(); buildDock(); })]),
      el('label', { class: 'fx-row' }, [el('span', { text: T('音量') }), (function () {
        var r = el('input', { type: 'range', min: '0', max: '100', step: '5', value: String(Math.round(settings.volume * 100)), 'aria-label': T('音量') });
        r.addEventListener('input', function () { settings.volume = Number(r.value) / 100; saveSettings(); });
        r.addEventListener('change', function () { play('select'); });
        return r;
      })()]),
      el('div', { class: 'fx-row' }, [el('span', { text: T('试听') }), el('div', { class: 'fx-try' }, TRY.map(function (t) {
        return el('button', { type: 'button', 'data-try': t[0], text: T(t[1]), onclick: function () { unlock(); note('try:' + t[0]); play(t[0]); } });
      }))])
    ]);
    var pill = el('button', {
      type: 'button', class: 'fx-pill' + (settings.sound ? '' : ' muted'), 'aria-expanded': keep ? 'true' : 'false',
      'aria-label': T('动画与音效'), title: T('动画与音效'),
      onclick: function () { panelOpen = !panelOpen; panel.hidden = !panelOpen; pill.setAttribute('aria-expanded', panelOpen ? 'true' : 'false'); }
    }, [noteIcon()]);
    dock = el('div', { class: 'fx-dock' }, [panel, pill]);
    document.body.appendChild(dock);
  }

  document.addEventListener('click', function (e) {
    // 面板里的按钮会重建面板：点到的元素已经离开页面，但仍在旧的 .fx-dock 里
    if (!panelOpen || !dock || (e.target.closest && e.target.closest('.fx-dock'))) return;
    panelOpen = false;
    buildDock();
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && panelOpen) { panelOpen = false; buildDock(); }
  });

  // 切换语言后设置面板跟着换
  if (window.MutationObserver) {
    new MutationObserver(function () { buildDock(); }).observe(document.documentElement, { attributes: true, attributeFilter: ['lang'] });
  }

  buildDock();
  if (PAGE === 'player') vitalsCheck(true);

  FX.settings = function () { return { motion: settings.motion, sound: settings.sound, volume: settings.volume }; };
  FX.play = play;
  FX.motion = motion;
})();
