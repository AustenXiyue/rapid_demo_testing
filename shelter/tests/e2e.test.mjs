// 端到端验收：用真实浏览器打开构建产物（file://，断网），逐条对照说明第15页的验收清单。
// 运行：cd shelter && npm install && npm run test:e2e
// 需要 Playwright 的 Chromium（npx playwright install chromium）。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const HOST = 'file://' + join(ROOT, 'host.html');
const PLAYER = 'file://' + join(ROOT, 'player.html');
const HOST_KEY = 'shelter-playtest:host:v1';
const HOST_DEMO = 'shelter-playtest:host-demo:v1';
const PLAYER_KEY = 'shelter-playtest:player:v1';
const PLAYER_DEMO = 'shelter-playtest:player-demo:v1';
const ITEM_NAMES = ['面包', '普通水', '能量棒', '奶油汤', '功能饮料', '绷带', '医疗箱', '钞票', '珠宝', '军用折刀', '子弹', '地图', '军用水壶', '跳棋'];
const P = (n) => 'demo_p' + n; // A..F = 1..6

let browser;
before(async () => { browser = await chromium.launch(); });
after(async () => { await browser.close(); });

async function newContext(opts = {}) {
  const context = await browser.newContext({ viewport: opts.viewport || { width: 1366, height: 900 }, acceptDownloads: true });
  const external = [];
  await context.route('**/*', (route) => {
    const url = route.request().url();
    if (/^(file|data|blob):/.test(url) || (opts.allowLocal && url.startsWith(opts.allowLocal))) return route.continue();
    external.push(url);
    return route.abort();
  });
  if (opts.init) await context.addInitScript(opts.init);
  return { context, external };
}

async function open(context, url) {
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(url);
  return { page, errors };
}

const tab = (page, id) => page.click(`[data-tab="${id}"]`);
const modal = (page) => page.locator('.modal');
const modalBtn = (page, name) => modal(page).getByRole('button', { name, exact: true }).click();
const btn = (page, name) => page.getByRole('button', { name, exact: true });
const read = (page, key) => page.evaluate((k) => JSON.parse(localStorage.getItem(k)), key);
const pieces = (list) => list.reduce((n, e) => n + e.qty, 0);
const bodyText = (page) => page.evaluate(() => document.body.innerText);

async function reveal(page, key) {
  await page.locator(`[data-gate="${key}"] button`).click();
  await page.check('#confirm-share-paused');
  await modalBtn(page, '显示');
  await page.locator(`[data-gate-open="${key}"]`).waitFor();
}

async function hostDemo(page) {
  await tab(page, 'settings');
  await btn(page, '打开演示存档').click();
  await page.waitForFunction((k) => !!localStorage.getItem(k), HOST_DEMO);
}

async function playerDemo(page) {
  await tab(page, 'save');
  await btn(page, '打开演示存档').click();
  await page.waitForFunction((k) => !!localStorage.getItem(k), PLAYER_DEMO);
}

async function nextPhase(page) {
  await page.locator('.top-actions .btn.primary').click();
}

async function startDay1(page) {
  await btn(page, '开始第 1 天 →').click();
  await modalBtn(page, '开始');
}

async function recordAction(page, pid, typeLabel) {
  await page.locator(`tr[data-player="${pid}"]`).getByRole('button', { name: '记录行动' }).click();
  await modal(page).getByRole('button', { name: typeLabel }).click();
  await modalBtn(page, '记录');
}

// ---------------------------------------------------------------- 文件与网络

test('两个文件断网后可单独打开；核心功能没有网络依赖', async () => {
  for (const file of ['host.html', 'player.html']) {
    const html = readFileSync(join(ROOT, file), 'utf8');
    assert.ok(!/\b(src|href)\s*=\s*["']https?:/i.test(html), file + ' 不引用外部资源');
    assert.ok(!/@import|url\(\s*["']?https?:/i.test(html), file + ' 不加载远程样式或字体');
    assert.ok(!/\bfetch\(|XMLHttpRequest|WebSocket|sendBeacon|EventSource/.test(html), file + ' 不发网络请求');
  }
  const { context, external } = await newContext();
  for (const url of [HOST, PLAYER]) {
    const { page, errors } = await open(context, url);
    await page.waitForSelector('#tabs .tab');
    assert.deepEqual(errors, [], url + ' 无脚本错误');
  }
  assert.deepEqual(external, [], '没有任何外部请求');
  await context.close();
});

test('不声称跨端同步：页面里没有「已自动发送／已同步」之类的提示', () => {
  for (const file of ['host.html', 'player.html']) {
    const html = readFileSync(join(ROOT, file), 'utf8');
    // 只查肯定式的说法；「不会自动同步」这类免责声明是应有的提示
    assert.ok(!/已(自动)?(发送|同步)|同步成功|发送成功/.test(html), file);
  }
});

// ---------------------------------------------------------------- 存档

test('两端存档独立；刷新恢复；导入失败不覆盖旧档', async () => {
  const { context } = await newContext();
  const { page: host } = await open(context, HOST);
  await tab(host, 'settings');
  await host.fill('input[placeholder="玩家名字"]', '正式玩家甲');
  await btn(host, '新增玩家').click();
  await host.reload();
  assert.equal((await read(host, HOST_KEY)).players[0].name, '正式玩家甲');

  const { page: player } = await open(context, PLAYER);
  await tab(player, 'identity');
  const nameInput = player.locator('.field', { hasText: '姓名' }).locator('input');
  await nameInput.fill('小周');
  await nameInput.press('Enter');
  await nameInput.blur();
  await player.waitForFunction((k) => JSON.parse(localStorage.getItem(k)).name === '小周', PLAYER_KEY);
  await player.reload();
  assert.equal((await read(player, PLAYER_KEY)).name, '小周');
  assert.equal((await read(player, HOST_KEY)).players[0].name, '正式玩家甲', '主持人存档未被玩家页改动');

  // 把主持人存档导入玩家页：校验失败，玩家存档原样保留
  const hostJson = await host.evaluate((k) => localStorage.getItem(k), HOST_KEY);
  await tab(player, 'save');
  await btn(player, '粘贴导入').click();
  await modal(player).locator('textarea').fill(hostJson);
  await modalBtn(player, '校验并导入');
  await modal(player).getByText('导入失败：当前存档未改动').waitFor();
  await modalBtn(player, '知道了');
  // 非 JSON 同样不覆盖
  await btn(player, '粘贴导入').click();
  await modal(player).locator('textarea').fill('{"kind":');
  await modalBtn(player, '校验并导入');
  await modal(player).getByText('导入失败').waitFor();
  await modalBtn(player, '知道了');
  assert.equal((await read(player, PLAYER_KEY)).name, '小周');
  await context.close();
});

test('本地保存不可用时明确提示，仍可在内存运行并导出', async () => {
  const { context } = await newContext({
    init: () => { Storage.prototype.setItem = function () { throw new DOMException('blocked', 'SecurityError'); }; },
  });
  const { page, errors } = await open(context, PLAYER);
  await page.getByText('浏览器本地保存不可用').first().waitFor();
  await tab(page, 'status');
  await page.getByRole('button', { name: '生命加一' }).click();
  assert.match(await page.locator('.big-num').first().innerText(), /^6$/);
  await tab(page, 'save');
  await btn(page, '导出 JSON').waitFor();
  const [download] = await Promise.all([page.waitForEvent('download'), btn(page, '导出 JSON').click()]);
  const saved = JSON.parse(readFileSync(await download.path(), 'utf8'));
  assert.equal(saved.hp, 6, '导出的是内存中的最新数据');
  assert.deepEqual(errors, []);
  await context.close();
});

test('演示存档独立：载入、清空都不覆盖正式数据', async () => {
  const { context } = await newContext();
  const { page } = await open(context, HOST);
  await tab(page, 'settings');
  await page.fill('input[placeholder="玩家名字"]', '正式玩家甲');
  await btn(page, '新增玩家').click();
  await hostDemo(page);
  assert.equal((await read(page, HOST_DEMO)).isDemo, true);
  assert.equal((await read(page, HOST_KEY)).players.length, 1, '正式存档未被演示覆盖');
  await page.locator('#banner').getByRole('button', { name: '清空演示数据' }).click();
  await modalBtn(page, '清空');
  await page.waitForFunction((k) => localStorage.getItem(k) === null, HOST_DEMO);
  assert.equal((await read(page, HOST_KEY)).players[0].name, '正式玩家甲');
  await context.close();
});

// ---------------------------------------------------------------- 主持人：秘密

test('主持人隐藏池与候选时，公开页面、通知与日志摘要不泄密；刷新默认隐藏', async () => {
  const { context } = await newContext();
  const { page, errors } = await open(context, HOST);
  await hostDemo(page);
  await tab(page, 'supply');
  assert.equal(await page.locator('[data-gate="pool"]').count(), 1);
  assert.ok(!(await bodyText(page)).includes('剩余候选'), '隐藏时池内容不在页面里');
  await reveal(page, 'pool');
  await btn(page, '抽取').click();
  const secretLine = await page.locator('.batch p').first().innerText();
  assert.match(secretLine, /剩余候选/);
  await btn(page, '一键隐藏所有秘密').click();

  for (const id of ['stage', 'flow', 'supply', 'watch', 'events', 'records', 'log']) {
    await tab(page, id);
    const text = await bodyText(page);
    assert.ok(!text.includes('剩余候选'), id + '：不显示抽取详情');
    assert.ok(!text.includes('轮到你选'), id + '：不显示私信文本');
    assert.equal(await page.locator('[data-gate-open]').count(), 0, id + '：没有处于显示状态的秘密区');
    if (['stage', 'flow', 'log'].includes(id)) {
      for (const name of ITEM_NAMES) assert.ok(!text.includes(name), `${id}：不出现物品名「${name}」`);
    }
    const titles = await page.evaluate(() => [...document.querySelectorAll('[title]')].map((e) => e.title).join('|'));
    for (const name of ITEM_NAMES) assert.ok(!titles.includes(name), `${id}：悬浮提示不含「${name}」`);
  }
  assert.equal(await page.title(), '避难所 Playtest · 主持人');

  await tab(page, 'supply');
  await reveal(page, 'pool');
  await page.reload();
  await tab(page, 'supply');
  assert.equal(await page.locator('[data-gate="pool"]').count(), 1, '刷新后恢复隐藏');
  assert.deepEqual(errors, []);
  await context.close();
});

// ---------------------------------------------------------------- 主持人：完整一回合

test('主持人：用演示存档完整走一回合（发放、轮换、换位、守夜、事件、次日公布）', async () => {
  const { context } = await newContext();
  const { page, errors } = await open(context, HOST);
  await hostDemo(page);
  let s = await read(page, HOST_DEMO);
  const total = pieces(s.pool);
  assert.equal(total, 32);

  await startDay1(page);
  s = await read(page, HOST_DEMO);
  assert.equal(s.day, 1);
  assert.equal(s.phase, 'night');

  // 阶段1 → 阶段2：资源补给（6人抽6件，按件数）
  await nextPhase(page);
  await tab(page, 'supply');
  await reveal(page, 'pool');
  await btn(page, '抽取').click();
  s = await read(page, HOST_DEMO);
  let batch = s.batches.at(-1);
  assert.equal(batch.items.length, 6, '抽6件');
  assert.equal(pieces(s.pool), total - 6, '按件数扣除，不是按单位');
  assert.deepEqual(batch.pickOrder, [1, 2, 3, 4, 5, 6].map(P), '按当前座次领取');

  const firstPiece = batch.items[0].id;
  await page.locator(`tr[data-picker="${P(1)}"]`).getByRole('button', { name: '记录选择' }).click();
  assert.match(await modal(page).locator('textarea').inputValue(), /主持人端不会自动发送/);
  await modalBtn(page, '知道了');
  const options = await page.locator(`tr[data-picker="${P(2)}"] select option`).evaluateAll((os) => os.map((o) => o.value));
  assert.ok(!options.includes(firstPiece), '被选走的物品不能再被选');
  for (const n of [2, 3, 4, 5, 6]) {
    await page.locator(`tr[data-picker="${P(n)}"]`).getByRole('button', { name: '记录选择' }).click();
    await modalBtn(page, '知道了');
  }
  s = await read(page, HOST_DEMO);
  batch = s.batches.at(-1);
  assert.equal(batch.picks.length, 6);
  assert.equal(new Set(batch.picks.map((p) => p.piece.id)).size, 6, '每件只被选一次');
  assert.equal(pieces(s.pool) + batch.items.length + batch.picks.length, total, '公共池总量正确');
  await btn(page, '结束批次（未选的放回公共池）').click();
  await btn(page, '一键隐藏所有秘密').click();

  // 阶段3 → 阶段4：每日轮换只执行一次，且在交流之后
  await tab(page, 'flow');
  await nextPhase(page);
  assert.equal((await read(page, HOST_DEMO)).phase, 'exchange');
  await nextPhase(page);
  await btn(page, '执行每日轮换').click();
  s = await read(page, HOST_DEMO);
  assert.deepEqual(s.seatOrder, [6, 1, 2, 3, 4, 5].map(P));
  assert.ok(await btn(page, '今日已轮换').isDisabled());

  // 阶段5：行动顺序固定为轮换后的座次
  await nextPhase(page);
  s = await read(page, HOST_DEMO);
  assert.equal(s.phase, 'actions');
  assert.deepEqual(s.today.actionOrder, [6, 1, 2, 3, 4, 5].map(P));
  await recordAction(page, P(6), '放弃行动');
  // 说明里的例子：A 与 E 换位
  await page.locator(`tr[data-player="${P(1)}"]`).getByRole('button', { name: '换位请求' }).click();
  await modal(page).locator('select').selectOption(P(5));
  await modalBtn(page, '记录，行动结束');
  s = await read(page, HOST_DEMO);
  assert.deepEqual(s.seatOrder, [6, 5, 2, 3, 4, 1].map(P), 'seatOrder=[F,E,B,C,D,A]');
  assert.deepEqual(s.today.actionOrder, [6, 1, 2, 3, 4, 5].map(P), 'actionOrder 不变');
  await recordAction(page, P(2), '计划守夜名单');
  await recordAction(page, P(3), '计划守夜名单');
  await recordAction(page, P(4), '使用技能');
  await recordAction(page, P(5), '其他行动');
  s = await read(page, HOST_DEMO);
  assert.deepEqual(s.today.plannerIds, [P(2), P(3)]);
  assert.deepEqual(s.today.skillUserIds, [P(4)]);
  assert.equal(s.today.watchCandidates.length, 2);
  assert.ok(s.today.watchCandidates.every((c) => c.options.length === 2), '每位计划者两份候选');
  const candidatesBefore = JSON.stringify(s.today.watchCandidates);
  await page.reload();
  assert.equal(JSON.stringify((await read(page, HOST_DEMO)).today.watchCandidates), candidatesBefore, '刷新不重抽候选');

  // 阶段6：守夜（0／1／多份提交）
  await tab(page, 'flow');
  await nextPhase(page);
  await tab(page, 'watch');
  await reveal(page, 'watch');
  await page.getByText('没有人提交名单').waitFor();
  await page.locator(`[data-planner="${P(2)}"]`).getByRole('button', { name: '提交①' }).click();
  await page.getByText('只有一份提交').waitFor();
  await page.locator(`[data-planner="${P(3)}"]`).getByRole('button', { name: '提交②' }).click();
  await page.getByText('收到 2 份提交').waitFor();
  const deciderLine = await page.locator('section.card').filter({ has: page.locator('h2', { hasText: /^确认最终名单$/ }) }).innerText();
  assert.match(deciderLine, /A·老陈/, '末位按最新 seatOrder 取 A');
  await btn(page, '末位选第 1 份').click();
  // 只表达风险倾向的名单没有对象：页面要求主持人指定人员（随机抽到时补勾一人）
  const preview = page.locator('section.card').filter({ has: page.locator('h2', { hasText: /^确认最终名单$/ }) }).locator('.card.inset');
  if ((await preview.locator('input[type=checkbox]:checked').count()) === 0) {
    assert.ok((await preview.innerText()).includes('请主持人'), '没有对象时提示主持人指定');
    await preview.locator('input[type=checkbox]').first().check();
  }
  await btn(page, '确认最终名单（保存人员快照）').click();
  s = await read(page, HOST_DEMO);
  assert.ok(s.today.finalWatch && s.today.finalWatch.memberIds.length > 0);
  assert.ok(!s.today.plannerIds.includes(P(1)), '只拍板的人不计为计划者');
  assert.equal(s.today.finalWatch.deciderId, P(1));

  // 夜间结果：手动选择并保存，次日公布
  // 结果库按名单的风险倾向筛选：从下拉框实际提供的结果里选
  const nightSelect = page.locator('section.card').filter({ has: page.locator('h2', { hasText: /^夜间结果$/ }) }).locator('select');
  const offered = await nightSelect.locator('option').evaluateAll((os) => os.map((o) => o.value).filter(Boolean));
  assert.ok(offered.length > 0, '至少有一条可选的夜间结果');
  const night = s.nightLibrary.find((e) => e.id === offered[0]);
  const tendencies = s.today.finalWatch.tendencies;
  if (tendencies.length) assert.ok(tendencies.includes(night.tendency), '按倾向筛选');
  await nightSelect.selectOption(night.id);
  await btn(page, '手动选择').click();
  await btn(page, '保存为昨夜结果（次日阶段1公布）').click();
  s = await read(page, HOST_DEMO);
  assert.ok(s.pendingNightResult.text.includes(night.text));

  // 公共事件：手动触发、投票、指定结果、重复点击不重复结算、撤销准确回滚
  await tab(page, 'events');
  await btn(page, '进行今日事件判定（80%）').click();
  s = await read(page, HOST_DEMO);
  const check = s.today.eventCheck;
  assert.equal(check.triggered, check.roll < 80, '80% 只控制触发');
  await page.reload();
  await tab(page, 'events');
  assert.equal(await btn(page, '进行今日事件判定（80%）').count(), 0, '一次每日判定只能结算一次');
  assert.deepEqual((await read(page, HOST_DEMO)).today.eventCheck, check, '刷新不重掷');

  await reveal(page, 'events');
  const broadcast = s.events.find((e) => e.name.includes('军方广播'));
  await page.locator('select', { has: page.locator('option', { hasText: '手动选择事件…' }) }).selectOption(broadcast.id);
  await btn(page, '使用所选事件').click();
  await page.locator('.flow-steps').getByRole('button', { name: '公布到公开页' }).click();
  const respond = broadcast.options[0];
  await page.locator('select', { has: page.locator('option', { hasText: '选择 Discord 投票结果…' }) }).selectOption(respond.id);
  await btn(page, '录入').click();
  const rescueOutcome = respond.outcomes.find((o) => o.effects.rescue === 1);
  await page.locator('select', { has: page.locator('option', { hasText: '手动选择结果…' }) }).selectOption(rescueOutcome.id);
  await btn(page, '手动指定').click();
  const rescueBefore = (await read(page, HOST_DEMO)).rescueProgress;
  await page.evaluate(() => {
    const b = [...document.querySelectorAll('button')].find((x) => x.textContent === '确认结算');
    b.click();
    b.click();
  });
  s = await read(page, HOST_DEMO);
  assert.equal(s.rescueProgress, rescueBefore + 1, '重复点击只结算一次');
  assert.equal(s.resolutions.filter((r) => !r.undone).length, 1);
  assert.ok(s.resolutions[0].id.startsWith('res_'));
  await btn(page, '撤销结算').click();
  await modalBtn(page, '撤销结算');
  s = await read(page, HOST_DEMO);
  assert.equal(s.rescueProgress, rescueBefore, '撤销准确回滚');
  assert.equal(s.resolutions[0].undone, true);
  await btn(page, '确认结算').click();
  await btn(page, '公布结果到公开页').click();
  s = await read(page, HOST_DEMO);
  assert.equal(s.rescueProgress, rescueBefore + 1);
  assert.ok(s.publicFeed.some((f) => f.kind === 'event'));
  await btn(page, '一键隐藏所有秘密').click();

  // 进入第2天：当日标记清空，昨夜结果在阶段1公布
  await tab(page, 'flow');
  await nextPhase(page);
  await modalBtn(page, '进入下一天');
  s = await read(page, HOST_DEMO);
  assert.equal(s.day, 2);
  assert.equal(s.phase, 'night');
  assert.deepEqual(s.today.plannerIds, []);
  assert.deepEqual(s.today.skillUserIds, []);
  assert.deepEqual(s.today.watchCandidates, []);
  assert.equal(s.today.rotationDone, false);
  assert.ok(s.pendingNightResult && s.pendingNightResult.publishedDay == null, '昨夜结果保留到次日');
  await btn(page, '公布昨夜结果到公开页').click();
  await tab(page, 'stage');
  assert.ok((await bodyText(page)).includes(night.text), '公开页显示昨夜结果');
  s = await read(page, HOST_DEMO);
  assert.equal(s.pendingNightResult.publishedDay, 2);
  assert.ok(s.log.some((l) => !l.secret && l.text.includes('阶段')), '阶段变化写入公开日志');

  // 跨日回退会恢复前一天的记录
  await tab(page, 'flow');
  await btn(page, '← 回退').click();
  await modalBtn(page, '回退');
  s = await read(page, HOST_DEMO);
  assert.equal(s.day, 1);
  assert.deepEqual(s.today.plannerIds, [P(2), P(3)]);
  assert.deepEqual(errors, []);
  await context.close();
});

test('事件抽签结果存档：刷新不会重抽；概率不全时只能手动录入', async () => {
  const { context } = await newContext();
  const { page } = await open(context, HOST);
  await hostDemo(page);
  await startDay1(page);
  await tab(page, 'events');
  await reveal(page, 'events');
  let s = await read(page, HOST_DEMO);
  const vending = s.events.find((e) => e.name.includes('售货机'));
  await page.locator('select', { has: page.locator('option', { hasText: '手动选择事件…' }) }).selectOption(vending.id);
  await btn(page, '使用所选事件').click();
  await page.locator('select', { has: page.locator('option', { hasText: '选择 Discord 投票结果…' }) }).selectOption(vending.options[0].id);
  await btn(page, '录入').click();
  await btn(page, '按概率抽签').click();
  const preview = (await read(page, HOST_DEMO)).today.eventFlow.preview;
  assert.equal(preview.mode, 'auto');
  await page.reload();
  await tab(page, 'events');
  await reveal(page, 'events');
  assert.deepEqual((await read(page, HOST_DEMO)).today.eventFlow.preview, preview);
  assert.equal(await btn(page, '按概率抽签').count(), 0, '已有抽签结果时不能再抽');

  // 概率不全的事件：抽签按钮不可用
  await btn(page, '放弃并重新选择事件').click();
  await modalBtn(page, '放弃');
  await page.evaluate((k) => {
    const st = JSON.parse(localStorage.getItem(k));
    st.events[0].options[0].outcomes[0].probability = null;
    localStorage.setItem(k, JSON.stringify(st));
  }, HOST_DEMO);
  await page.reload();
  await tab(page, 'events');
  await reveal(page, 'events');
  s = await read(page, HOST_DEMO);
  await page.locator('select', { has: page.locator('option', { hasText: '手动选择事件…' }) }).selectOption(s.events[0].id);
  await btn(page, '使用所选事件').click();
  await page.locator('select', { has: page.locator('option', { hasText: '选择 Discord 投票结果…' }) }).selectOption(s.events[0].options[0].id);
  await btn(page, '录入').click();
  assert.ok(await btn(page, '按概率抽签').isDisabled());
  await page.getByText('不能自动抽签，请手动录入结果').waitFor();
  await context.close();
});

test('公共池不足时暂停结算，不会扣成负数', async () => {
  const { context } = await newContext();
  const { page } = await open(context, HOST);
  await hostDemo(page);
  await startDay1(page);
  await page.evaluate((k) => {
    const st = JSON.parse(localStorage.getItem(k));
    st.pool = st.pool.filter((e) => e.defId !== 'bread');
    localStorage.setItem(k, JSON.stringify(st));
  }, HOST_DEMO);
  await page.reload();
  await tab(page, 'events');
  await reveal(page, 'events');
  const s = await read(page, HOST_DEMO);
  const broadcast = s.events.find((e) => e.name.includes('军方广播'));
  const respond = broadcast.options[0];
  const lossOutcome = respond.outcomes.find((o) => o.effects.pool.length);
  await page.locator('select', { has: page.locator('option', { hasText: '手动选择事件…' }) }).selectOption(broadcast.id);
  await btn(page, '使用所选事件').click();
  await page.locator('select', { has: page.locator('option', { hasText: '选择 Discord 投票结果…' }) }).selectOption(respond.id);
  await btn(page, '录入').click();
  await page.locator('select', { has: page.locator('option', { hasText: '手动选择结果…' }) }).selectOption(lossOutcome.id);
  await btn(page, '手动指定').click();
  await page.getByText('公共池不足，结算已暂停').waitFor();
  assert.ok(await btn(page, '确认结算').isDisabled());
  await btn(page, '按现有数量扣除（主持人覆盖）').click();
  await btn(page, '确认结算').click();
  const after = await read(page, HOST_DEMO);
  assert.ok(after.pool.every((e) => e.qty > 0), '没有负数');
  assert.equal(after.resolutions.length, 1);
  await context.close();
});

test('结算：存在未定项时显示部分分数／待裁定，不当作0分', async () => {
  const { context } = await newContext();
  const { page } = await open(context, HOST);
  await hostDemo(page);
  await tab(page, 'records');
  await reveal(page, 'scores');
  await btn(page, '结算（保存分数快照）').click();
  const s = await read(page, HOST_DEMO);
  assert.equal(s.settlement.partial, true);
  await page.getByText('部分分数／待裁定（不是最终排名）').waitFor();
  await context.close();
});

// ---------------------------------------------------------------- 玩家

test('玩家：能量棒用3次后消失，1次与3次剩余的实例不合并', async () => {
  const { context } = await newContext({ viewport: { width: 390, height: 844 } });
  const { page, errors } = await open(context, PLAYER);
  await playerDemo(page);
  await tab(page, 'inventory');
  let s = await read(page, PLAYER_DEMO);
  const bars = s.inventory.filter((e) => e.defId === 'energy_bar');
  assert.deepEqual(bars.map((b) => b.uses).sort(), [1, 3], '两根能量棒分别保存');
  const one = bars.find((b) => b.uses === 1);
  const three = bars.find((b) => b.uses === 3);
  await page.locator(`[data-entry="${one.id}"]`).getByRole('button', { name: '使用' }).click();
  await modalBtn(page, '确定');
  s = await read(page, PLAYER_DEMO);
  assert.ok(!s.inventory.some((e) => e.id === one.id), '剩1次的用完消失');
  assert.equal(s.inventory.find((e) => e.id === three.id).uses, 3, '另一根不受影响');
  assert.equal(s.hunger, null, '恢复量待定：不填就不改饥饿值');
  for (let i = 0; i < 3; i++) {
    await page.locator(`[data-entry="${three.id}"]`).getByRole('button', { name: '使用' }).click();
    await modalBtn(page, '确定');
  }
  s = await read(page, PLAYER_DEMO);
  assert.ok(!s.inventory.some((e) => e.defId === 'energy_bar'), '3次后消失');
  await btn(page, '撤销').click();
  s = await read(page, PLAYER_DEMO);
  assert.equal(s.inventory.find((e) => e.id === three.id).uses, 1, '常规消耗可以撤销');
  assert.deepEqual(errors, []);
  await context.close();
});

test('玩家：地图笔记、水壶水量、背心状态在导出导入后完整恢复', async () => {
  const { context } = await newContext({ viewport: { width: 390, height: 844 } });
  const { page } = await open(context, PLAYER);
  await playerDemo(page);
  const original = await read(page, PLAYER_DEMO);
  await tab(page, 'save');
  const [download] = await Promise.all([page.waitForEvent('download'), btn(page, '导出 JSON').click()]);
  const exported = readFileSync(await download.path(), 'utf8');
  await btn(page, '重置').click();
  await modalBtn(page, '重置');
  await page.evaluate((k) => {
    const st = JSON.parse(localStorage.getItem(k));
    st.inventory = [];
    localStorage.setItem(k, JSON.stringify(st));
  }, PLAYER_DEMO);
  await page.reload();
  await tab(page, 'save');
  await btn(page, '粘贴导入').click();
  await modal(page).locator('textarea').fill(exported);
  await modalBtn(page, '校验并导入');
  await modalBtn(page, '导入');
  const s = await read(page, PLAYER_DEMO);
  const pick = (st, id) => st.inventory.find((e) => e.defId === id);
  assert.deepEqual(pick(s, 'map').notes, pick(original, 'map').notes);
  assert.equal(pick(s, 'canteen').water, 1);
  assert.equal(pick(s, 'vest').condition, 'damaged');
  await tab(page, 'inventory');
  const text = await bodyText(page);
  assert.ok(text.includes('北门外有辆翻倒的补给车'));
  assert.ok(text.includes('储水 1 / 2'));
  assert.ok(text.includes('破损'));
  await context.close();
});

test('玩家：治疗他人、赠予与交公都生成人工交接文本', async () => {
  const { context } = await newContext({ viewport: { width: 390, height: 844 } });
  const { page } = await open(context, PLAYER);
  await playerDemo(page);
  await tab(page, 'inventory');
  await page.getByRole('button', { name: '+ 添加物品' }).click();
  await modal(page).locator('select').first().selectOption('bandage');
  await modalBtn(page, '添加');
  let s = await read(page, PLAYER_DEMO);
  const bandage = s.inventory.find((e) => e.defId === 'bandage');
  const hp = s.hp;
  await page.locator(`[data-entry="${bandage.id}"]`).getByRole('button', { name: '使用' }).click();
  await modal(page).getByRole('button', { name: '他人', exact: true }).click();
  await modal(page).locator('input[placeholder="对方名字"]').fill('阿珍');
  await modalBtn(page, '使用');
  await modal(page).locator('textarea').waitFor();
  assert.match(await modal(page).locator('textarea').inputValue(), /请 阿珍 在玩家页手动修改/);
  await modalBtn(page, '知道了');
  s = await read(page, PLAYER_DEMO);
  assert.equal(s.hp, hp, '治疗他人不改自己的生命');

  const bread = s.inventory.find((e) => e.defId === 'bread');
  await page.locator(`[data-entry="${bread.id}"]`).getByRole('button', { name: '赠予／交公' }).click();
  await modal(page).getByRole('button', { name: '交给公共池' }).click();
  await modalBtn(page, '转出并生成文本');
  assert.match(await modal(page).locator('textarea').inputValue(), /请主持人在公共池手动加入/);
  await modalBtn(page, '知道了');
  s = await read(page, PLAYER_DEMO);
  assert.ok(!s.inventory.some((e) => e.defId === 'bread'));
  assert.equal(s.handoffs.length, 2);
  await context.close();
});

test('玩家：携带只引用库存实例，返回时不重复添加', async () => {
  const { context } = await newContext({ viewport: { width: 390, height: 844 } });
  const { page } = await open(context, PLAYER);
  await playerDemo(page);
  const before = await read(page, PLAYER_DEMO);
  const countBefore = before.inventory.reduce((n, e) => n + e.qty, 0);
  await tab(page, 'loadout');
  await btn(page, '为守夜准备携带').click();
  await page.getByText('守夜上限待配置').waitFor();
  const rifle = before.inventory.find((e) => e.defId === 'rifle');
  await page.locator('li', { hasText: '军用步枪' }).getByRole('button', { name: '+', exact: true }).click();
  await page.getByText('无弹，仅可恐吓').waitFor();
  await btn(page, '返回：清空携带标记').click();
  const after = await read(page, PLAYER_DEMO);
  assert.equal(after.loadout, null);
  assert.equal(after.inventory.reduce((n, e) => n + e.qty, 0), countBefore, '库存件数不变');
  assert.ok(after.inventory.some((e) => e.id === rifle.id));
  await context.close();
});

test('玩家：搜刮5秒截止、3轮完成、超时默认选择、刷新与后台切回不多领', async () => {
  const { context } = await newContext({ viewport: { width: 390, height: 844 } });
  let { page } = await open(context, PLAYER);
  await tab(page, 'scavenge');
  await btn(page, '开始搜刮（主持人通知后）').click();
  await modalBtn(page, '开始');
  let s = await read(page, PLAYER_KEY);
  assert.equal(s.scavenge.rounds.length, 1);
  assert.equal(s.scavenge.rounds[0].options.length, 3);
  assert.equal(s.scavenge.rounds[0].deadline - s.scavenge.rounds[0].startedAt, 5000);
  await page.locator('.scav-option[data-option="1"]').click();
  s = await read(page, PLAYER_KEY);
  assert.equal(s.scavenge.rounds[0].choice, 1);
  const round2 = JSON.stringify(s.scavenge.rounds[1]);

  // 刷新：第2轮的候选与截止时间不变
  await page.reload();
  await tab(page, 'scavenge');
  assert.equal(JSON.stringify((await read(page, PLAYER_KEY)).scavenge.rounds[1]), round2, '刷新不重置倒计时、不重抽');
  await page.getByText('第 2 / 3 轮').waitFor();

  // 第2轮超时：自动选默认项
  await page.waitForFunction((k) => JSON.parse(localStorage.getItem(k)).scavenge.rounds.length === 3, PLAYER_KEY, { timeout: 8000 });
  s = await read(page, PLAYER_KEY);
  assert.equal(s.scavenge.rounds[1].choice, 0);
  assert.equal(s.scavenge.rounds[1].auto, true);

  // 关掉页面错过第3轮，重新打开：按截止时间补结算，不会多出一轮
  await page.close();
  await new Promise((r) => setTimeout(r, 5600));
  ({ page } = await open(context, PLAYER));
  s = await read(page, PLAYER_KEY);
  assert.equal(s.scavenge.status, 'organize');
  assert.equal(s.scavenge.rounds.length, 3);
  assert.equal(s.scavenge.rounds[2].auto, true);

  // 整理并一次性提交（全部交公）
  await tab(page, 'scavenge');
  await btn(page, '预览并提交').click();
  await modalBtn(page, '确认提交');
  await modal(page).getByText('交公清单：发给主持人').waitFor();
  await modalBtn(page, '知道了');
  s = await read(page, PLAYER_KEY);
  assert.equal(s.scavenge.status, 'submitted');
  assert.equal(s.inventory.length, 0, '全部交公，库存不变');
  await page.reload();
  s = await read(page, PLAYER_KEY);
  assert.equal(s.scavenge.status, 'submitted', '刷新不会重新领奖');
  await tab(page, 'scavenge');
  assert.equal(await btn(page, '预览并提交').count(), 0);
  await context.close();
});

test('玩家：自留超过4单位只警告，需主持人裁定后才能提交；旧库存不被压到4', async () => {
  const { context } = await newContext({ viewport: { width: 390, height: 844 } });
  const { page } = await open(context, PLAYER);
  await playerDemo(page);
  // 构造一次已完成三轮的搜刮：全部选默认项，所得为三组共约9单位
  await page.evaluate((k) => {
    const st = JSON.parse(localStorage.getItem(k));
    const combo = [{ defId: 'axe', qty: 3 }];
    st.scavenge = {
      id: 'sc_test', startedAt: 0, status: 'organize', cfg: { rounds: 3, options: 3, seconds: 5, comboTicks: 6 },
      template: { items: [] }, submitted: null,
      rounds: [0, 1, 2].map((i) => ({ index: i, startedAt: 0, deadline: 1, options: [combo, combo, combo], choice: 0, chosenAt: 1, auto: true })),
    };
    localStorage.setItem(k, JSON.stringify(st));
  }, PLAYER_DEMO);
  await page.reload();
  const invBefore = (await read(page, PLAYER_DEMO)).inventory.reduce((n, e) => n + e.qty, 0);
  await tab(page, 'scavenge');
  const plus = page.locator('li', { hasText: '消防斧 ×9' }).getByRole('button', { name: '+' });
  for (let i = 0; i < 5; i++) await plus.click();
  await page.getByText('（超出自留额度）').waitFor();
  await btn(page, '预览并提交').click();
  await modalBtn(page, '确认提交');
  assert.equal(await modal(page).count(), 1, '未勾选裁定时不能提交');
  await modal(page).getByText('主持人已裁定，仍然提交').click();
  await modalBtn(page, '确认提交');
  await modalBtn(page, '知道了');
  const s = await read(page, PLAYER_DEMO);
  assert.equal(s.inventory.reduce((n, e) => n + e.qty, 0), invBefore + 5, '旧库存保留，新自留加入');
  assert.equal(s.scavenge.submitted.override, true);
  await context.close();
});

test('玩家页在 375px 宽度下没有横向溢出', async () => {
  const { context } = await newContext({ viewport: { width: 375, height: 812 } });
  const { page } = await open(context, PLAYER);
  await playerDemo(page);
  for (const id of ['status', 'inventory', 'loadout', 'scavenge', 'action', 'identity', 'score', 'save']) {
    await tab(page, id);
    const width = await page.evaluate(() => document.documentElement.scrollWidth);
    assert.ok(width <= 375, `${id} 宽度 ${width}`);
  }
  await context.close();
});

test('入口页：经主站反代的 /game/shelter（无结尾斜杠）与直连路径下链接都正确', async () => {
  // 模拟线上：主站把 /game/shelter → 上游 /shelter/index.html，/game/shelter/* → 上游 /shelter/*
  const server = createServer((req, res) => {
    const path = decodeURI(req.url.split('?')[0]);
    const map = { '/game/shelter': 'index.html', '/shelter': 'index.html', '/shelter/': 'index.html' };
    let file = map[path];
    if (!file) {
      const m = path.match(/^\/(?:game\/)?shelter\/([\w.-]+)$/);
      file = m ? m[1] : null;
    }
    if (!file || !existsSync(join(ROOT, file))) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(readFileSync(join(ROOT, file)));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const origin = 'http://127.0.0.1:' + server.address().port;
  const { context, external } = await newContext({ allowLocal: origin });
  try {
    for (const [entry, expected] of [['/game/shelter', '/game/shelter/'], ['/shelter/', '/shelter/'], ['/shelter', '/shelter/']]) {
      const { page, errors } = await open(context, origin + entry);
      const hrefs = await page.locator('a[data-page]').evaluateAll((as) => as.map((a) => new URL(a.href).pathname));
      assert.deepEqual(hrefs, [expected + 'host.html', expected + 'player.html'], entry);
      await page.locator('a[data-page="player.html"]').click();
      await page.waitForSelector('#tabs .tab');
      assert.equal(new URL(page.url()).pathname, expected + 'player.html');
      assert.deepEqual(errors, []);
      await page.close();
    }
    const { page } = await open(context, 'file://' + join(ROOT, 'index.html'));
    const local = await page.locator('a[data-page]').evaluateAll((as) => as.map((a) => a.getAttribute('href')));
    assert.deepEqual(local, ['host.html', 'player.html'], '双击打开时保持相对链接');
    assert.deepEqual(external, []);
  } finally {
    await context.close();
    server.close();
  }
});
