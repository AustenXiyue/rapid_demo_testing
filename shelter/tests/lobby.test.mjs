// 联机大厅浏览器验收：起一个真实服务端（内存数据库），两个浏览器分别当主导和玩家，走完注册 → 建局 → 加入 → 实时同步 → 释放座位。
// 运行：cd shelter && npm run test:lobby（需要 Playwright 的 Chromium）

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { chromium } from 'playwright';

const require = createRequire(import.meta.url);
const { createServer } = require('../server/index.js');

let browser, srv, base;

before(async () => {
  // 这个文件里注册的账户很多，放宽注册／登录的频率限制（限流本身由服务端测试覆盖）
  srv = createServer({ dbPath: ':memory:', rateLimit: { max: 1000, windowMs: 60000 } });
  await new Promise((r) => srv.server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${srv.server.address().port}/`;
  browser = await chromium.launch();
});

after(async () => {
  await browser.close();
  srv.io.close();
  await new Promise((r) => srv.server.close(r));
});

async function openPage() {
  const context = await browser.newContext();
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/status of 40\d/.test(m.text())) errors.push(m.text()); });
  await page.goto(base);
  return { context, page, errors };
}

async function register(page, name) {
  await page.getByRole('button', { name: '注册', exact: true }).click();
  await page.locator('input[name="username"]').fill(name);
  await page.locator('input[name="password"]').fill('password1');
  await page.getByRole('button', { name: '注册并登录' }).click();
  await page.locator('[data-entry="create"]').waitFor();
}

test('主导建局、玩家从公开列表和邀请码加入；座位、在线状态、开局与释放座位实时同步', async () => {
  const host = await openPage();
  const bob = await openPage();
  try {
    await register(host.page, '主导阿珍');
    await host.page.locator('#my-games').getByText('还没有对局').waitFor();

    await host.page.locator('[data-entry="create"]').click();
    const modal = host.page.locator('.modal');
    await modal.locator('input').first().fill('周五局');
    await modal.locator('input[type="number"]').fill('4');
    await modal.getByRole('button', { name: '创建', exact: true }).click();
    await host.page.waitForURL(/#game=/);
    const code = (await host.page.locator('#invite-code').textContent()).trim();
    assert.match(code, /^[A-Z2-9]{6}$/);
    await host.page.locator('[data-seat="1"]').getByText('主导阿珍').waitFor();

    // 玩家：公开列表里能看到，加入后进房间
    await register(bob.page, 'bob_01');
    await bob.page.locator('[data-entry="join"]').click();
    const row = bob.page.locator('#open-games .game-row', { hasText: '周五局' });
    await row.getByText('空位 3').waitFor();
    await row.getByRole('button', { name: '加入' }).click();
    await bob.page.waitForURL(/#game=/);
    await bob.page.locator('.seat.me', { hasText: 'bob_01' }).waitFor();

    // 主导那边实时看到 bob 入座且在线
    const bobSeat = host.page.locator('[data-seat="2"]');
    await bobSeat.getByText('bob_01').waitFor();
    await bobSeat.locator('.presence.on').waitFor();

    // 开局：玩家实时看到状态变化，招募期的「退出对局」消失
    await host.page.getByRole('button', { name: '开始对局' }).click();
    await bob.page.locator('.room-sub').getByText('进行中').waitFor();
    assert.equal(await bob.page.getByRole('button', { name: '退出对局' }).count(), 0);

    // 释放 bob 的座位：bob 被送回大厅，主导看到空座位
    await bobSeat.getByRole('button', { name: '释放座位' }).click();
    await host.page.locator('.modal').getByRole('button', { name: '释放座位' }).click();
    await host.page.locator('[data-seat="2"].open').getByText('空座位').waitFor();
    await bob.page.waitForURL((u) => !u.hash);
    await bob.page.locator('#my-games').getByText('还没有对局').waitFor();

    // 被释放的空座位：别人凭邀请码可以接手
    const carol = await openPage();
    try {
      await register(carol.page, 'carol_01');
      await carol.page.locator('[data-entry="join"]').click();
      await carol.page.locator('.code-input').fill(code.toLowerCase());
      await carol.page.getByRole('button', { name: '加入', exact: true }).click();
      await carol.page.locator('[data-seat="2"].me', { hasText: 'carol_01' }).waitFor();
      await host.page.locator('[data-seat="2"]').getByText('carol_01').waitFor();
      assert.deepEqual(carol.errors, []);
    } finally {
      await carol.context.close();
    }

    // 换设备：同一账户在新浏览器登录，「我的对局」里还在
    const phone = await openPage();
    try {
      await phone.page.locator('input[name="username"]').fill('主导阿珍');
      await phone.page.locator('input[name="password"]').fill('password1');
      await phone.page.getByRole('button', { name: '登录', exact: true }).last().click();
      const mine = phone.page.locator('#my-games .game-row', { hasText: '周五局' });
      await mine.getByText('主导兼角色').waitFor();
      await mine.getByRole('button', { name: '进入' }).click();
      await phone.page.locator('#invite-code', { hasText: code }).waitFor();
    } finally {
      await phone.context.close();
    }
    assert.deepEqual([...host.errors, ...bob.errors], []);
  } finally {
    await host.context.close();
    await bob.context.close();
  }
});

test('英文界面：登录页、大厅、加入页、房间都没有残留中文；刷新保持', async () => {
  const { context, page, errors } = await openPage();
  try {
    await page.getByRole('button', { name: 'EN' }).click();
    // 语言按钮本身显示「中文」，不算残留
    const han = async () => (await page.locator('body').innerText()).replace('中文', '').match(/[一-鿿]+/g);
    assert.equal(await han(), null, '登录页');
    await page.getByRole('button', { name: 'Register', exact: true }).click();
    await page.locator('input[name="username"]').fill('en_user');
    await page.locator('input[name="password"]').fill('password1');
    await page.getByRole('button', { name: 'Register and log in' }).click();
    await page.locator('[data-entry="create"]').waitFor();
    assert.equal(await han(), null, '大厅');

    await page.locator('[data-entry="create"]').click();
    assert.equal(await han(), null, '创建弹窗');
    await page.locator('.modal').getByRole('button', { name: 'Create', exact: true }).click();
    await page.waitForURL(/#game=/);
    await page.locator('#seats .seat').first().waitFor();
    assert.equal(await han(), null, '房间');
    await page.getByRole('button', { name: 'Start game' }).click();
    await page.locator('.room-sub').getByText('In progress').waitFor();
    assert.equal(await han(), null, '进行中的房间');

    await page.reload();
    await page.locator('#seats .seat').first().waitFor();
    assert.equal(await han(), null, '刷新后仍是英文');
    await page.getByRole('button', { name: '← Back to lobby' }).click();
    await page.locator('[data-entry="join"]').click();
    await page.locator('#open-games').getByText('No games to join right now.').waitFor();
    assert.equal(await han(), null, '加入页');
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

// ---------------------------------------------------------------- 面板接入服务器

// 玩家面板手机宽度下不常用的页收在「更多」里
async function tab(page, id) {
  const target = page.locator(`[data-tab="${id}"]`);
  if (!(await target.isVisible())) await page.click('.more-btn');
  await target.click();
}
const savedSeat = (page) => page.waitForResponse((r) => r.request().method() === 'PUT' && r.url().includes('/state/seat') && r.ok());

test('面板接入服务器：从房间进入面板；修改存到服务器，刷新和换设备都还在；主持人改名单玩家弹提示；暂停后只读', async () => {
  const host = await openPage();
  const bob = await openPage();
  const phone = await openPage();
  try {
    await register(host.page, 'host_zz');
    await host.page.locator('[data-entry="create"]').click();
    await host.page.locator('.modal input').first().fill('面板局');
    await host.page.locator('.modal').getByRole('button', { name: '创建', exact: true }).click();
    await host.page.waitForURL(/#game=/);
    const gameId = host.page.url().split('#game=')[1];
    const code = (await host.page.locator('#invite-code').textContent()).trim();
    await register(bob.page, 'bob_zz');
    await bob.page.locator('[data-entry="join"]').click();
    await bob.page.locator('.code-input').fill(code);
    await bob.page.locator('form.code-form').getByRole('button', { name: '加入', exact: true }).click();
    await bob.page.waitForURL(/#game=/);
    assert.equal(await bob.page.locator('#panels').count(), 0, '招募中还没有面板');

    await host.page.getByRole('button', { name: '开始对局' }).click();
    await host.page.locator('#panels').getByRole('link', { name: '进入主持人面板' }).click();
    await host.page.waitForURL(/host\.html\?game=/);
    await host.page.locator('.banner', { hasText: '联机对局' }).getByText('面板局').waitFor();

    // 玩家：房间里实时出现「进入玩家面板」；名字已经是账户名
    await bob.page.locator('#panels').getByRole('link', { name: '进入玩家面板' }).click();
    await bob.page.waitForURL(/player\.html\?game=/);
    await tab(bob.page, 'action');
    const nameInput = bob.page.locator('.field', { hasText: '姓名' }).locator('input');
    assert.equal(await nameInput.inputValue(), 'bob_zz');
    const saved = savedSeat(bob.page);
    await nameInput.fill('阿伯');
    await nameInput.press('Enter');
    await saved;
    await bob.page.reload();
    await tab(bob.page, 'action');
    assert.equal(await bob.page.locator('.field', { hasText: '姓名' }).locator('input').inputValue(), '阿伯', '刷新后从服务器载入');

    // 换设备：同一账户在另一个浏览器登录后直接打开面板
    await phone.page.locator('input[name="username"]').fill('bob_zz');
    await phone.page.locator('input[name="password"]').fill('password1');
    await phone.page.getByRole('button', { name: '登录', exact: true }).last().click();
    await phone.page.locator('[data-entry="create"]').waitFor();
    await phone.page.goto(base + 'player.html?game=' + gameId);
    await tab(phone.page, 'action');
    assert.equal(await phone.page.locator('.field', { hasText: '姓名' }).locator('input').inputValue(), '阿伯');

    // 主持人加一名玩家 → 玩家名单变了，在线的玩家面板弹出提示并已同步
    await host.page.locator('[data-tab="settings"]').click();
    const npc = host.page.locator('input[placeholder="玩家名字"]');
    await npc.fill('老王');
    await npc.press('Enter');
    await bob.page.locator('.modal', { hasText: '主持人更新了玩家名单' }).waitFor();
    await bob.page.locator('.modal').getByRole('button').click();
    await phone.page.locator('.modal', { hasText: '主持人更新了玩家名单' }).waitFor();

    // 暂停：玩家面板变成只读，改动被拦下
    const lobby = await host.context.newPage();
    await lobby.goto(base + '#game=' + gameId);
    await lobby.getByRole('button', { name: '暂停' }).click();
    await bob.page.locator('.banner', { hasText: '对局已暂停' }).waitFor();
    const input = bob.page.locator('.field', { hasText: '姓名' }).locator('input');
    await input.fill('偷偷改名');
    await input.press('Enter');
    await bob.page.locator('.toast', { hasText: '对局已暂停，现在只能查看' }).waitFor();
    await bob.page.reload();
    await tab(bob.page, 'action');
    assert.equal(await bob.page.locator('.field', { hasText: '姓名' }).locator('input').inputValue(), '阿伯', '暂停期间的修改没有保存');
    assert.deepEqual([...host.errors, ...bob.errors, ...phone.errors], []);
  } finally {
    await host.context.close();
    await bob.context.close();
    await phone.context.close();
  }
});

test('对局与私信：主持人推进阶段玩家实时看到；主持人「发送给」直达玩家收件箱，未读提示，玩家回复与玩家之间私聊；联机模式不再要求暂停屏幕共享', async () => {
  const host = await openPage();
  const bob = await openPage();
  const cat = await openPage();
  try {
    await register(host.page, 'host_msg');
    await host.page.locator('[data-entry="create"]').click();
    await host.page.locator('.modal input').first().fill('私信局');
    await host.page.locator('.modal').getByRole('button', { name: '创建', exact: true }).click();
    await host.page.waitForURL(/#game=/);
    const code = (await host.page.locator('#invite-code').textContent()).trim();
    for (const [p, n] of [[bob, 'bob_msg'], [cat, 'cat_msg']]) {
      await register(p.page, n);
      await p.page.locator('[data-entry="join"]').click();
      await p.page.locator('.code-input').fill(code);
      await p.page.locator('form.code-form').getByRole('button', { name: '加入', exact: true }).click();
      await p.page.waitForURL(/#game=/);
    }
    await host.page.getByRole('button', { name: '开始对局' }).click();
    await host.page.locator('#panels').getByRole('link', { name: '进入主持人面板' }).click();
    await host.page.waitForURL(/host\.html\?game=/);
    for (const p of [bob, cat]) {
      await p.page.locator('#panels').getByRole('link', { name: '进入玩家面板' }).click();
      await p.page.waitForURL(/player\.html\?game=/);
    }

    // 联机模式：没有「一键隐藏所有秘密」，秘密页直接显示
    assert.equal(await host.page.getByRole('button', { name: '一键隐藏所有秘密' }).count(), 0);
    await host.page.locator('[data-tab="supply"]').click();
    assert.equal(await host.page.locator('[data-gate]').count(), 0, '不再有「先暂停屏幕共享」的遮挡');

    // 公开信息：总览顶部一行 + 「对局」页随主持人推进实时变化
    await bob.page.locator('.pub-strip', { hasText: '开局准备' }).waitFor();
    await host.page.getByRole('button', { name: '开始第 1 天 →' }).click();
    await host.page.locator('.modal').getByRole('button', { name: '开始', exact: true }).click();
    await bob.page.locator('.pub-strip', { hasText: '第 1 天' }).waitFor();
    await tab(bob.page, 'game');
    await bob.page.locator('#public-board .pub-phase', { hasText: '昨夜结果' }).waitFor();
    await host.page.getByRole('button', { name: '下一阶段 →' }).click();
    await bob.page.locator('#public-board .pub-phase', { hasText: '资源补给' }).waitFor();

    // bob 正看着和 cat 的对话（默认打开的是主持人对话，看着的对话来了私信会直接算已读）
    await bob.page.locator('.msg-contact', { hasText: 'cat_msg' }).click();
    // 主持人在「记录与结算 → 私信分配记录」展开 bob 的私信文本，点「发送给 bob_msg」
    await host.page.locator('[data-tab="records"]').click();
    await host.page.locator('.card.inset').filter({ has: host.page.locator('b', { hasText: /^bob_msg$/ }) }).locator('summary', { hasText: '私信文本' }).click();
    await host.page.getByRole('button', { name: '发送给 bob_msg' }).click();
    await host.page.locator('.toast', { hasText: '私信已送达' }).waitFor();
    await cat.page.locator('[data-tab="game"] .tab-unread').waitFor({ state: 'detached', timeout: 1000 }).catch(() => {});
    assert.equal(await cat.page.locator('[data-tab="game"] .tab-unread').count(), 0, '别人收不到');
    // bob 在「对局」页但不在主持人的对话里：有未读数；点开后清零
    const hostContact = bob.page.locator('.msg-contact[data-contact="host"]');
    await hostContact.locator('.msg-unread').waitFor();
    await hostContact.click();
    await bob.page.locator('.msg-list .msg', { hasText: '【私信·身份】' }).waitFor();
    await hostContact.locator('.msg-unread').waitFor({ state: 'detached' });

    // 回复主持人：主持人的「私信」页实时出现
    await bob.page.locator('.msg-input').fill('收到，谢谢');
    await bob.page.locator('.msg-input').press('Enter');
    await host.page.locator('[data-tab="messages"] .tab-unread').waitFor();
    await host.page.locator('[data-tab="messages"]').click();
    await host.page.locator('.msg-list .msg', { hasText: '收到，谢谢' }).waitFor();

    // 玩家之间私聊：主持人看不到
    await bob.page.locator('.msg-contact', { hasText: 'cat_msg' }).click();
    await bob.page.locator('.msg-input').fill('结盟吗？');
    await bob.page.getByRole('button', { name: '发送', exact: true }).click();
    await bob.page.locator('.msg-list .msg.mine', { hasText: '结盟吗？' }).waitFor();
    await cat.page.locator('.toast', { hasText: '收到新私信' }).waitFor();
    await tab(cat.page, 'game');
    await cat.page.locator('.msg-contact', { hasText: 'bob_msg' }).click();
    await cat.page.locator('.msg-list .msg', { hasText: '结盟吗？' }).waitFor();
    assert.equal(await host.page.locator('.msg-contact', { hasText: 'cat_msg' }).locator('.msg-unread').count(), 0);
    assert.ok(!(await host.page.locator('body').innerText()).includes('结盟吗？'), '主持人看不到玩家之间的私信');

    // 刷新后私信还在
    await cat.page.reload();
    await tab(cat.page, 'game');
    await cat.page.locator('.msg-contact', { hasText: 'bob_msg' }).click();
    await cat.page.locator('.msg-list .msg', { hasText: '结盟吗？' }).waitFor();
    assert.deepEqual([...host.errors, ...bob.errors, ...cat.errors], []);
  } finally {
    await host.context.close();
    await bob.context.close();
    await cat.context.close();
  }
});

test('物品流转：玩家之间赠予与交易需要对方确认；交公由主持人接收入池；主持人记录补给选择后玩家接收入库', async () => {
  const host = await openPage();
  const bob = await openPage();
  const cat = await openPage();
  try {
    await register(host.page, 'host_tr');
    await host.page.locator('[data-entry="create"]').click();
    await host.page.locator('.modal input').first().fill('交接局');
    await host.page.locator('.modal').getByRole('button', { name: '创建', exact: true }).click();
    await host.page.waitForURL(/#game=/);
    const code = (await host.page.locator('#invite-code').textContent()).trim();
    for (const [p, n] of [[bob, 'bob_tr'], [cat, 'cat_tr']]) {
      await register(p.page, n);
      await p.page.locator('[data-entry="join"]').click();
      await p.page.locator('.code-input').fill(code);
      await p.page.locator('form.code-form').getByRole('button', { name: '加入', exact: true }).click();
      await p.page.waitForURL(/#game=/);
    }
    await host.page.getByRole('button', { name: '开始对局' }).click();
    await host.page.locator('#panels').getByRole('link', { name: '进入主持人面板' }).click();
    await host.page.waitForURL(/host\.html\?game=/);
    for (const p of [bob, cat]) {
      await p.page.locator('#panels').getByRole('link', { name: '进入玩家面板' }).click();
      await p.page.waitForURL(/player\.html\?game=/);
    }

    // 主持人凭空发给 bob：面包×3、子弹×2（bob 接收入库）
    await host.page.locator('[data-tab="supply"]').click();
    await host.page.getByRole('button', { name: '发放物品给玩家…' }).click();
    const gm = host.page.locator('.modal');
    await gm.locator('select').first().selectOption({ label: 'bob_tr' });
    await gm.getByRole('button', { name: '凭空给予' }).click();
    await gm.locator('input[placeholder="例如：面包×2，普通水"]').fill('面包×3，子弹×2');
    await gm.getByRole('button', { name: '发放', exact: true }).click();
    await bob.page.locator('.toast', { hasText: '收到交接' }).waitFor();
    await tab(bob.page, 'inventory');
    await bob.page.locator('#transfers .transfer').getByRole('button', { name: '接收' }).click();
    await bob.page.locator('.inv-card', { hasText: '面包' }).waitFor();

    // bob 赠予 cat 面包×1：先从 bob 扣下，cat 接收后才到 cat
    const bread = bob.page.locator('.inv-card', { hasText: '面包' });
    await bread.getByRole('button', { name: '赠予' }).click();
    const tm = bob.page.locator('.modal');
    await tm.locator('select').first().selectOption({ label: 'cat_tr' });
    await tm.locator('input[type="number"]').fill('1');
    await tm.getByRole('button', { name: '发起', exact: true }).click();
    await bob.page.locator('#transfers', { hasText: '你发出的' }).waitFor();
    await tab(cat.page, 'inventory');
    await cat.page.locator('#transfers .transfer', { hasText: '面包' }).getByRole('button', { name: '接收' }).click();
    await cat.page.locator('.inv-card', { hasText: '面包' }).waitFor();
    await bob.page.locator('.toast', { hasText: '对方已接收' }).waitFor();

    // 交易：bob 用子弹×1 换 cat 的面包×1，cat 确认后两边同时换手
    await bob.page.locator('.inv-card', { hasText: '子弹' }).getByRole('button', { name: '赠予' }).click();
    await tm.locator('select').first().selectOption({ label: 'cat_tr' });
    await tm.locator('input[type="number"]').fill('1');
    await tm.locator('input[placeholder^="例如：普通水×2"]').fill('面包×1');
    await tm.getByRole('button', { name: '发起', exact: true }).click();
    const trade = cat.page.locator('#transfers .transfer', { hasText: '换取' });
    await trade.getByRole('button', { name: '交易…' }).click();
    await cat.page.locator('.modal').getByRole('button', { name: '确认交易' }).click();
    await cat.page.locator('.inv-card', { hasText: '子弹' }).waitFor();
    await cat.page.locator('.inv-card', { hasText: '面包' }).waitFor({ state: 'detached' });

    // cat 把子弹交给公共池；主持人在补给页接收入池
    await cat.page.locator('.inv-card', { hasText: '子弹' }).getByRole('button', { name: '赠予' }).click();
    await cat.page.locator('.modal select').first().selectOption('host');
    await cat.page.locator('.modal').getByRole('button', { name: '发起', exact: true }).click();
    await host.page.locator('[data-tab="supply"] .tab-unread').waitFor();
    await host.page.locator('#transfers .transfer', { hasText: '交公' }).getByRole('button', { name: '接收' }).click();
    await host.page.locator('.card').filter({ has: host.page.locator('h2', { hasText: /^公共池$/ }) }).getByText('子弹').first().waitFor();

    // 主持人能在「记录与结算」看到全部交接
    await host.page.locator('[data-tab="records"]').click();
    const ledger = host.page.locator('#transfers', { hasText: '交接记录（全部）' });
    await ledger.locator('.transfer', { hasText: '交易' }).first().waitFor();
    assert.deepEqual([...host.errors, ...bob.errors, ...cat.errors], []);
  } finally {
    await host.context.close();
    await bob.context.close();
    await cat.context.close();
  }
});

test('玩家提交：行动、守夜卡片、换位、分数交给主持人，主持人「采用」打开预填的对话框后写进主持人存档；玩家天数跟随主持人', async () => {
  const host = await openPage();
  const bob = await openPage();
  const cat = await openPage();
  try {
    await register(host.page, 'host_sub');
    await host.page.locator('[data-entry="create"]').click();
    await host.page.locator('.modal input').first().fill('提交局');
    await host.page.locator('.modal').getByRole('button', { name: '只主持' }).click();
    await host.page.locator('.modal').getByRole('button', { name: '创建', exact: true }).click();
    await host.page.waitForURL(/#game=/);
    const code = (await host.page.locator('#invite-code').textContent()).trim();
    for (const [p, n] of [[bob, 'bob_sub'], [cat, 'cat_sub']]) {
      await register(p.page, n);
      await p.page.locator('[data-entry="join"]').click();
      await p.page.locator('.code-input').fill(code);
      await p.page.locator('form.code-form').getByRole('button', { name: '加入', exact: true }).click();
      await p.page.waitForURL(/#game=/);
    }
    await host.page.getByRole('button', { name: '开始对局' }).click();
    await host.page.locator('#panels').getByRole('link', { name: '进入主持人面板' }).click();
    await host.page.waitForURL(/host\.html\?game=/);
    for (const p of [bob, cat]) {
      await p.page.locator('#panels').getByRole('link', { name: '进入玩家面板' }).click();
      await p.page.waitForURL(/player\.html\?game=/);
    }

    // 主持人开始第 1 天并推进到「个人行动」；玩家页的天数跟着变
    await host.page.getByRole('button', { name: '开始第 1 天 →' }).click();
    await host.page.locator('.modal').getByRole('button', { name: '开始', exact: true }).click();
    for (let i = 0; i < 4; i++) {
      await host.page.getByRole('button', { name: '下一阶段 →' }).click();
      const m = host.page.locator('.modal');
      if (await m.count()) await m.getByRole('button').last().click();
    }
    const gen = host.page.getByRole('button', { name: '按当前座次生成行动顺序' });
    if (await gen.count()) await gen.click();
    await bob.page.locator('.p-day', { hasText: '第 1 天' }).waitFor();
    assert.equal(await bob.page.locator('.p-day button').count(), 0, '联机时玩家不能自己改天数');

    // 行动：bob 点亮「计划守夜名单」→ 主持人在「玩家提交」里采用 → 记录行动对话框已选好类型
    await tab(bob.page, 'action');
    await bob.page.locator('[data-action="plan"]').click();
    const subCard = host.page.locator('#submissions');
    await subCard.locator('.sub-line', { hasText: '计划守夜名单' }).getByRole('button', { name: '采用' }).click();
    await host.page.locator('.modal').getByRole('button', { name: '计划守夜名单', pressed: true }).waitFor();
    await host.page.locator('.modal').getByRole('button', { name: '记录', exact: true }).click();
    await bob.page.locator('.toast', { hasText: '主持人已采用' }).last().waitFor();
    await host.page.locator('tr[data-player]', { hasText: 'bob_sub' }).getByText('✓ 已行动').waitFor();
    await bob.page.locator('[data-action="pass"]').click();
    await bob.page.locator('.toast', { hasText: '不能再改' }).waitFor();

    // 守夜卡片：bob 抽卡、选一张、提交；主持人在「守夜」页采用 → 进入候选池
    await bob.page.getByRole('button', { name: '确认抽取守夜名单' }).click();
    await bob.page.locator('.wcard').first().click();
    await bob.page.getByRole('button', { name: '提交给主持人' }).click();
    await host.page.locator('[data-tab="watch"]').click();
    await host.page.locator('.sub-line', { hasText: '守夜卡片' }).getByRole('button', { name: '采用' }).click();
    await host.page.locator('.modal').getByRole('button', { name: '加入今天的候选池' }).click();
    await host.page.locator('[data-planner]', { hasText: 'bob_sub' }).waitFor();

    // 换位：cat 请求和 bob 换 → bob 同意 → 主持人采用（结果已按 bob 的回答填好）→ 座次交换
    await tab(cat.page, 'action');
    await cat.page.locator('[data-action="swap"]').click();
    await cat.page.locator('.modal select').selectOption({ label: 'bob_sub' });
    await cat.page.locator('.modal').getByRole('button', { name: '发出请求' }).click();
    await bob.page.locator('.toast', { hasText: '有人想和你换位' }).waitFor();
    await tab(bob.page, 'game');
    const seatsBefore = await bob.page.evaluate(() => [...document.querySelectorAll('#public-board .pub-seats li')].map((li) => li.textContent.replace(/(末位|你)/g, '')).join('|'));
    await bob.page.locator('#asks').getByRole('button', { name: '同意' }).click();
    await host.page.locator('[data-tab="flow"]').click();
    await host.page.locator('tr[data-player]', { hasText: 'cat_sub' }).locator('.sub-line', { hasText: '对方同意' }).getByRole('button', { name: '采用' }).click();
    await host.page.locator('.modal').getByRole('button', { name: '对方同意', pressed: true }).waitFor();
    await host.page.locator('.modal').getByRole('button', { name: '记录，行动结束' }).click();
    // 座次里 bob 与 cat 的先后对调了
    await bob.page.waitForFunction((before) => {
      const order = [...document.querySelectorAll('#public-board .pub-seats li')].map((li) => li.textContent.replace(/(末位|你)/g, ''));
      return order.join('|') !== before;
    }, seatsBefore);

    // 分数：bob 上报 → 主持人采用 → 分数表里填好件数
    await tab(bob.page, 'score');
    await bob.page.getByRole('button', { name: '提交给主持人' }).click();
    await subCard.locator('.sub-line', { hasText: '分数上报' }).getByRole('button', { name: '采用' }).click();
    await bob.page.locator('.toast', { hasText: '主持人已采用' }).last().waitFor();
    await host.page.locator('[data-tab="records"]').click();
    const row = host.page.locator('table.scores tr', { hasText: 'bob_sub' });
    assert.equal(await row.locator('input[aria-label="cash"]').inputValue(), '0');
    assert.deepEqual([...host.errors, ...bob.errors, ...cat.errors], []);
  } finally {
    await host.context.close();
    await bob.context.close();
    await cat.context.close();
  }
});

test('站内投票：主持人从事件流程发起；玩家投票、改票，投票中看不到票数；主持人实时计票、结束后采用结果＝录入投票结果；通用投票', async () => {
  const host = await openPage();
  const bob = await openPage();
  const cat = await openPage();
  try {
    await register(host.page, 'host_poll');
    await host.page.locator('[data-entry="create"]').click();
    await host.page.locator('.modal input').first().fill('投票局');
    await host.page.locator('.modal').getByRole('button', { name: '只主持' }).click();
    await host.page.locator('.modal').getByRole('button', { name: '创建', exact: true }).click();
    await host.page.waitForURL(/#game=/);
    const gameId = host.page.url().split('#game=')[1];
    const code = (await host.page.locator('#invite-code').textContent()).trim();
    for (const [p, n] of [[bob, 'bob_poll'], [cat, 'cat_poll']]) {
      await register(p.page, n);
      await p.page.locator('[data-entry="join"]').click();
      await p.page.locator('.code-input').fill(code);
      await p.page.locator('form.code-form').getByRole('button', { name: '加入', exact: true }).click();
      await p.page.waitForURL(/#game=/);
    }
    await host.page.getByRole('button', { name: '开始对局' }).click();
    // 事件库里放一件带两个投票选项的事件（等于主持人事先录入，这里直接写主持人存档）
    await host.page.evaluate(async (id) => {
      const cur = await (await fetch('api/games/' + id + '/state/host')).json();
      const fx = () => ({ rescue: null, pool: [], personal: { target: '', hp: null, hunger: null, thirst: '', status: '', items: [], mapNotes: null, note: '' } });
      cur.state.events.push({ id: 'ev_gen', name: '发电机', body: '要不要修？', location: '', tags: [], isDraft: false, isDemo: false,
        participants: '', carryTicks: null, conditions: '', itemUses: '', modifiers: '', options: [
          { id: 'op_fix', label: '修', outcomes: [{ id: 'oc1', text: '灯亮了', probability: 100, effects: fx() }] },
          { id: 'op_run', label: '不修', outcomes: [{ id: 'oc2', text: '一片漆黑', probability: 100, effects: fx() }] }] });
      await fetch('api/games/' + id + '/state/host', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ version: cur.version, state: cur.state }) });
    }, gameId);
    await host.page.locator('#panels').getByRole('link', { name: '进入主持人面板' }).click();
    await host.page.waitForURL(/host\.html\?game=/);
    for (const p of [bob, cat]) {
      await p.page.locator('#panels').getByRole('link', { name: '进入玩家面板' }).click();
      await p.page.waitForURL(/player\.html\?game=/);
      await tab(p.page, 'game');
    }

    // 主持人：公共事件页手动选事件 → 第 2 步「发起站内投票」
    await host.page.locator('[data-tab="events"]').click();
    await host.page.locator('select').filter({ hasText: '手动选择事件' }).selectOption('ev_gen');
    await host.page.getByRole('button', { name: '使用所选事件' }).click();
    await host.page.getByRole('button', { name: '发起站内投票' }).click();
    await host.page.locator('.modal').getByRole('button', { name: '发起', exact: true }).click();

    // 玩家：投票（bob 先投「修」再改「不修」），投票中看不到票数
    await bob.page.locator('.toast', { hasText: '有新的投票' }).waitFor();
    const bobPoll = bob.page.locator('#polls .poll');
    await bobPoll.getByRole('button', { name: 'A. 修' }).click();
    await bobPoll.getByRole('button', { name: 'A. 修', pressed: true }).waitFor();
    await bobPoll.getByRole('button', { name: 'B. 不修' }).click();
    await bobPoll.getByRole('button', { name: 'B. 不修', pressed: true }).waitFor();
    await cat.page.locator('#polls .poll').getByRole('button', { name: 'B. 不修' }).click();
    await bob.page.locator('#polls .poll', { hasText: '已投 2／2 人' }).waitFor();
    assert.equal(await bobPoll.locator('.poll-count').count(), 0, '投票中玩家看不到票数');

    // 主持人：实时计票（谁投了什么）→ 结束 → 采用「不修」→ 事件流程的投票结果已录入
    const hostPoll = host.page.locator('.poll', { hasText: '发电机' });
    await hostPoll.locator('.poll-option', { hasText: '不修' }).getByText('2 票').waitFor();
    await hostPoll.locator('.poll-option', { hasText: '不修' }).getByText('bob_poll、cat_poll').waitFor();
    await hostPoll.getByRole('button', { name: '结束投票' }).click();
    await bob.page.locator('#polls .poll-option', { hasText: '不修' }).getByText('2 票').waitFor();
    await host.page.getByRole('button', { name: '采用「不修」' }).click();
    await host.page.getByText('投票结果：不修').waitFor();

    // 通用投票：主持台「发起投票…」
    await host.page.locator('[data-tab="flow"]').click();
    await host.page.locator('#polls').getByRole('button', { name: '发起投票…' }).click();
    const m = host.page.locator('.modal');
    await m.locator('input[type="text"]').first().fill('今晚吃什么');
    await m.locator('textarea[placeholder="每行一个选项"]').fill('面包\n罐头');
    await m.getByRole('button', { name: '发起', exact: true }).click();
    await cat.page.locator('#polls .poll', { hasText: '今晚吃什么' }).getByRole('button', { name: 'B. 罐头' }).click();
    await host.page.locator('#polls .poll-option', { hasText: '罐头' }).getByText('1 票').waitFor();
    assert.deepEqual([...host.errors, ...bob.errors, ...cat.errors], []);
  } finally {
    await host.context.close();
    await bob.context.close();
    await cat.context.close();
  }
});

test('修复回归：补给候选只发给轮到的人、玩家自己选、主持人采用后入库并自动问下一位；领完自动结束；标记死亡同步到本人；接手的人显示「角色名（账户名）」', async () => {
  const host = await openPage();
  const bob = await openPage();
  const cat = await openPage();
  try {
    await register(host.page, 'host_fix');
    await host.page.locator('[data-entry="create"]').click();
    await host.page.locator('.modal input').first().fill('回归局');
    await host.page.locator('.modal').getByRole('button', { name: '只主持' }).click();
    await host.page.locator('.modal').getByRole('button', { name: '创建', exact: true }).click();
    await host.page.waitForURL(/#game=/);
    const gameId = host.page.url().split('#game=')[1];
    const code = (await host.page.locator('#invite-code').textContent()).trim();
    for (const [p, n] of [[bob, 'bob_fix'], [cat, 'cat_fix']]) {
      await register(p.page, n);
      await p.page.locator('[data-entry="join"]').click();
      await p.page.locator('.code-input').fill(code);
      await p.page.locator('form.code-form').getByRole('button', { name: '加入', exact: true }).click();
      await p.page.waitForURL(/#game=/);
    }
    await host.page.getByRole('button', { name: '开始对局' }).click();
    await host.page.locator('#panels').getByRole('link', { name: '进入主持人面板' }).click();
    await host.page.waitForURL(/host\.html\?game=/);
    for (const p of [bob, cat]) {
      await p.page.locator('#panels').getByRole('link', { name: '进入玩家面板' }).click();
      await p.page.waitForURL(/player\.html\?game=/);
      await tab(p.page, 'game');
    }

    // 公共池放 3 件，开一批每日补给（2 人领）
    await host.page.locator('[data-tab="supply"]').click();
    await host.page.locator('textarea[placeholder^="例如：面包×3"]').fill('面包，普通水，绷带');
    await host.page.getByRole('button', { name: '解析并执行' }).click();
    await host.page.locator('.card', { hasText: '新建发放批次' }).getByRole('button', { name: '抽取', exact: true }).click();

    // 只有轮到的 bob 收到候选；cat 没有
    const bobAsk = bob.page.locator('#asks li', { hasText: '轮到你领取' });
    await bobAsk.waitFor();
    assert.equal(await cat.page.locator('#asks').count(), 0, '没轮到的人看不到候选');
    await bobAsk.getByRole('button').nth(1).click();
    const bobRow = host.page.locator('tr[data-picker]', { hasText: 'bob_fix' });
    await bobRow.getByText('玩家选了').waitFor();
    const picked = (await bobRow.innerText()).match(/玩家选了：(\S+)/)[1];
    await bobRow.getByRole('button', { name: '采用玩家的选择' }).click();
    // bob 收到这件补给，接收入库；cat 接着被问
    await tab(bob.page, 'inventory');
    await bob.page.locator('#transfers .transfer', { hasText: picked }).getByRole('button', { name: '接收' }).click();
    await bob.page.locator('.inv-card', { hasText: picked }).waitFor();
    const catAsk = cat.page.locator('#asks li', { hasText: '轮到你领取' });
    await catAsk.waitFor();
    assert.ok(!(await catAsk.innerText()).includes(picked), '被选走的那件不再出现在候选里');
    await catAsk.getByRole('button').first().click();
    await host.page.locator('tr[data-picker]', { hasText: 'cat_fix' }).getByRole('button', { name: '采用玩家的选择' }).click();
    // 两人都领完：批次自动结束（剩下的一件回公共池），不再有「结束批次」按钮
    await host.page.waitForFunction(async (id) => {
      const d = await (await fetch('api/games/' + id + '/state/host')).json();
      const b = d.state.batches.at(-1);
      return b.status === 'closed' && b.picks.length === 2 && d.state.pool.length === 1;
    }, gameId);
    assert.equal(await host.page.getByRole('button', { name: '结束批次（未选的放回公共池）' }).count(), 0);

    // 标记 cat 死亡：cat 自己的页面跟着变，弹出提示
    await host.page.locator('[data-tab="settings"]').click();
    await host.page.locator('.card', { hasText: '玩家名单' }).locator('input[type="checkbox"]').nth(1).check();
    await cat.page.locator('.modal', { hasText: '主持人把你标记为已死亡' }).waitFor();
    await cat.page.locator('.modal').getByRole('button').last().click();
    await tab(cat.page, 'dashboard');
    await cat.page.getByText('已死亡').first().waitFor();

    // 释放 bob 的座位，新账户接手：显示「角色名（账户名）」
    const lobby = await host.context.newPage();
    await lobby.goto(base + '#game=' + gameId);
    await lobby.locator('#seats .seat', { hasText: 'bob_fix' }).getByRole('button', { name: '释放座位' }).click();
    await lobby.locator('.modal').getByRole('button', { name: '释放座位' }).click();
    const dan = await openPage();
    try {
      await register(dan.page, 'dan_fix');
      await dan.page.locator('[data-entry="join"]').click();
      await dan.page.locator('#open-games .game-row', { hasText: '回归局' }).getByRole('button', { name: '接手空座位' }).click();
      await dan.page.waitForURL(/#game=/);
      await dan.page.locator('#seats .seat-name', { hasText: 'bob_fix（dan_fix）' }).waitFor();
      await tab(cat.page, 'game');
      await cat.page.locator('.msg-contact', { hasText: 'bob_fix（dan_fix）' }).waitFor();
    } finally {
      await dan.context.close();
    }
    assert.deepEqual([...host.errors, ...bob.errors, ...cat.errors], []);
  } finally {
    await host.context.close();
    await bob.context.close();
    await cat.context.close();
  }
});
