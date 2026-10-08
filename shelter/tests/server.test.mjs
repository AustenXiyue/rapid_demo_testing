// 服务端测试：每组用内存数据库起一个真实的 HTTP + Socket.IO 服务，走真实请求。
//   npm run test:server

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { io as connect } from 'socket.io-client';

const require = createRequire(import.meta.url);
const { createServer } = require('../server/index.js');
const { setPassword } = require('../server/auth.js');

async function start(t, opts = {}) {
  const s = createServer({ dbPath: ':memory:', ...opts });
  await new Promise((resolve) => s.server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => { s.io.close(); s.server.close(resolve); }));
  const base = `http://127.0.0.1:${s.server.address().port}`;
  async function call(path, { body, cookie, headers = {} } = {}) {
    const res = await fetch(base + path, {
      method: body ? 'POST' : 'GET',
      headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}), ...headers },
      body: body ? JSON.stringify(body) : undefined,
    });
    const setCookie = res.headers.get('set-cookie') || '';
    const m = /shelterpt_sid=([^;]*)/.exec(setCookie);
    const data = (res.headers.get('content-type') || '').includes('json') ? await res.json() : await res.text();
    return { status: res.status, data, setCookie, cookie: m && m[1] ? 'shelterpt_sid=' + m[1] : null };
  }
  return { ...s, base, call };
}

function socketHello(base, cookie) {
  return new Promise((resolve, reject) => {
    const sock = connect(base, { path: '/socket.io', transports: ['websocket'], extraHeaders: cookie ? { Cookie: cookie } : {}, reconnection: false });
    sock.on('hello', (msg) => { sock.close(); resolve(msg); });
    sock.on('connect_error', (e) => { sock.close(); reject(e); });
  });
}

test('健康检查与静态页面：只公开页面文件，源码与数据不对外', async (t) => {
  const { call } = await start(t);
  assert.deepEqual((await call('/healthz')).data, { ok: true });
  for (const p of ['/', '/index.html', '/account.html', '/host.html', '/player.html']) assert.equal((await call(p)).status, 200, p);
  for (const p of ['/server/auth.js', '/src/shared/core.js', '/package.json', '/data/shelter.db', '/tests/server.test.mjs']) {
    assert.equal((await call(p)).status, 404, p);
  }
});

test('注册：拿到唯一 ID 和 httpOnly 会话 cookie，/api/me 认得出', async (t) => {
  const { call } = await start(t);
  const r = await call('/api/register', { body: { username: '阿珍_01', password: 'password1' } });
  assert.equal(r.status, 200);
  assert.match(r.data.user.id, /^[0-9a-f-]{36}$/);
  assert.equal(r.data.user.username, '阿珍_01');
  assert.match(r.setCookie, /HttpOnly/i);
  assert.match(r.setCookie, /Path=\/(;|$)/);
  assert.match(r.setCookie, /SameSite=Lax/i);
  assert.doesNotMatch(r.setCookie, /Secure/i, '本地 http 不加 Secure');
  assert.deepEqual((await call('/api/me', { cookie: r.cookie })).data.user, r.data.user);
  assert.equal((await call('/api/me')).data.user, null);
  assert.equal((await call('/api/me', { cookie: 'shelterpt_sid=forged' })).data.user, null);
});

test('注册校验：用户名格式、密码长度、用户名不分大小写不能重复', async (t) => {
  const { call } = await start(t);
  assert.equal((await call('/api/register', { body: { username: 'ab', password: 'password1' } })).data.error, 'bad_username');
  assert.equal((await call('/api/register', { body: { username: 'a b c', password: 'password1' } })).data.error, 'bad_username');
  assert.equal((await call('/api/register', { body: { username: 'alice', password: 'short' } })).data.error, 'bad_password');
  assert.equal((await call('/api/register', { body: { username: 'alice' } })).status, 400);
  assert.equal((await call('/api/register', { body: { username: 'Alice', password: 'password1' } })).status, 200);
  const dup = await call('/api/register', { body: { username: 'alice', password: 'password2' } });
  assert.equal(dup.status, 409);
  assert.equal(dup.data.error, 'username_taken');
});

test('登录：多台设备各自一个会话，登出只影响当前设备', async (t) => {
  const { call } = await start(t);
  const reg = await call('/api/register', { body: { username: 'bob', password: 'password1' } });
  assert.equal((await call('/api/login', { body: { username: 'bob', password: 'wrong-pass' } })).status, 401);
  assert.equal((await call('/api/login', { body: { username: 'nobody', password: 'password1' } })).data.error, 'wrong_credentials');
  const phone = await call('/api/login', { body: { username: 'BOB', password: 'password1' } });
  assert.equal(phone.status, 200);
  assert.equal(phone.data.user.id, reg.data.user.id, '同一个账户，同一个 ID');
  assert.notEqual(phone.cookie, reg.cookie);

  const out = await call('/api/logout', { body: {}, cookie: phone.cookie });
  assert.match(out.setCookie, /shelterpt_sid=;/);
  assert.equal((await call('/api/me', { cookie: phone.cookie })).data.user, null, '手机已登出');
  assert.equal((await call('/api/me', { cookie: reg.cookie })).data.user.username, 'bob', '电脑仍然在线');
});

test('子路径部署：cookie 的 Path 用对外前缀；经 HTTPS 反代时加 Secure', async (t) => {
  const { call } = await start(t, { basePath: '/Misc/ShelterPT/' });
  const r = await call('/api/register', { body: { username: 'carol', password: 'password1' }, headers: { 'X-Forwarded-Proto': 'https' } });
  assert.match(r.setCookie, /Path=\/Misc\/ShelterPT\//);
  assert.match(r.setCookie, /Secure/);
});

test('Socket.IO：带着会话 cookie 才能连上，并认出是哪个账户', async (t) => {
  const { base, call } = await start(t);
  const r = await call('/api/register', { body: { username: 'dave', password: 'password1' } });
  assert.deepEqual((await socketHello(base, r.cookie)).user, r.data.user);
  await assert.rejects(socketHello(base, null), /unauthorized/);
  await assert.rejects(socketHello(base, 'shelterpt_sid=forged'), /unauthorized/);
});

test('频率限制：同一 IP 注册／登录太频繁时返回 429', async (t) => {
  const { call } = await start(t, { rateLimit: { max: 3, windowMs: 60000 } });
  for (let i = 0; i < 3; i++) assert.equal((await call('/api/login', { body: { username: 'x', password: 'password1' } })).status, 401);
  const r = await call('/api/login', { body: { username: 'x', password: 'password1' } });
  assert.equal(r.status, 429);
  assert.equal(r.data.error, 'rate_limited');
});

test('管理员重置密码：旧密码失效、新密码可用、所有设备下线', async (t) => {
  const { call, db } = await start(t);
  const r = await call('/api/register', { body: { username: 'erin', password: 'password1' } });
  assert.equal(await setPassword(db, 'ERIN', 'temporary9'), true);
  assert.equal(await setPassword(db, 'nobody', 'temporary9'), false);
  assert.equal((await call('/api/me', { cookie: r.cookie })).data.user, null);
  assert.equal((await call('/api/login', { body: { username: 'erin', password: 'password1' } })).status, 401);
  assert.equal((await call('/api/login', { body: { username: 'erin', password: 'temporary9' } })).status, 200);
});
