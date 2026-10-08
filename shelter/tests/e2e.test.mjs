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
const HOST_KEY = 'shelterpt_host:v1';
const HOST_DEMO = 'shelterpt_host-demo:v1';
const PLAYER_KEY = 'shelterpt_player:v1';
const PLAYER_DEMO = 'shelterpt_player-demo:v1';
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

// 手机宽度下不常用的页收在底栏「更多」里
async function tab(page, id) {
  const target = page.locator(`[data-tab="${id}"]`);
  if (!(await target.isVisible())) await page.click('.more-btn');
  await target.click();
}
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
  await tab(player, 'action');
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

test('主持台：默认打开；待办随进度变化并能跳转；公开展示可全屏展示、Esc 退出', async () => {
  const { context } = await newContext();
  const { page, errors } = await open(context, HOST);
  assert.equal(await page.locator('#tabs .tab.on').getAttribute('data-tab'), 'flow', '默认是主持台');
  const todo = page.locator('section.todo');
  assert.match(await todo.innerText(), /还没有登记玩家/);
  await todo.locator('li', { hasText: '还没有登记玩家' }).getByRole('button').click();
  assert.equal(await page.locator('#tabs .tab.on').getAttribute('data-tab'), 'settings', '待办链接跳到对应页');

  await btn(page, '打开演示存档').click();
  await page.waitForFunction((k) => !!localStorage.getItem(k), HOST_DEMO);
  await tab(page, 'flow');
  await startDay1(page);
  await nextPhase(page); // 阶段2
  await nextPhase(page); // 阶段3
  await nextPhase(page); // 阶段4
  assert.match(await todo.innerText(), /今日尚未轮换/);
  assert.equal(await page.locator('.rail-step.on .rail-name').innerText(), '每日轮换', '阶段轨标出当前阶段');
  await btn(page, '执行每日轮换').click();
  assert.ok(!(await todo.innerText()).includes('今日尚未轮换'), '处理完就从待办里消失');
  await page.getByRole('button', { name: '进入「个人行动」' }).click();
  assert.equal((await read(page, HOST_DEMO)).phase, 'actions', '卡片底部的下一步与顶栏是同一个动作');
  assert.match(await todo.innerText(), /轮到 F·教授 行动（还剩 6 人）/);

  await tab(page, 'stage');
  assert.equal(await page.locator('.focus-name').innerText(), 'F·教授', '公开展示突出「轮到谁」');
  await btn(page, '全屏展示').click();
  assert.ok(await page.evaluate(() => document.body.classList.contains('presenting')));
  assert.ok(!(await page.locator('#topbar').isVisible()) && !(await page.locator('#tabs').isVisible()), '全屏展示隐藏主持人工具栏');
  await page.keyboard.press('Escape');
  await page.locator('#topbar').waitFor();
  assert.ok(!(await page.evaluate(() => document.body.classList.contains('presenting'))));
  assert.deepEqual(errors, []);
  await context.close();
});

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
  assert.equal(s.today.watchCandidates.length, 0, '候选卡由玩家在自己的页面抽，主持人端不自动抽');

  // 阶段6：守夜（0／1／多份提交）。这里模拟玩家无法使用页面：主持人代抽两张
  await tab(page, 'flow');
  await nextPhase(page);
  await tab(page, 'watch');
  await reveal(page, 'watch');
  await page.getByText('没有人提交名单').waitFor();
  for (const pid of [P(2), P(3)]) await page.locator(`[data-planner="${pid}"]`).getByRole('button', { name: '主持人代抽两张（玩家无法使用页面时）' }).click();
  s = await read(page, HOST_DEMO);
  assert.equal(s.today.watchCandidates.length, 2);
  assert.ok(s.today.watchCandidates.every((c) => c.options.length === 2), '每位计划者两张候选卡');
  const candidatesBefore = JSON.stringify(s.today.watchCandidates);
  await page.reload();
  assert.equal(JSON.stringify((await read(page, HOST_DEMO)).today.watchCandidates), candidatesBefore, '刷新不重抽候选');
  await tab(page, 'watch');
  await reveal(page, 'watch');
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

test('主持人随机抽取事件：抽到先存档（刷新不变）、重抽换一件并记日志、使用后进入结算流程；公开页不提前显示', async () => {
  const { context } = await newContext();
  const { page, errors } = await open(context, HOST);
  await hostDemo(page);
  await startDay1(page);
  await tab(page, 'events');
  await reveal(page, 'events');
  let s = await read(page, HOST_DEMO);
  const names = s.events.map((e) => e.name);
  const box = page.locator('.event-draw-box');
  assert.match(await box.innerText(), /可抽：2 · 事件库：2 · 本局已用：0/);
  await btn(page, '随机抽取一件').click();
  await page.waitForFunction(() => window.ShelterFX.log.includes('roulette'));
  s = await read(page, HOST_DEMO);
  const first = s.today.eventDraw;
  assert.ok(s.events.some((e) => e.id === first.eventId), '抽到的是事件库里的事件');
  assert.equal(first.poolIds.length, 2);
  assert.equal(first.count, 1);
  // 名字翻动结束后停在抽中的那件
  const drawnName = s.events.find((e) => e.id === first.eventId).name;
  await page.waitForFunction((n) => document.querySelector('.event-draw-name').textContent === n, drawnName, { timeout: 3000 });
  assert.ok(names.includes(drawnName));
  assert.ok(!s.stage.event, '抽到不等于公布：公开页没有事件');
  assert.ok(s.log.some((l) => l.secret && l.text.startsWith('随机抽取事件：' + drawnName)), '抽取记入日志（秘密）');

  await page.reload();
  assert.deepEqual((await read(page, HOST_DEMO)).today.eventDraw, first, '刷新不重抽');
  await tab(page, 'events');
  await reveal(page, 'events');
  await btn(page, '重抽（记入日志）').click();
  s = await read(page, HOST_DEMO);
  assert.notEqual(s.today.eventDraw.eventId, first.eventId, '重抽换了一件');
  assert.equal(s.today.eventDraw.count, 2);
  assert.match(await page.locator('.event-draw').innerText(), /已重抽：1/);
  assert.ok(s.log.some((l) => l.text.startsWith('重抽事件（第 2 次）')));

  await btn(page, '使用这件（开始今日事件流程）').click();
  s = await read(page, HOST_DEMO);
  assert.equal(s.today.eventFlow.event.id, s.events.find((e) => e.name === s.today.eventFlow.event.name).id);
  assert.notEqual(s.today.eventFlow.event.id, first.eventId);
  assert.equal(s.today.eventDraw, null, '开始流程后抽取结果清掉');
  assert.equal(s.today.eventFlow.source, '随机抽取（1 件候选，已重抽：1）', '重抽时刚才那件不在候选里');
  assert.equal(await page.locator('.event-draw-box').count(), 0, '开始流程后抽取框收起');
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

test('玩家：携带模式在库存页——默认上限2单位、确认后其他物品锁定、携带物品可删除、结束携带不重复添加', async () => {
  const { context } = await newContext();
  const { page, errors } = await open(context, PLAYER);
  await playerDemo(page);
  const before = await read(page, PLAYER_DEMO);
  const countBefore = before.inventory.reduce((n, e) => n + e.qty, 0);
  const find = (id) => before.inventory.find((e) => e.defId === id);
  const [rifle, map, vest] = [find('rifle'), find('map'), find('vest')];
  const card = (e) => page.locator(`[data-entry="${e.id}"]`);
  await tab(page, 'inventory');
  await btn(page, '携带模式').click();
  await modal(page).getByRole('button', { name: '守夜', exact: true }).click();
  await modalBtn(page, '开始挑选');
  let s = await read(page, PLAYER_DEMO);
  assert.equal(s.loadout.limitTicks, 4, '守夜上限未配置时默认 2 单位');
  assert.equal(s.loadout.confirmed, false);
  await card(rifle).getByRole('button', { name: '多带一件军用步枪' }).click();
  await card(map).getByRole('button', { name: '带上' }).click();
  assert.ok(await card(vest).getByRole('button', { name: '带上' }).isDisabled(), '超过 2 单位的选不上');
  await page.getByRole('button', { name: /^确认携带/ }).click();
  s = await read(page, PLAYER_DEMO);
  assert.equal(s.loadout.confirmed, true);
  assert.equal(await card(vest).getAttribute('inert'), '', '其他物品锁定');
  assert.equal(await card(vest).getByRole('button').count(), 0, '锁定的卡片没有可点的按钮');
  await page.locator('.carry-panel').getByText('无弹，仅可恐吓').waitFor();
  // 主持人宣布结果：带去的步枪丢了，直接在高亮卡片上删除
  await card(rifle).getByRole('button', { name: '删除' }).click();
  await modal(page).getByRole('button', { name: '删除', exact: true }).click();
  s = await read(page, PLAYER_DEMO);
  assert.ok(!s.inventory.some((e) => e.id === rifle.id), '步枪已删除');
  assert.deepEqual(s.loadout.items.map((r) => r.entryId), [map.id], '携带只剩地图');
  await btn(page, '结束携带（返回）').click();
  await modalBtn(page, '结束携带');
  s = await read(page, PLAYER_DEMO);
  assert.equal(s.loadout, null);
  assert.equal(s.inventory.reduce((n, e) => n + e.qty, 0), countBefore - 1, '只少了删除的那件，没有重复添加');
  assert.ok(s.inventory.some((e) => e.id === map.id));
  assert.equal(await card(vest).getAttribute('inert'), null, '结束后解锁');
  // 删除可以撤销
  await btn(page, '撤销').click();
  await btn(page, '撤销').click();
  assert.ok((await read(page, PLAYER_DEMO)).inventory.some((e) => e.id === rifle.id), '撤销恢复删除的物品');
  assert.deepEqual(errors, []);
  await context.close();
});

test('玩家：库存按类别分区或默认顺序；删除可选数量；旧版「携带」「身份」页地址自动转到新页', async () => {
  const { context } = await newContext({ init: () => localStorage.setItem('shelterpt_player:tab', 'loadout') });
  const { page, errors } = await open(context, PLAYER);
  assert.equal(await page.locator('#tabs .tab.on').getAttribute('data-tab'), 'inventory', '旧的携带页转到库存与携带');
  await playerDemo(page);
  await tab(page, 'inventory');
  const groups = await page.locator('.inv-group-name').allInnerTexts();
  assert.deepEqual(groups, ['补给', '财富', '装备', '特殊'], '按类别分区，顺序固定');
  await page.getByRole('button', { name: '默认顺序', exact: true }).click();
  assert.equal(await page.locator('.inv-group').count(), 0);
  const s0 = await read(page, PLAYER_DEMO);
  const order = await page.locator('.inv-card').evaluateAll((els) => els.map((e) => e.dataset.entry));
  assert.deepEqual(order, s0.inventory.map((e) => e.id), '默认顺序＝库存里的先后');
  await page.reload();
  await page.locator('.inv-card').first().waitFor();
  assert.equal(await page.locator('.inv-group').count(), 0, '排列方式在这台设备上记住');
  const cash = s0.inventory.find((e) => e.defId === 'cash');
  await page.locator(`[data-entry="${cash.id}"]`).getByRole('button', { name: '删除' }).click();
  await modal(page).locator('input[type=number]').fill('2');
  await modal(page).getByRole('button', { name: '删除', exact: true }).click();
  assert.equal((await read(page, PLAYER_DEMO)).inventory.find((e) => e.id === cash.id).qty, cash.qty - 2);
  assert.deepEqual(errors, []);
  await context.close();
});

test('玩家：行动与身份同页——点亮一个行动按钮记为今日行动，再点取消，改选会替换', async () => {
  const { context } = await newContext({ viewport: { width: 390, height: 844 } });
  const { page, errors } = await open(context, PLAYER);
  await playerDemo(page);
  await tab(page, 'action');
  assert.ok(await page.locator('.field', { hasText: '爱的人' }).isVisible(), '身份在同一页');
  const plan = page.locator('[data-action="plan"]');
  const swap = page.locator('[data-action="swap"]');
  await plan.click();
  let s = await read(page, PLAYER_DEMO);
  assert.equal(s.action.used, true);
  assert.equal(s.action.type, 'plan');
  assert.equal(await plan.getAttribute('aria-pressed'), 'true');
  await swap.click();
  s = await read(page, PLAYER_DEMO);
  assert.equal(s.action.type, 'swap', '改选替换，不会同时点亮两个');
  assert.equal(await page.locator('.action-btn[aria-pressed="true"]').count(), 1);
  await swap.click();
  s = await read(page, PLAYER_DEMO);
  assert.equal(s.action.used, false, '再点一次取消');
  assert.ok(await page.locator('[data-action="skill"]').isDisabled(), '职业草案未启用时职业技能不可选');
  assert.deepEqual(errors, []);
  await context.close();
});

test('玩家：搜刮7秒截止、3轮完成、超时默认选择、刷新与后台切回不多领', async () => {
  const { context } = await newContext({ viewport: { width: 390, height: 844 } });
  let { page } = await open(context, PLAYER);
  await tab(page, 'scavenge');
  await btn(page, '开始搜刮（主持人通知后）').click();
  await modalBtn(page, '开始');
  let s = await read(page, PLAYER_KEY);
  assert.equal(s.scavenge.rounds.length, 1);
  assert.equal(s.scavenge.rounds[0].options.length, 3);
  assert.equal(s.scavenge.rounds[0].deadline - s.scavenge.rounds[0].startedAt, 7000);
  for (const combo of s.scavenge.rounds[0].options) {
    const nonSupplyRepeats = combo.filter((it) => !['water', 'bread', 'energy_drink', 'cream_soup', 'energy_bar'].includes(it.defId) && it.qty > 1);
    assert.deepEqual(nonSupplyRepeats, [], '补给之外的物品每组最多一件');
  }
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
  await page.waitForFunction((k) => JSON.parse(localStorage.getItem(k)).scavenge.rounds.length === 3, PLAYER_KEY, { timeout: 10000 });
  s = await read(page, PLAYER_KEY);
  assert.equal(s.scavenge.rounds[1].choice, 0);
  assert.equal(s.scavenge.rounds[1].auto, true);

  // 关掉页面错过第3轮，重新打开：按截止时间补结算，不会多出一轮
  await page.close();
  await new Promise((r) => setTimeout(r, 7600));
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
  for (const id of ['dashboard', 'status', 'inventory', 'scavenge', 'action', 'score', 'save']) {
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

test('玩家总览：汇总生命、状态、库存、财富与提醒，并能跳到对应页', async () => {
  const { context } = await newContext({ viewport: { width: 390, height: 844 } });
  const { page, errors } = await open(context, PLAYER);
  await playerDemo(page);
  await tab(page, 'dashboard');
  const tileText = async (key) => page.locator(`[data-tile="${key}"]`).innerText();
  assert.match(await tileText('hp'), /生命[\s\S]*5[\s\S]*基础战斗力 5/);
  assert.match(await tileText('inventory'), /10[\s\S]*10 单位/);
  assert.match(await tileText('wealth'), /7[\s\S]*分/, '钞票3＋珠宝2件(4)＝7');
  assert.match(await tileText('thirst'), /不渴/);
  // 状态徽章同时有图标与文字，不只靠颜色
  const badges = await page.locator('.vitals .sev').evaluateAll((els) => els.map((e) => ({ text: e.textContent.trim(), icon: !!e.querySelector('svg') })));
  assert.ok(badges.length >= 6 && badges.every((b) => b.text && b.icon));
  // 第3天：流血到期提醒出现在「需要留意」
  await page.getByRole('button', { name: '后一天' }).click();
  const alerts = page.locator('.c-alerts');
  await alerts.getByText('流血伤口第 3 天到期').waitFor();
  assert.ok((await alerts.innerText()).includes('注意'));
  // 在行动页点亮今天的行动后，「未标记」提醒消失
  await btn(page, '选择今日行动').click();
  await page.locator('[data-action="plan"]').click();
  await tab(page, 'dashboard');
  assert.ok(!(await alerts.innerText()).includes('个人行动未标记'));
  assert.match(await page.locator('[data-tile="today"]').innerText(), /计划守夜名单/);
  // 「查看」跳到对应页
  await alerts.locator('.alert-row', { hasText: '流血' }).getByRole('button', { name: '查看' }).click();
  assert.equal(await page.locator('[data-tab="status"]').getAttribute('aria-current'), 'page');
  // 身份可以在这台设备上遮住，刷新后保持
  await tab(page, 'dashboard');
  assert.ok((await page.locator('.c-id').innerText()).includes('A·老陈'));
  await page.locator('.c-id').getByRole('button', { name: '遮住' }).click();
  await page.reload();
  assert.ok(!(await page.locator('.c-id').innerText()).includes('A·老陈'));
  // 占位构成：按分类的条形，数值标在条末端
  const bars = await page.locator('.bar-row').evaluateAll((rows) => rows.map((r) => r.innerText.replace(/\s+/g, ' ')));
  assert.ok(bars.some((t) => t.includes('财富') && t.includes('3.5')), bars.join(' | '));
  assert.deepEqual(errors, []);
  await context.close();
});

test('响应式布局：手机底栏＋更多、平板顶栏、电脑侧栏与多列总览', async () => {
  const { context } = await newContext();
  const { page } = await open(context, PLAYER);
  await playerDemo(page);
  await tab(page, 'dashboard');
  const box = (sel) => page.locator(sel).boundingBox();

  await page.setViewportSize({ width: 390, height: 844 });
  let nav = await box('#tabs');
  assert.ok(Math.abs(nav.y + nav.height - 844) <= 1, '手机：导航贴底');
  assert.equal(await page.locator('[data-tab="score"]').isVisible(), false, '不常用页收进「更多」');
  await page.click('.more-btn');
  assert.equal(await page.locator('[data-tab="score"]').isVisible(), true);
  await page.mouse.click(200, 300);
  assert.equal(await page.locator('[data-tab="score"]').isVisible(), false, '点外面收起');

  await page.setViewportSize({ width: 820, height: 1180 });
  nav = await box('#tabs');
  const main = await box('#main');
  assert.ok(nav.y < main.y, '平板：标签在内容上方');
  assert.equal(await page.locator('#tabs .tab:visible').count(), 7, '携带并入库存、身份并入行动后共 7 页');

  await page.setViewportSize({ width: 1440, height: 900 });
  nav = await box('#tabs');
  const main2 = await box('#main');
  assert.ok(nav.x + nav.width <= main2.x, '电脑：侧栏在内容左边');
  const hero = await box('[data-tile="hp"]');
  const hunger = await box('[data-tile="hunger"]');
  assert.ok(Math.abs(hero.y - hunger.y) < 2 && hunger.x > hero.x, '电脑：英雄数字与指标卡同一行');
  for (const w of [390, 820, 1440]) {
    await page.setViewportSize({ width: w, height: 900 });
    assert.ok((await page.evaluate(() => document.documentElement.scrollWidth)) <= w, w + 'px 无横向溢出');
  }
  await context.close();
});

test('玩家：添加自定义物品会进库存；再次添加同名物品按原定义叠加，不报重复', async () => {
  const { context } = await newContext({ viewport: { width: 390, height: 844 } });
  const { page, errors } = await open(context, PLAYER);
  await tab(page, 'inventory');
  const addCustom = async (name, qty) => {
    await btn(page, '添加自定义物品').click();
    await modal(page).locator('input[placeholder="物品名称"]').fill(name);
    await modal(page).locator('.field', { hasText: '数量（件）' }).locator('input').fill(String(qty));
    await modalBtn(page, '加入库存');
  };
  await addCustom('收音机', 2);
  let s = await read(page, PLAYER_KEY);
  assert.equal(s.customItems.length, 1);
  const radio = s.customItems[0];
  assert.equal(s.inventory.find((e) => e.defId === radio.id).qty, 2, '创建后直接进库存');
  await page.locator(`[data-def="${radio.id}"]`).waitFor();
  await addCustom('收音机', 1);
  s = await read(page, PLAYER_KEY);
  assert.equal(s.customItems.length, 1, '同名不重复登记');
  assert.equal(s.inventory.find((e) => e.defId === radio.id).qty, 3, '按原定义叠加');
  // 和内置物品同名：直接加入内置物品
  await btn(page, '添加自定义物品').click();
  await modal(page).locator('input[placeholder="物品名称"]').fill('面包');
  await modal(page).getByText('已有同名物品「面包」').waitFor();
  await modalBtn(page, '加入库存');
  s = await read(page, PLAYER_KEY);
  assert.equal(s.inventory.find((e) => e.defId === 'bread').qty, 1);
  assert.equal(s.customItems.length, 1);
  assert.deepEqual(errors, []);
  await context.close();
});

// ---------------------------------------------------------------- 中英文

const HAN = /[一-鿿]/;
async function leftoverChinese(page) {
  return page.evaluate((src) => {
    const han = new RegExp(src);
    const parts = [document.body.innerText, document.title];
    document.querySelectorAll('[placeholder],[title],[aria-label]').forEach((e) => {
      if (e.classList.contains('lang-btn')) return; // 切换按钮本来就显示「中文」
      parts.push(e.getAttribute('placeholder') || '', e.getAttribute('title') || '', e.getAttribute('aria-label') || '');
    });
    document.querySelectorAll('textarea, input[type=text]').forEach((t) => parts.push(t.value));
    return parts.join('\n').split('\n').filter((l) => han.test(l) && l.trim() !== '中文');
  }, HAN.source);
}

test('中英文切换：按钮切换后整页变英文、刷新保持、可切回；存档数据不变', async () => {
  const { context } = await newContext();
  const { page, errors } = await open(context, HOST);
  await hostDemo(page);
  const before = await read(page, HOST_DEMO);
  await tab(page, 'flow');
  await page.locator('.lang-btn').click();
  await btn(page, 'Start Day 1 →').waitFor();
  assert.equal(await page.title(), 'Shelter Playtest · Host');
  assert.equal(await page.evaluate(() => document.documentElement.lang), 'en');
  await page.reload();
  assert.ok(await btn(page, 'Start Day 1 →').isVisible(), '刷新后仍是英文');
  // 英文界面下照样能操作：开始第1天、进入阶段2，存档里的数据格式不变
  await btn(page, 'Start Day 1 →').click();
  await modalBtn(page, 'Start');
  const s = await read(page, HOST_DEMO);
  assert.equal(s.phase, 'night');
  assert.deepEqual(s.players.map((p) => p.name), before.players.map((p) => p.name), '已有存档里的名字不被改写');
  await page.locator('.lang-btn').click();
  await btn(page, '下一阶段 →').waitFor();
  assert.equal(await page.title(), '避难所 Playtest · 主持人');
  assert.deepEqual(errors, []);
  await context.close();
});

test('英文界面：主持人与玩家每一页都没有残留中文（演示存档按英文生成）', async () => {
  const { context } = await newContext({ init: () => localStorage.setItem('shelterpt_lang', 'en') });
  const { page: host, errors } = await open(context, HOST);
  await tab(host, 'settings');
  await btn(host, 'Open demo save').click();
  await host.waitForFunction((k) => !!localStorage.getItem(k), HOST_DEMO);
  assert.ok((await read(host, HOST_DEMO)).players.some((p) => p.name === 'B·Jen'), '英文界面下生成的演示存档是英文');
  await tab(host, 'flow');
  await btn(host, 'Start Day 1 →').click();
  await modalBtn(host, 'Start');
  for (const id of ['flow', 'stage', 'supply', 'watch', 'events', 'records', 'log', 'settings']) {
    await tab(host, id);
    const gate = host.locator('[data-gate] button');
    if (await gate.count()) {
      await gate.first().click();
      await host.check('#confirm-share-paused');
      await modalBtn(host, 'Show');
    }
    assert.deepEqual(await leftoverChinese(host), [], 'host ' + id);
  }
  const { page: player } = await open(context, PLAYER);
  await tab(player, 'save');
  await btn(player, 'Open demo save').click();
  await player.waitForFunction((k) => !!localStorage.getItem(k), PLAYER_DEMO);
  for (const id of ['dashboard', 'status', 'inventory', 'scavenge', 'action', 'score', 'save']) {
    await tab(player, id);
    assert.deepEqual(await leftoverChinese(player), [], 'player ' + id);
  }
  // 守夜卡片：录入名单 → 点亮计划 → 抽卡选卡 → 主持人打开链接
  await tab(player, 'save');
  await player.locator('.roster-card').getByRole('textbox').fill('A·Chen, C·Tiger, D·Nun');
  await player.locator('.roster-card').getByRole('button', { name: 'Add', exact: true }).click();
  await player.locator('.roster-card .name-chip').first().waitFor();
  assert.deepEqual(await leftoverChinese(player), [], 'player roster');
  await tab(player, 'action');
  await player.locator('[data-action="plan"]').click();
  assert.deepEqual(await leftoverChinese(player), [], 'player watch (before draw)');
  await btn(player, 'Draw the watch roster').click();
  await player.locator('.watch-section .wcard').first().click();
  assert.deepEqual(await leftoverChinese(player), [], 'player watch cards');
  await host.goto(await player.locator('.share-row input').inputValue());
  await host.check('#confirm-share-paused');
  assert.deepEqual(await leftoverChinese(host), [], 'host link prompt');
  await modalBtn(host, 'View card');
  await modal(host).locator('.wcard').waitFor();
  assert.deepEqual(await leftoverChinese(host), [], 'host card prompt');
  await modalBtn(host, "Add to today's pool");
  await host.locator('[data-gate-open="watch"] .wcard').first().waitFor();
  assert.deepEqual(await leftoverChinese(host), [], 'host watch with a linked card');
  await tab(player, 'inventory');
  assert.equal((await read(player, PLAYER_DEMO)).thirst, '不渴', '规则用的状态值保持中文，不受界面语言影响');
  assert.deepEqual(errors, []);
  await context.close();
});

test('入口页：中英文切换，与两个面板共用同一个选择', async () => {
  const { context } = await newContext();
  const { page } = await open(context, 'file://' + join(ROOT, 'index.html'));
  await page.locator('#lang-btn').click();
  assert.equal(await page.locator('h1').innerText(), 'Shelter Playtest');
  assert.equal(await page.title(), 'Shelter Playtest');
  assert.ok(!HAN.test(await page.locator('main').innerText().then((t) => t.replace('中文', ''))), '入口页没有残留中文');
  const { page: player } = await open(context, PLAYER);
  assert.equal(await player.title(), 'Shelter Playtest · Player', '玩家页跟随入口页的选择');
  await page.locator('#lang-btn').click();
  assert.equal(await page.locator('h1').innerText(), '避难所 Playtest');
  await context.close();
});

// ---------------------------------------------------------------- 守夜名单：玩家抽卡 → 分享链接 → 主持人打开即入池 → 末位拍板

test('守夜名单：只在点亮「计划守夜名单」时出现；抽两张、选一张、复制链接；主持人打开链接看到同一张卡，不重新随机', async () => {
  const { context: hc } = await newContext();
  const { page: host, errors } = await open(hc, HOST);
  await hostDemo(host);
  await tab(host, 'flow');
  await startDay1(host);
  await nextPhase(host); // 2
  await nextPhase(host); // 3
  await nextPhase(host); // 4
  await btn(host, '执行每日轮换').click();
  await nextPhase(host); // 5 个人行动
  const allNames = (await read(host, HOST_DEMO)).players.map((p) => p.name);

  // 玩家：填姓名，在「存档 → 玩家名单」录入其他玩家，与自己的名字组成完整名单
  async function player(name) {
    const { context } = await newContext({ viewport: { width: 390, height: 844 } });
    const { page, errors: perr } = await open(context, PLAYER);
    await tab(page, 'action');
    const nameInput = page.locator('.field', { hasText: '姓名' }).locator('input');
    await nameInput.fill(name);
    await nameInput.press('Enter');
    await nameInput.blur();
    await page.waitForFunction((n) => JSON.parse(localStorage.getItem('shelterpt_player:v1')).name === n, name);
    await tab(page, 'save');
    const roster = page.locator('.roster-card');
    await roster.getByRole('textbox', { name: '其他玩家的名字' }).fill(allNames.filter((n) => n !== name).join('，'));
    await roster.getByRole('button', { name: '添加', exact: true }).click();
    await roster.getByText('共 6 人 → 每张普通卡 2 人必定守夜。').waitFor();
    await tab(page, 'action');
    return { context, page, perr };
  }

  const p1 = await player('B·阿珍');
  const pg = p1.page;
  assert.equal(await pg.locator('.watch-section').count(), 0, '没选「计划守夜名单」时不显示');
  await pg.locator('[data-action="other"]').click();
  assert.equal(await pg.locator('.watch-section').count(), 0, '选了别的行动也不显示');
  await pg.locator('[data-action="plan"]').click();
  await pg.locator('.watch-section').waitFor();
  assert.equal(await pg.locator('.watch-section .wcard').count(), 0, '点「确认抽取守夜名单」之前不抽');
  await btn(pg, '确认抽取守夜名单').click();
  const cards = pg.locator('.watch-section .wcard');
  assert.equal(await cards.count(), 2, '随机生成两张卡');
  let ps = await read(pg, PLAYER_KEY);
  const pair = JSON.stringify(ps.watchPlan.cards);
  for (let i = 0; i < 2; i++) {
    const c = ps.watchPlan.cards[i];
    const text = (await cards.nth(i).innerText()).trim();
    if (c.all) {
      assert.equal(text, '所有人需要进行守夜', '全员卡只有这一句');
    } else {
      assert.equal(c.names.length, 2, '6 人 → 三分之一向上取整 2 人');
      assert.equal(new Set(c.names).size, 2, '名字不重复');
      c.names.forEach((n) => { assert.ok(allNames.includes(n)); assert.ok(text.includes(n)); });
      assert.equal(text.includes('今天使用技能的人需要守夜'), c.skill);
      assert.equal(text.includes('今天计划守夜名单的人需要守夜'), c.plan);
    }
  }
  assert.equal(await pg.locator('.share-row').count(), 0, '选卡之前没有链接');
  await cards.nth(0).click();
  // 取消行动再点亮：还是同一对卡，不能靠重抽挑卡
  await pg.locator('[data-action="plan"]').click();
  assert.equal(await pg.locator('.watch-section').count(), 0);
  await pg.locator('[data-action="plan"]').click();
  assert.equal(JSON.stringify((await read(pg, PLAYER_KEY)).watchPlan.cards), pair, '同一天不能重抽');
  await cards.nth(1).click();
  await pg.locator('.wcard-slot', { has: pg.locator('.wcard.on') }).getByText('已选这张').waitFor();
  const link = await pg.getByRole('textbox', { name: '分享链接' }).inputValue();
  assert.match(link, /host\.html#watch=[A-Za-z0-9_-]+$/, '链接指向主持人页');
  ps = await read(pg, PLAYER_KEY);
  const chosenCard = ps.watchPlan.cards[1];
  const playerFace = await cards.nth(1).innerText();

  // 主持人在已打开的主持人页里打开链接：先确认暂停共享，才显示卡面
  await host.goto(link);
  await modal(host).getByText('收到守夜卡片链接').waitFor();
  assert.equal(await modal(host).locator('.wcard').count(), 0, '确认暂停共享之前不显示卡面');
  assert.ok(!host.url().includes('#watch='), '地址栏里的卡片已清掉');
  await host.check('#confirm-share-paused');
  await modalBtn(host, '查看卡片');
  await modal(host).getByText('已按链接里的名字自动匹配：B·阿珍').waitFor();
  assert.equal(await modal(host).locator('.wcard').innerText(), playerFace, '主持人看到的卡面与玩家选中的一模一样');
  await modalBtn(host, '加入今天的候选池');
  let s = await read(host, HOST_DEMO);
  assert.deepEqual(s.today.plannerIds, [P(2)], '收到链接时补记计划者');
  const cand = s.today.watchCandidates[0];
  assert.equal(cand.source, 'link');
  const { ids, ...sameCard } = cand.options[0];
  assert.deepEqual(sameCard, chosenCard, '主持人这边保存的就是玩家选的那张，没有重新随机');
  assert.equal(ids.length, chosenCard.all ? 0 : 2, '名字换成主持人端的玩家 id');
  await host.locator('[data-gate-open="watch"]').waitFor();
  await host.getByText('只有一份提交：B·阿珍 选中的名单直接成为最终名单。').waitFor();

  // 第二位计划者：主持人在新标签页打开链接；原来的主持人标签页自动同步，不弹冲突提示
  const p2 = await player('C·胖虎');
  await p2.page.locator('[data-action="plan"]').click();
  await btn(p2.page, '确认抽取守夜名单').click();
  await p2.page.locator('.watch-section .wcard').nth(0).click();
  const link2 = await p2.page.getByRole('textbox', { name: '分享链接' }).inputValue();
  const { page: host2, errors: errors2 } = await open(hc, link2);
  await host2.check('#confirm-share-paused');
  await modalBtn(host2, '查看卡片');
  await modalBtn(host2, '加入今天的候选池');
  await host.getByText('收到 2 份提交').waitFor();
  assert.ok(!(await bodyText(host)).includes('另一个标签页修改了同一份主持人存档'), '原标签页直接同步');
  await host2.close();

  // 两份提交：末位拍板（私信文本 + 按钮），不再需要代码往返
  await host.getByRole('button', { name: '复制给末位的私信' }).waitFor();
  await btn(host, '末位选第 2 份').click();
  s = await read(host, HOST_DEMO);
  assert.equal(s.today.watchCandidates.find((c) => c.id === s.today.watchDecision).plannerId, P(3), '末位选了 C·胖虎 的提交');
  await btn(host, '确认最终名单（保存人员快照）').click();
  s = await read(host, HOST_DEMO);
  assert.ok(s.today.finalWatch.memberIds.length >= 1);

  // 粘贴入口：坏链接给出提示，不改存档
  const before = JSON.stringify((await read(host, HOST_DEMO)).today);
  await host.locator('.code-reader textarea').fill('https://example.com/host.html#watch=abc');
  await btn(host, '读取链接').click();
  await host.getByText(/链接不完整或已损坏|最终名单已确认/).first().waitFor();
  assert.equal(JSON.stringify((await read(host, HOST_DEMO)).today), before);

  assert.deepEqual(errors, []);
  assert.deepEqual(errors2, []);
  assert.deepEqual([...p1.perr, ...p2.perr], []);
  for (const c of [p1, p2]) await c.context.close();
  await hc.close();
});

test('一键重置：玩家页、主持人页只删自己的本机数据并重新载入；入口页可清空全部（语言选择保留）', async () => {
  const { context } = await newContext();
  const { page: player, errors } = await open(context, PLAYER);
  await tab(player, 'action');
  const nameInput = player.locator('.field', { hasText: '姓名' }).locator('input');
  await nameInput.fill('要被清掉的名字');
  await nameInput.press('Enter');
  await nameInput.blur();
  await player.waitForFunction(() => JSON.parse(localStorage.getItem('shelterpt_player:v1')).name === '要被清掉的名字');
  await playerDemo(player);
  await player.evaluate(() => {
    localStorage.setItem('shelterpt_host:v1', '{"keep":true}');
    localStorage.setItem('shelterpt_lang', 'zh');
    localStorage.setItem('unrelated-site-key', '1');
  });
  await tab(player, 'save');
  await btn(player, '一键重置').click();
  await modal(player).getByText('删除后无法恢复').waitFor();
  await Promise.all([player.waitForURL(/[?&]fresh=\d+/), modalBtn(player, '删除并重新载入')]);
  await player.locator('.tabs-primary').waitFor();
  const keys = await player.evaluate(() => Object.keys(localStorage).sort());
  assert.ok(!keys.includes(PLAYER_DEMO), '演示存档已删除');
  const fresh = await read(player, PLAYER_KEY);
  assert.equal(fresh ? fresh.name : '', '', '玩家存档回到空白');
  assert.equal(await player.evaluate(() => localStorage.getItem('shelterpt_host:v1')), '{"keep":true}', '主持人数据不受影响');
  assert.equal(await player.evaluate(() => localStorage.getItem('shelterpt_lang')), 'zh', '语言选择保留');
  assert.equal(await player.evaluate(() => localStorage.getItem('unrelated-site-key')), '1', '不碰别的网站数据');

  const { page: host, errors: hostErrors } = await open(context, HOST);
  await hostDemo(host);
  await tab(host, 'settings');
  await btn(host, '一键重置').click();
  await Promise.all([host.waitForURL(/[?&]fresh=\d+/), modalBtn(host, '删除并重新载入')]);
  await host.locator('[data-tab="settings"]').waitFor();
  assert.equal(await host.evaluate((k) => localStorage.getItem(k), HOST_DEMO), null, '主持人演示存档已删除');
  assert.notEqual(await host.evaluate((k) => localStorage.getItem(k), PLAYER_KEY), null, '玩家数据不受影响');

  // 入口页：清空两页的全部数据，语言选择保留
  const landing = await context.newPage();
  await landing.goto('file://' + join(ROOT, 'index.html'));
  landing.on('dialog', (d) => d.accept());
  await Promise.all([landing.waitForURL(/[?&]fresh=\d+/), landing.locator('#reset-btn').click()]);
  const left = await landing.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('shelterpt_')));
  assert.deepEqual(left, ['shelterpt_lang']);
  assert.deepEqual([...errors, ...hostErrors], []);
  await context.close();
});

// ---------------------------------------------------------------- 动画与音效（src/fx/）

const fxHas = (page, name, timeout = 5000) => page.waitForFunction((n) => window.ShelterFX.log.includes(n), name, { timeout });

async function fxPlayer(page, name, others) {
  await tab(page, 'action');
  const nameInput = page.locator('.field', { hasText: '姓名' }).locator('input');
  await nameInput.fill(name);
  await nameInput.press('Enter');
  await nameInput.blur();
  await page.waitForFunction(([k, n]) => (JSON.parse(localStorage.getItem(k)) || {}).name === n, [PLAYER_KEY, name]);
  await tab(page, 'save');
  await page.locator('.roster-card').getByRole('textbox', { name: '其他玩家的名字' }).fill(others.join('，'));
  await page.locator('.roster-card').getByRole('button', { name: '添加', exact: true }).click();
  await tab(page, 'action');
}

test('动画与音效·玩家：点亮行动、发牌翻牌、选中都有动画与音效；设置可关并记住；系统减少动态效果时不翻牌', async () => {
  const { context } = await newContext({ viewport: { width: 390, height: 844 } });
  const { page, errors } = await open(context, PLAYER);
  await fxPlayer(page, 'B·阿珍', ['A·老陈', 'C·胖虎', 'D·修女', 'E·二狗', 'F·教授']);
  await page.locator('[data-action="plan"]').click();
  await fxHas(page, 'light');
  await btn(page, '确认抽取守夜名单').click();
  await fxHas(page, 'deal');
  assert.equal(await page.locator('.watch-section .fx-cardback').count(), 2, '两张牌背朝上发出来');
  await page.waitForFunction(() => !document.querySelector('.fx-cardback'), null, { timeout: 4000 });
  await page.waitForFunction(() => ['deal', 'flip'].every((n) => window.ShelterFX.played.includes(n)), null, { timeout: 4000 });
  await page.locator('.watch-section .wcard').nth(1).click();
  await fxHas(page, 'select');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth), 0, '390px 宽没有横向溢出');

  // 设置：关掉音效与动画；点面板里的按钮不会把面板关掉；刷新后还记得
  await page.locator('.fx-pill').click();
  const panel = page.locator('.fx-panel');
  await panel.locator('.fx-row', { hasText: '音效' }).getByRole('button', { name: '关', exact: true }).click();
  await panel.locator('.fx-row', { hasText: '动画' }).getByRole('button', { name: '关', exact: true }).click();
  assert.ok(await panel.isVisible());
  await page.keyboard.press('Escape');
  assert.ok(!(await panel.isVisible()), 'Esc 收起面板');
  await page.reload();
  assert.deepEqual(await page.evaluate(() => window.ShelterFX.settings()), { motion: 'off', sound: false, volume: 0.6 });
  assert.equal(await page.locator('.fx-pill.muted').count(), 1, '静音时图标变灰');
  assert.equal(await page.evaluate(() => localStorage.getItem('shelterpt_fx')), JSON.stringify({ motion: 'off', sound: false, volume: 0.6 }));
  assert.deepEqual(errors, []);
  await context.close();

  // 系统开了「减少动态效果」：照样记效果，但不发牌翻面
  const rc = await browser.newContext({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce' });
  const { page: rp, errors: rerr } = await open(rc, PLAYER);
  await fxPlayer(rp, '甲', ['乙', '丙']);
  await rp.locator('[data-action="plan"]').click();
  await btn(rp, '确认抽取守夜名单').click();
  await fxHas(rp, 'deal');
  assert.equal(await rp.locator('.fx-cardback').count(), 0, '减少动态效果时没有牌背翻面');
  assert.equal(await rp.evaluate(() => window.ShelterFX.motion()), 'reduce');
  assert.deepEqual(rerr, []);
  await rc.close();
});

test('动画与音效·主持人：新的一天、换阶段、轮换座次、计时最后几秒与时间到都有效果；打开守夜链接只翻牌不出声', async () => {
  const { context } = await newContext();
  const { page: host, errors } = await open(context, HOST);
  await hostDemo(host);
  await tab(host, 'flow');
  await startDay1(host);
  await fxHas(host, 'dawn');
  await nextPhase(host); // 2
  await fxHas(host, 'phase');
  await nextPhase(host); // 3
  await nextPhase(host); // 4
  await btn(host, '执行每日轮换').click();
  await fxHas(host, 'shuffle');

  // 计时：设 3 秒，最后几秒滴答，到点响铃
  await tab(host, 'stage');
  const timer = host.locator('.timer').first();
  await timer.getByRole('button', { name: '自定义' }).click();
  await modal(host).locator('input').fill('3');
  await modalBtn(host, '设定');
  await timer.getByRole('button', { name: '开始' }).click();
  await fxHas(host, 'urgent');
  await fxHas(host, 'alarm', 6000);
  await host.waitForFunction(() => window.ShelterFX.played.includes('alarm'));

  // 守夜链接：卡片在弹窗里翻出来，但秘密页不出声
  const link = await host.evaluate(() => {
    const C = window.ShelterCore;
    const card = C.makeWatchCardV2(['A·老陈', 'B·阿珍', 'C·胖虎'], () => 0.5, C.defaultRules());
    return location.href.replace(/[#?].*$/, '') + C.watchLinkHash({ v: 2, day: 1, from: 'B·阿珍', card });
  });
  await host.goto(link);
  await host.check('#confirm-share-paused');
  const playedBefore = await host.evaluate(() => window.ShelterFX.played.length);
  const dealsBefore = await host.evaluate(() => window.ShelterFX.log.filter((n) => n === 'deal').length);
  await modalBtn(host, '查看卡片');
  await host.waitForFunction((n) => window.ShelterFX.log.filter((x) => x === 'deal').length > n, dealsBefore);
  await host.waitForTimeout(900);
  const newSounds = await host.evaluate((n) => window.ShelterFX.played.slice(n), playedBefore);
  assert.ok(!newSounds.includes('deal') && !newSounds.includes('flip'), '秘密弹窗里翻牌不出声：' + newSounds.join(','));
  assert.deepEqual(errors, []);
  await context.close();
});

test('动画与音效：设置面板中英文都没有残留；全屏展示时按钮隐藏', async () => {
  const { context } = await newContext({ init: () => localStorage.setItem('shelterpt_lang', 'en') });
  const { page, errors } = await open(context, PLAYER);
  await page.locator('.fx-pill').click();
  await page.locator('.fx-panel').waitFor();
  assert.deepEqual(await leftoverChinese(page), [], 'player panel');
  const { page: host } = await open(context, HOST);
  await host.locator('.fx-pill').click();
  assert.deepEqual(await leftoverChinese(host), [], 'host panel');
  await host.keyboard.press('Escape');
  await tab(host, 'stage');
  await host.locator('.present-btn').click();
  assert.ok(!(await host.locator('.fx-pill').isVisible()), '全屏展示时不显示动画音效按钮');
  assert.deepEqual(errors, []);
  await context.close();
});
