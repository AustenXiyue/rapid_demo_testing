/*
 * 避难所 Playtest · 界面语言（中文／English）
 *
 * 只翻译「显示出来的文字」：ui.js 的 h() 在生成文本节点和提示属性时调用 T()。
 * 游戏数据（存档里的状态值、日志、名字）保持原样，所以中英文切换不影响存档，也不影响规则判断。
 *
 * 翻译顺序：整句精确匹配 → 固定句式（如「第 2 天」）→ 按词条从长到短逐段替换（拼接出来的句子也能翻）→ 全角标点换成半角。
 * 词典来自 src/shared/i18n/*.tsv，由 build.mjs 内联为 SHELTER_I18N_EN。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(root);
  else root.ShelterI18n = factory(root);
})(typeof self !== 'undefined' ? self : this, function (root) {
  'use strict';

  var KEY_LANG = 'shelter-playtest:lang';
  var HAN = /[一-鿿]/;
  var dict = root.SHELTER_I18N_EN || {};
  var lang = readLang();
  var cache = {};
  var index = null;

  function readLang() {
    try { return root.localStorage && root.localStorage.getItem(KEY_LANG) === 'en' ? 'en' : 'zh'; } catch (e) { return 'zh'; }
  }

  function setLang(next) {
    lang = next === 'en' ? 'en' : 'zh';
    try { root.localStorage.setItem(KEY_LANG, lang); } catch (e) { /* 本地存储不可用时只在本页生效 */ }
    if (root.document) root.document.documentElement.lang = lang === 'en' ? 'en' : 'zh-CN';
  }

  /* 固定句式：语序与中文不同、靠逐段替换拼不出来的（先于词条替换） */
  var PRE = [
    [/第\s*(\d+)\s*天夜间/g, ' Night of Day $1 '],
    [/第\s*(\d+)\s*天/g, ' Day $1 '],
    [/第\s*(\d+)\s*夜/g, ' Night $1 '],
    [/第\s*(\d+)\s*轮/g, ' Round $1 '],
    [/第\s*(\d+)\s*座/g, ' Seat $1 '],
    [/第\s*(\d+)\s*次/g, ' #$1 '],
    [/第\s*(\d+)\s*份/g, ' List $1 '],
    [/第\s*(\d+)\s*件/g, ' Item $1 ']
  ];
  /* 量词兜底：词条替换后还剩下的「数字＋量词」 */
  var POST = [
    [/(\d+(?:\.\d+)?)\s*单位/g, '$1 units'],
    [/(\d+)\s*件/g, '$1 pcs'],
    [/(\d+(?:\.\d+)?)\s*秒/g, '$1s'],
    [/(\d+)\s*分钟/g, '$1 min'],
    [/(\d+)\s*人/g, '$1 players'],
    [/(\d+)\s*条/g, '$1'],
    [/(\d+)\s*项/g, '$1 items'],
    [/(\d+)\s*次/g, '$1×'],
    [/(\d+)\s*份/g, '$1'],
    [/(\d+)\s*个/g, '$1'],
    [/(\d+)\s*轮/g, '$1 rounds'],
    [/(\d+)\s*回合/g, '$1 turns'],
    [/(\d+)\s*分/g, '$1 pts']
  ];

  var PUNCT = [
    [/：/g, ': '], [/，/g, ', '], [/。/g, '. '], [/；/g, '; '], [/、/g, ', '], [/！/g, '! '], [/？/g, '? '],
    [/（/g, ' ('], [/）/g, ') '], [/「/g, '“'], [/」/g, '”'], [/『/g, '“'], [/』/g, '”'], [/／/g, '/'], [/～/g, '–'],
    [/【/g, '['], [/】/g, '] '], [/ {2,}/g, ' '], [/ ([,.;:!?)\]])/g, '$1'], [/\( /g, '('], [/\[ /g, '['], [/“ /g, '“'], [/ ”/g, '”']
  ];

  /* 按首字符分桶、桶内从长到短，逐位置找最长词条 */
  function buildIndex() {
    index = {};
    Object.keys(dict).forEach(function (k) {
      if (!k) return;
      (index[k[0]] = index[k[0]] || []).push(k);
    });
    Object.keys(index).forEach(function (c) { index[c].sort(function (a, b) { return b.length - a.length; }); });
  }

  function replacePhrases(s) {
    if (!index) buildIndex();
    var out = '';
    var i = 0;
    while (i < s.length) {
      var bucket = index[s[i]];
      var hit = null;
      if (bucket) {
        for (var j = 0; j < bucket.length; j++) {
          if (s.startsWith(bucket[j], i)) { hit = bucket[j]; break; }
        }
      }
      if (hit) { out += dict[hit]; i += hit.length; } else { out += s[i]; i += 1; }
    }
    return out;
  }

  function translate(s) {
    if (Object.prototype.hasOwnProperty.call(dict, s)) return dict[s];
    var lead = s.match(/^\s*/)[0];
    var trail = s.match(/\s*$/)[0];
    var core = s.trim();
    if (Object.prototype.hasOwnProperty.call(dict, core)) return lead + dict[core] + trail;
    // 词条可能带首尾空格（拼接片段），所以在未去空格的原文上替换，最后再还原首尾空白
    var out = s;
    PRE.forEach(function (r) { out = out.replace(r[0], r[1]); });
    out = replacePhrases(out);
    POST.forEach(function (r) { out = out.replace(r[0], r[1]); });
    PUNCT.forEach(function (r) { out = out.replace(r[0], r[1]); });
    return lead + out.trim() + trail;
  }

  /** 把一段要显示的中文换成当前语言。不是字符串、没有中文或当前是中文时原样返回。 */
  function T(s) {
    if (lang !== 'en' || typeof s !== 'string' || !HAN.test(s)) return s;
    if (Object.prototype.hasOwnProperty.call(cache, s)) return cache[s];
    var out = translate(s);
    cache[s] = out;
    return out;
  }

  /** 同一个中文词在不同位置意思不同时（如「口渴」既是栏目名又是状态值），按语境取词：词典里写成「语境|中文」。 */
  function TC(context, s) {
    if (lang !== 'en') return s;
    var k = context + '|' + s;
    return Object.prototype.hasOwnProperty.call(dict, k) ? dict[k] : T(s);
  }

  return {
    T: T,
    TC: TC,
    setLang: setLang,
    getLang: function () { return lang; },
    isEn: function () { return lang === 'en'; },
    _setDict: function (d) { dict = d || {}; index = null; cache = {}; },
    KEY_LANG: KEY_LANG
  };
});
