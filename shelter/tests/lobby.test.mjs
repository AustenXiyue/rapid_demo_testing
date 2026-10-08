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
  srv = createServer({ dbPath: ':memory:' });
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
