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
  async function call(path, { body, cookie, method, headers = {} } = {}) {
    const res = await fetch(base + path, {
      method: method || (body ? 'POST' : 'GET'),
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
  for (const p of ['/', '/index.html', '/host.html', '/player.html']) assert.equal((await call(p)).status, 200, p);
  for (const p of ['/account.html', '/server/auth.js', '/src/shared/core.js', '/package.json', '/data/shelter.db', '/tests/server.test.mjs']) {
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

// ---------------------------------------------------------------- 大厅与对局

async function users(call, ...names) {
  const out = {};
  for (const n of names) {
    const r = await call('/api/register', { body: { username: n, password: 'password1' } });
    out[n] = { id: r.data.user.id, cookie: r.cookie };
  }
  return out;
}

const del = async (call, id, who) => (await call('/api/games/' + id, { method: 'DELETE', cookie: who.cookie })).status;

// 带事件记录的 Socket：waitFor 等到某个事件满足条件（之前已经收到的也算）
function sock(base, cookie) {
  const s = connect(base, { path: '/socket.io', transports: ['websocket'], extraHeaders: { Cookie: cookie }, reconnection: false });
  const seen = [];
  const waiters = [];
  s.onAny((ev, data) => {
    seen.push([ev, data]);
    for (const w of waiters.slice()) if (w.ev === ev && w.pred(data)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(data); }
  });
  s.waitFor = (ev, pred = () => true) => {
    const hit = seen.find(([e, d]) => e === ev && pred(d));
    if (hit) return Promise.resolve(hit[1]);
    return new Promise((resolve, reject) => {
      waiters.push({ ev, pred, resolve });
      setTimeout(() => reject(new Error('等不到 ' + ev)), 3000);
    });
  };
  s.clearSeen = () => { seen.length = 0; };
  return new Promise((resolve, reject) => { s.on('hello', () => resolve(s)); s.on('connect_error', reject); });
}

test('新建对局：邀请码、主导是否占座位；只有成员看得到；未登录 401', async (t) => {
  const { call } = await start(t);
  const { host, other } = await users(call, 'host', 'other');
  assert.equal((await call('/api/games')).status, 401);
  assert.equal((await call('/api/games', { body: { title: ' ', maxSeats: 6 }, cookie: host.cookie })).data.error, 'bad_title');
  assert.equal((await call('/api/games', { body: { title: 'x', maxSeats: 13 }, cookie: host.cookie })).data.error, 'bad_max_seats');

  const a = (await call('/api/games', { body: { title: '  第一局 ', maxSeats: 6, hostPlays: true }, cookie: host.cookie })).data.game;
  assert.equal(a.title, '第一局');
  assert.match(a.code, /^[A-HJKMNP-Z2-9]{6}$/);
  assert.equal(a.status, 'lobby');
  assert.deepEqual(a.seats.map((s) => [s.seatNo, s.user.id]), [[1, host.id]]);
  const b = (await call('/api/games', { body: { title: '只主持', maxSeats: 4 }, cookie: host.cookie })).data.game;
  assert.deepEqual(b.seats, []);

  const mine = (await call('/api/games', { cookie: host.cookie })).data.games;
  assert.deepEqual(mine.map((g) => [g.title, g.role, g.taken, g.free]).sort(), [['只主持', 'host', 0, 4], ['第一局', 'host-player', 1, 5]]);
  assert.equal((await call('/api/games/' + a.id, { cookie: other.cookie })).status, 404, '非成员看不到详情');
  assert.deepEqual((await call('/api/games', { cookie: other.cookie })).data.games, []);
  assert.deepEqual((await call('/api/games/open', { cookie: host.cookie })).data.games, [], '公开列表不含自己的对局');
});

test('加入：邀请码（不分大小写）或公开列表；人满为止；重复加入不占第二个座位', async (t) => {
  const { call } = await start(t);
  const { host, pl1, pl2, pl3 } = await users(call, 'host', 'pl1', 'pl2', 'pl3');
  const g = (await call('/api/games', { body: { title: '两人局', maxSeats: 2 }, cookie: host.cookie })).data.game;

  const open = (await call('/api/games/open', { cookie: pl1.cookie })).data.games;
  assert.deepEqual(open.map((x) => [x.id, x.owner.username, x.free]), [[g.id, 'host', 2]]);
  assert.equal((await call('/api/games/join', { body: { code: 'ZZZZZZ' }, cookie: pl1.cookie })).data.error, 'bad_code');
  assert.equal((await call('/api/games/join', { body: { code: ' ' + g.code.toLowerCase() }, cookie: pl1.cookie })).data.id, g.id);
  assert.equal((await call('/api/games/join', { body: { code: g.code }, cookie: pl1.cookie })).data.id, g.id, '再加一次不报错');
  assert.equal((await call(`/api/games/${g.id}/join`, { body: {}, cookie: pl2.cookie })).data.id, g.id);
  assert.equal((await call(`/api/games/${g.id}/join`, { body: {}, cookie: pl3.cookie })).data.error, 'game_full');
  assert.deepEqual((await call('/api/games/open', { cookie: pl3.cookie })).data.games, [], '满员后不在公开列表');

  const view = (await call('/api/games/' + g.id, { cookie: pl1.cookie })).data.game;
  assert.deepEqual(view.seats.map((s) => [s.seatNo, s.user.username]), [[1, 'pl1'], [2, 'pl2']]);
  assert.equal((await call('/api/games', { cookie: pl1.cookie })).data.games[0].role, 'player');
});

test('招募阶段：主导移除玩家、切换是否占座位；玩家退出；只有主导能管理', async (t) => {
  const { call } = await start(t);
  const { host, pl1, pl2 } = await users(call, 'host', 'pl1', 'pl2');
  const g = (await call('/api/games', { body: { title: '局', maxSeats: 2 }, cookie: host.cookie })).data.game;
  await call('/api/games/join', { body: { code: g.code }, cookie: pl1.cookie });
  await call('/api/games/join', { body: { code: g.code }, cookie: pl2.cookie });
  assert.equal((await call(`/api/games/${g.id}/host-plays`, { body: { on: true }, cookie: host.cookie })).data.error, 'game_full');

  let view = (await call('/api/games/' + g.id, { cookie: host.cookie })).data.game;
  const p1Seat = view.seats.find((s) => s.user.id === pl1.id);
  assert.equal((await call(`/api/games/${g.id}/seats/${p1Seat.id}`, { body: { action: 'remove' }, cookie: pl2.cookie })).status, 403);
  assert.equal((await call(`/api/games/${g.id}/seats/${p1Seat.id}`, { body: { action: 'release' }, cookie: host.cookie })).data.error, 'not_started');
  assert.equal((await call(`/api/games/${g.id}/seats/${p1Seat.id}`, { body: { action: 'remove' }, cookie: host.cookie })).status, 200);
  assert.equal((await call('/api/games/' + g.id, { cookie: pl1.cookie })).status, 404, '被移除后看不到');

  view = (await call(`/api/games/${g.id}/host-plays`, { body: { on: true }, cookie: host.cookie })).data.game;
  assert.deepEqual(view.seats.map((s) => [s.seatNo, s.user.username]), [[1, 'host'], [2, 'pl2']], '主导补上空出来的 1 号');
  assert.equal((await call(`/api/games/${g.id}/seats/${view.seats[0].id}`, { body: { action: 'remove' }, cookie: host.cookie })).data.error, 'use_host_plays');
  view = (await call(`/api/games/${g.id}/host-plays`, { body: { on: false }, cookie: host.cookie })).data.game;
  assert.deepEqual(view.seats.map((s) => s.user.username), ['pl2']);

  assert.equal((await call(`/api/games/${g.id}/leave`, { body: {}, cookie: host.cookie })).data.error, 'owner_cannot_leave');
  assert.equal((await call(`/api/games/${g.id}/leave`, { body: {}, cookie: pl2.cookie })).status, 200);
  assert.deepEqual((await call('/api/games', { cookie: pl2.cookie })).data.games, []);
});

test('状态流转：开始需要至少一名玩家；暂停／继续／结束；非法跳转与非主导被拒', async (t) => {
  const { call } = await start(t);
  const { host, pl1 } = await users(call, 'host', 'pl1');
  const g = (await call('/api/games', { body: { title: '局', maxSeats: 3 }, cookie: host.cookie })).data.game;
  const status = (s, who = host) => call(`/api/games/${g.id}/status`, { body: { status: s }, cookie: who.cookie });
  assert.equal((await status('active')).data.error, 'no_players');
  await call('/api/games/join', { body: { code: g.code }, cookie: pl1.cookie });
  assert.equal((await status('active', pl1)).status, 403);
  assert.equal((await status('paused')).data.error, 'bad_transition');
  assert.equal((await status('active')).data.game.status, 'active');
  assert.equal((await call(`/api/games/${g.id}/leave`, { body: {}, cookie: pl1.cookie })).data.error, 'already_started');
  assert.equal((await status('paused')).data.game.status, 'paused');
  assert.equal((await status('active')).data.game.status, 'active');
  assert.equal((await status('finished')).data.game.status, 'finished');
  assert.equal((await status('active')).data.error, 'bad_transition');
});

test('开局后释放座位：座位保留、旧账户失去访问；空座位出现在公开列表，新人接手同一个座位', async (t) => {
  const { call } = await start(t);
  const { host, pl1, pl2, pl3 } = await users(call, 'host', 'pl1', 'pl2', 'pl3');
  const g = (await call('/api/games', { body: { title: '长期局', maxSeats: 4, hostPlays: true }, cookie: host.cookie })).data.game;
  await call('/api/games/join', { body: { code: g.code }, cookie: pl1.cookie });
  await call(`/api/games/${g.id}/status`, { body: { status: 'active' }, cookie: host.cookie });
  await call(`/api/games/${g.id}/status`, { body: { status: 'paused' }, cookie: host.cookie });
  assert.equal((await call('/api/games/join', { body: { code: g.code }, cookie: pl2.cookie })).data.error, 'no_open_seat', '开局后默认原班人马');
  assert.deepEqual((await call('/api/games/open', { cookie: pl2.cookie })).data.games, []);

  let view = (await call('/api/games/' + g.id, { cookie: host.cookie })).data.game;
  const seat = view.seats.find((s) => s.user.id === pl1.id);
  view = (await call(`/api/games/${g.id}/seats/${seat.id}`, { body: { action: 'release' }, cookie: host.cookie })).data.game;
  assert.deepEqual(view.seats.map((s) => [s.seatNo, s.user && s.user.username]), [[1, 'host'], [2, null]]);
  assert.equal(view.seats[1].id, seat.id, '座位本身还在');
  assert.equal((await call('/api/games/' + g.id, { cookie: pl1.cookie })).status, 404);

  const open = (await call('/api/games/open', { cookie: pl2.cookie })).data.games;
  assert.deepEqual(open.map((x) => [x.id, x.status, x.free]), [[g.id, 'paused', 1]]);
  assert.equal((await call(`/api/games/${g.id}/join`, { body: {}, cookie: pl2.cookie })).data.id, g.id);
  view = (await call('/api/games/' + g.id, { cookie: pl2.cookie })).data.game;
  assert.equal(view.seats.find((s) => s.id === seat.id).user.username, 'pl2', '接手的是原来那个座位');
  assert.equal((await call(`/api/games/${g.id}/join`, { body: {}, cookie: pl3.cookie })).data.error, 'no_open_seat');
});

test('删除：开局前真删；开局后只对主导隐藏，玩家仍能看到已结束的记录', async (t) => {
  const { call, db } = await start(t);
  const { host, pl1 } = await users(call, 'host', 'pl1');
  const a = (await call('/api/games', { body: { title: '没开始', maxSeats: 3 }, cookie: host.cookie })).data.game;
  await call('/api/games/join', { body: { code: a.code }, cookie: pl1.cookie });
  assert.equal(await del(call, a.id, pl1), 403, '玩家不能删');
  assert.equal(await del(call, a.id, host), 200);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM games').get().n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM seats').get().n, 0);

  const b = (await call('/api/games', { body: { title: '开过的', maxSeats: 3 }, cookie: host.cookie })).data.game;
  await call('/api/games/join', { body: { code: b.code }, cookie: pl1.cookie });
  await call(`/api/games/${b.id}/status`, { body: { status: 'active' }, cookie: host.cookie });
  assert.equal(await del(call, b.id, host), 200);
  assert.deepEqual((await call('/api/games', { cookie: host.cookie })).data.games, [], '主导看不到了');
  assert.equal((await call('/api/games/' + b.id, { cookie: host.cookie })).status, 404);
  assert.equal((await call('/api/games/join', { body: { code: b.code }, cookie: host.cookie })).status, 404);
  const seen = (await call('/api/games/' + b.id, { cookie: pl1.cookie })).data.game;
  assert.equal(seen.status, 'finished');
  assert.equal(seen.ownerDeleted, true);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM games').get().n, 1, '记录还在服务器上');
});

test('实时：订阅房间看到在线状态与座位变化；被释放的玩家收到 game:gone；非成员订阅不了', async (t) => {
  const { base, call } = await start(t);
  const { host, pl1, pl2 } = await users(call, 'host', 'pl1', 'pl2');
  const g = (await call('/api/games', { body: { title: '实时', maxSeats: 3 }, cookie: host.cookie })).data.game;
  const hs = await sock(base, host.cookie);
  const s1 = await sock(base, pl1.cookie);
  const s2 = await sock(base, pl2.cookie);
  t.after(() => [hs, s1, s2].forEach((s) => s.close()));

  assert.deepEqual(await s2.emitWithAck('game:watch', g.id), { error: 'not_found' });
  assert.equal((await hs.emitWithAck('game:watch', g.id)).game.owner.online, true);

  await call('/api/games/join', { body: { code: g.code }, cookie: pl1.cookie });
  await hs.waitFor('game:update', (v) => v.seats.length === 1 && !v.seats[0].user.online);
  await s2.waitFor('lobby:changed');
  await s1.waitFor('games:changed');
  await s1.emitWithAck('game:watch', g.id);
  await hs.waitFor('game:update', (v) => v.seats.length === 1 && v.seats[0].user.online);

  await call(`/api/games/${g.id}/status`, { body: { status: 'active' }, cookie: host.cookie });
  await s1.waitFor('game:update', (v) => v.status === 'active');
  const seatId = (await call('/api/games/' + g.id, { cookie: host.cookie })).data.game.seats[0].id;
  s1.clearSeen();
  await call(`/api/games/${g.id}/seats/${seatId}`, { body: { action: 'release' }, cookie: host.cookie });
  assert.deepEqual(await s1.waitFor('game:gone'), { id: g.id });
  await hs.waitFor('game:update', (v) => v.seats.length === 1 && v.seats[0].user === null);
  s1.clearSeen();
  await call(`/api/games/${g.id}/status`, { body: { status: 'paused' }, cookie: host.cookie });
  await hs.waitFor('game:update', (v) => v.status === 'paused');
  assert.equal(await s1.waitFor('game:update').then(() => 'leaked', () => 'none'), 'none', '被释放后不再收到房间推送');
});

// ---------------------------------------------------------------- 面板存档

// 建一局：主导兼角色 + 两名玩家，开局
async function startedGame(call) {
  const u = await users(call, 'host', 'pl1', 'pl2', 'pl3');
  const g = (await call('/api/games', { body: { title: '存档局', maxSeats: 3, hostPlays: true }, cookie: u.host.cookie })).data.game;
  await call('/api/games/join', { body: { code: g.code }, cookie: u.pl1.cookie });
  await call('/api/games/join', { body: { code: g.code }, cookie: u.pl2.cookie });
  return { u, g };
}
const put = (call, g, kind, who, version, state, from) => call(`/api/games/${g.id}/state/${kind}`, { method: 'PUT', body: { version, state, from }, cookie: who.cookie });

test('开局时生成面板存档：主持人名单按座位；每个座位一份已套用规则包的玩家存档；只有本人能读', async (t) => {
  const { call } = await start(t);
  const { u, g } = await startedGame(call);
  assert.equal((await call(`/api/games/${g.id}/state/host`, { cookie: u.host.cookie })).data.error, 'not_started');
  await call(`/api/games/${g.id}/status`, { body: { status: 'active' }, cookie: u.host.cookie });

  const host = (await call(`/api/games/${g.id}/state/host`, { cookie: u.host.cookie })).data;
  assert.equal(host.version, 1);
  assert.equal(host.game.status, 'active');
  assert.equal(host.state.kind, 'shelter-host');
  const seats = (await call('/api/games/' + g.id, { cookie: u.host.cookie })).data.game.seats;
  assert.deepEqual(host.state.players.map((p) => [p.id, p.name]), seats.map((s) => [s.id, s.user.username]));
  assert.deepEqual(host.state.seatOrder, seats.map((s) => s.id));

  const p1 = (await call(`/api/games/${g.id}/state/seat`, { cookie: u.pl1.cookie })).data;
  assert.equal(p1.state.kind, 'shelter-player');
  assert.equal(p1.state.name, 'pl1');
  assert.equal(p1.state.playerId, seats[1].id);
  assert.deepEqual(p1.state.otherNames.sort(), ['host', 'pl2']);
  assert.deepEqual((await call(`/api/games/${g.id}/state/seat`, { cookie: u.host.cookie })).data.state.name, 'host', '主导兼角色也有自己的玩家存档');

  assert.equal((await call(`/api/games/${g.id}/state/host`, { cookie: u.pl1.cookie })).status, 403);
  assert.equal((await call(`/api/games/${g.id}/state/seat`, { cookie: u.pl3.cookie })).status, 404);
});

test('写存档：版本号对上才写入，撞版本返回最新；暂停后只读；结构不对拒绝；不能写别人的', async (t) => {
  const { call } = await start(t);
  const { u, g } = await startedGame(call);
  await call(`/api/games/${g.id}/status`, { body: { status: 'active' }, cookie: u.host.cookie });
  const s = (await call(`/api/games/${g.id}/state/seat`, { cookie: u.pl1.cookie })).data.state;

  s.hp = 3;
  assert.deepEqual((await put(call, g, 'seat', u.pl1, 1, s)).data, { version: 2 });
  const stale = await put(call, g, 'seat', u.pl1, 1, { ...s, hp: 9 });
  assert.equal(stale.status, 409);
  assert.equal(stale.data.error, 'version_conflict');
  assert.equal(stale.data.version, 2);
  assert.equal(stale.data.state.hp, 3, '冲突时带回服务器上的最新版');

  assert.equal((await put(call, g, 'seat', u.pl1, 2, { kind: 'shelter-host' })).data.error, 'bad_state');
  assert.equal((await put(call, g, 'host', u.pl1, 1, s)).status, 403);

  await call(`/api/games/${g.id}/status`, { body: { status: 'paused' }, cookie: u.host.cookie });
  const ro = await put(call, g, 'seat', u.pl1, 2, { ...s, hp: 1 });
  assert.equal(ro.data.error, 'read_only');
  assert.equal((await call(`/api/games/${g.id}/state/seat`, { cookie: u.pl1.cookie })).data.state.hp, 3, '暂停期间没有写进去');
});

test('多设备：保存后推给同一账户的其他设备（不推回发起的那台），别人收不到', async (t) => {
  const { base, call } = await start(t);
  const { u, g } = await startedGame(call);
  await call(`/api/games/${g.id}/status`, { body: { status: 'active' }, cookie: u.host.cookie });
  const phone = await sock(base, u.pl1.cookie);
  const laptop = await sock(base, u.pl1.cookie);
  const other = await sock(base, u.pl2.cookie);
  t.after(() => [phone, laptop, other].forEach((x) => x.close()));

  const s = (await call(`/api/games/${g.id}/state/seat`, { cookie: u.pl1.cookie })).data.state;
  s.hp = 2;
  await put(call, g, 'seat', u.pl1, 1, s, laptop.id);
  const m = await phone.waitFor('state:update');
  assert.deepEqual([m.gameId, m.kind, m.version, m.state.hp, m.from], [g.id, 'seat', 2, 2, laptop.id]);
  assert.equal(await other.waitFor('state:update').then(() => 'leaked', () => 'none'), 'none');
});

test('主持人改规则或玩家名单：自动套到所有玩家存档并推送；只改天数等其他内容不推', async (t) => {
  const { base, call } = await start(t);
  const { u, g } = await startedGame(call);
  await call(`/api/games/${g.id}/status`, { body: { status: 'active' }, cookie: u.host.cookie });
  const ps = await sock(base, u.pl1.cookie);
  t.after(() => ps.close());
  const mine = (await call(`/api/games/${g.id}/state/seat`, { cookie: u.pl1.cookie })).data.state;
  mine.hp = 4;
  await put(call, g, 'seat', u.pl1, 1, mine);

  let host = (await call(`/api/games/${g.id}/state/host`, { cookie: u.host.cookie })).data;
  host.state.day = 3;
  await put(call, g, 'host', u.host, 1, host.state);
  assert.equal((await call(`/api/games/${g.id}/state/seat`, { cookie: u.pl1.cookie })).data.version, 2, '只改天数不动玩家存档');

  host.state.rules.inventoryCapacityTicks = 24;
  await put(call, g, 'host', u.host, 2, host.state);
  const m = await ps.waitFor('state:update', (x) => x.reason);
  assert.equal(m.reason, 'rules');
  assert.deepEqual(m.detail, { rules: true, roster: false });
  assert.equal(m.version, 3);
  assert.equal(m.state.rules.inventoryCapacityTicks, 24);
  assert.equal(m.state.hp, 4, '库存和状态不动');
  assert.match(m.state.log[0].text, /主持人更新了规则/);

  ps.clearSeen();
  host.state.players[2].name = '二狗';
  await put(call, g, 'host', u.host, 3, host.state);
  const m2 = await ps.waitFor('state:update', (x) => x.reason);
  assert.deepEqual(m2.detail, { rules: false, roster: true });
  assert.deepEqual(m2.state.otherNames.sort(), ['host', '二狗']);
  const p2 = (await call(`/api/games/${g.id}/state/seat`, { cookie: u.pl2.cookie })).data;
  assert.equal(p2.state.rules.inventoryCapacityTicks, 24, '不在线的玩家存档也同步了');
});

test('释放座位后：新人接手拿到原来座位上的玩家存档', async (t) => {
  const { call } = await start(t);
  const { u, g } = await startedGame(call);
  await call(`/api/games/${g.id}/status`, { body: { status: 'active' }, cookie: u.host.cookie });
  const s = (await call(`/api/games/${g.id}/state/seat`, { cookie: u.pl1.cookie })).data.state;
  s.hp = 1;
  s.inventory = [{ id: 'e1', defId: 'bread', qty: 2 }];
  await put(call, g, 'seat', u.pl1, 1, s);
  const seatId = s.playerId;
  await call(`/api/games/${g.id}/seats/${seatId}`, { body: { action: 'release' }, cookie: u.host.cookie });
  assert.equal((await call(`/api/games/${g.id}/state/seat`, { cookie: u.pl1.cookie })).status, 404);
  await call(`/api/games/${g.id}/join`, { body: {}, cookie: u.pl3.cookie });
  const taken = (await call(`/api/games/${g.id}/state/seat`, { cookie: u.pl3.cookie })).data;
  assert.equal(taken.state.playerId, seatId);
  assert.equal(taken.state.hp, 1);
  assert.deepEqual(taken.state.inventory.map((e) => [e.defId, e.qty]), [['bread', 2]]);
});

// ---------------------------------------------------------------- 公开信息与私信

const seatIdOf = async (call, g, who) => (await call(`/api/games/${g.id}/state/seat`, { cookie: who.cookie })).data.state.playerId;
const msgs = (call, g, who, as) => call(`/api/games/${g.id}/messages?as=${as}`, { cookie: who.cookie });
const send = (call, g, who, as, to, text) => call(`/api/games/${g.id}/messages`, { body: { as, to, text }, cookie: who.cookie });

test('公开信息：只含「公开展示」的内容，不漏公共池明细、补给物品、事件库、守夜与私信备注；变化时推给房间', async (t) => {
  const { call, base } = await start(t);
  const { u, g } = await startedGame(call);
  assert.equal((await call(`/api/games/${g.id}/public`, { cookie: u.pl1.cookie })).data.error, 'not_started');
  await call(`/api/games/${g.id}/status`, { body: { status: 'active' }, cookie: u.host.cookie });
  const s1 = await sock(base, u.pl1.cookie);
  t.after(() => s1.close());
  await s1.emitWithAck('game:watch', g.id);

  const host = (await call(`/api/games/${g.id}/state/host`, { cookie: u.host.cookie })).data;
  const st = host.state;
  st.started = true; st.day = 2; st.phase = 'supply';
  st.pool = [{ id: 'x1', defId: 'jewel', qty: 3 }];
  st.batches = [{ id: 'b1', label: '第2天补给', status: 'open', day: 2, pickOrder: st.seatOrder.slice(), picks: [], items: [{ id: 'x2', defId: 'medkit', qty: 1 }] }];
  st.events = [{ id: 'e1', name: '秘密事件库条目', body: '不该公开', options: [] }];
  st.dmNotes = { [st.players[0].id]: { love: st.players[1].id } };
  st.stage = { event: { name: '停电', location: '大厅', body: '灯灭了', options: ['修', '不修'], flowId: 'f1' }, showPoolCount: false };
  st.publicFeed = [{ id: 'p1', day: 1, kind: 'night', text: '昨夜平安', refId: 'r1', at: 1 }];
  st.rescueProgress = 2;
  assert.equal((await put(call, g, 'host', u.host, host.version, st)).status, 200);

  const pushed = await s1.waitFor('public:update', (m) => m.view.phase === 'supply');
  const view = (await call(`/api/games/${g.id}/public`, { cookie: u.pl1.cookie })).data.view;
  assert.deepEqual(pushed.view, view);
  assert.equal(view.day, 2);
  assert.deepEqual(view.supply, [{ label: '第2天补给', pickOrder: st.seatOrder, picked: [], next: st.seatOrder[0] }]);
  assert.deepEqual(view.event, { name: '停电', location: '大厅', body: '灯灭了', options: ['修', '不修'] });
  assert.equal(view.poolCount, null, '主持人没打开开关时不公开池子件数');
  assert.deepEqual(view.feed, [{ id: 'p1', day: 1, kind: 'night', text: '昨夜平安', at: 1 }]);
  const json = JSON.stringify(view);
  for (const secret of ['jewel', 'medkit', '秘密事件库条目', 'dmNotes', 'love', 'flowId', 'refId', '"log"']) assert.ok(!json.includes(secret), '公开信息里不该有 ' + secret);

  st.stage.showPoolCount = true;
  await put(call, g, 'host', u.host, host.version + 1, st);
  assert.equal((await s1.waitFor('public:update', (m) => m.view.poolCount === 3)).view.poolCount, 3);
  const other = (await users(call, 'outsider')).outsider;
  assert.equal((await call(`/api/games/${g.id}/public`, { cookie: other.cookie })).status, 404);
});

test('私信：主持人与玩家、玩家与玩家互发；主持人看不到玩家之间的；身份不能冒用；暂停能发、结束不能发', async (t) => {
  const { call, base } = await start(t);
  const { u, g } = await startedGame(call);
  assert.equal((await send(call, g, u.pl1, 'seat', 'host', '早')).data.error, 'not_started');
  await call(`/api/games/${g.id}/status`, { body: { status: 'active' }, cookie: u.host.cookie });
  const [hostSeat, a, b] = [await seatIdOf(call, g, u.host), await seatIdOf(call, g, u.pl1), await seatIdOf(call, g, u.pl2)];
  const sb = await sock(base, u.pl2.cookie);
  t.after(() => sb.close());

  assert.equal((await send(call, g, u.host, 'host', a, '你的身份是……')).status, 200);
  assert.equal((await send(call, g, u.pl1, 'seat', b, '要不要结盟？')).status, 200);
  const pushed = await sb.waitFor('message:new');
  assert.deepEqual([pushed.message.from, pushed.message.to, pushed.message.text], [a, b, '要不要结盟？']);
  await send(call, g, u.pl2, 'seat', 'host', '我想换位');

  const hostBox = (await msgs(call, g, u.host, 'host')).data;
  assert.equal(hostBox.me, 'host');
  assert.deepEqual(hostBox.messages.map((m) => m.text), ['你的身份是……', '我想换位'], '主持人看不到玩家之间的私信');
  const aBox = (await msgs(call, g, u.pl1, 'seat')).data;
  assert.equal(aBox.me, a);
  assert.deepEqual(aBox.messages.map((m) => m.text), ['你的身份是……', '要不要结盟？']);
  // 主导兼角色：以座位身份收的私信不在主持人收件箱里
  await send(call, g, u.pl1, 'seat', hostSeat, '给主导的角色');
  assert.deepEqual((await msgs(call, g, u.host, 'seat')).data.messages.map((m) => m.text), ['给主导的角色']);
  assert.ok(!(await msgs(call, g, u.host, 'host')).data.messages.some((m) => m.text === '给主导的角色'));

  assert.equal((await msgs(call, g, u.pl1, 'host')).status, 403, '玩家不能以主持人身份读');
  assert.equal((await send(call, g, u.pl1, 'host', b, '冒充')).data.error, 'bad_identity');
  assert.equal((await send(call, g, u.pl1, 'seat', a, '自己')).data.error, 'bad_recipient');
  assert.equal((await send(call, g, u.pl1, 'seat', 'nobody', 'x')).data.error, 'no_recipient');
  assert.equal((await send(call, g, u.pl1, 'seat', b, ' ')).data.error, 'bad_text');
  assert.equal((await msgs(call, g, u.pl3, 'seat')).status, 404, '非成员');

  // 已读
  assert.equal((await msgs(call, g, u.pl2, 'seat')).data.messages.filter((m) => m.to === b && !m.readAt).length, 1);
  await call(`/api/games/${g.id}/messages/read`, { body: { as: 'seat', with: a }, cookie: u.pl2.cookie });
  assert.equal((await msgs(call, g, u.pl2, 'seat')).data.messages.filter((m) => m.to === b && !m.readAt).length, 0);

  await call(`/api/games/${g.id}/status`, { body: { status: 'paused' }, cookie: u.host.cookie });
  assert.equal((await send(call, g, u.pl1, 'seat', 'host', '暂停也能聊')).status, 200);
  await call(`/api/games/${g.id}/status`, { body: { status: 'finished' }, cookie: u.host.cookie });
  assert.equal((await send(call, g, u.pl1, 'seat', 'host', '结束了')).data.error, 'game_closed');
});

test('私信跟着座位走：座位被释放后原账户看不到，接手的人看得到；发给空座位被拒', async (t) => {
  const { call } = await start(t);
  const { u, g } = await startedGame(call);
  await call(`/api/games/${g.id}/status`, { body: { status: 'active' }, cookie: u.host.cookie });
  const a = await seatIdOf(call, g, u.pl1);
  await send(call, g, u.host, 'host', a, '只给这个角色的线索');
  await call(`/api/games/${g.id}/seats/${a}`, { body: { action: 'release' }, cookie: u.host.cookie });
  assert.equal((await msgs(call, g, u.pl1, 'seat')).status, 404);
  assert.equal((await send(call, g, u.host, 'host', a, '有人吗')).data.error, 'no_recipient');
  await call(`/api/games/${g.id}/join`, { body: {}, cookie: u.pl3.cookie });
  const box = (await msgs(call, g, u.pl3, 'seat')).data;
  assert.equal(box.me, a);
  assert.deepEqual(box.messages.map((m) => m.text), ['只给这个角色的线索']);
});

// ---------------------------------------------------------------- 交接单（物品流转）

const C = require('../src/shared/core.js');
const tr = (call, g, who, path, body) => call(`/api/games/${g.id}/transfers${path}`, { body, cookie: who.cookie });
const seatState = async (call, g, who) => (await call(`/api/games/${g.id}/state/seat`, { cookie: who.cookie })).data;
const hostState = async (call, g, who) => (await call(`/api/games/${g.id}/state/host`, { cookie: who.cookie })).data;
const count = (list, defId) => list.filter((e) => e.defId === defId).reduce((n, e) => n + e.qty, 0);

// 开局后给玩家存档里放些物品（直接写自己的存档，和玩家页面一样）
async function stock(call, g, who, items) {
  const cur = await seatState(call, g, who);
  items.forEach((x) => C.addItem(cur.state.inventory, x[0], x[1], { rules: cur.state.rules }));
  await put(call, g, 'seat', who, cur.version, cur.state);
  return (await seatState(call, g, who)).state;
}

async function activeGame(call) {
  const { u, g } = await startedGame(call);
  await call(`/api/games/${g.id}/status`, { body: { status: 'active' }, cookie: u.host.cookie });
  const ids = { a: await seatIdOf(call, g, u.pl1), b: await seatIdOf(call, g, u.pl2) };
  return { u, g, ids };
}

test('赠予：发起时立刻从发起方扣下（托管）；接收后入对方库存，实例字段（能量棒次数、地图笔记）原样保留；推送双方存档', async (t) => {
  const { call, base } = await start(t);
  const { u, g, ids } = await activeGame(call);
  let inv = (await stock(call, g, u.pl1, [['bread', 3], ['energy_bar', 1], ['map', 1]])).inventory;
  const bar = inv.find((e) => e.defId === 'energy_bar');
  const map = inv.find((e) => e.defId === 'map');
  // 把能量棒用掉一次、地图写一条笔记，看交接后还在不在
  const cur = await seatState(call, g, u.pl1);
  cur.state.inventory.find((e) => e.id === bar.id).uses = 2;
  cur.state.inventory.find((e) => e.id === map.id).notes = [{ id: 'n1', text: '北边有水' }];
  await put(call, g, 'seat', u.pl1, cur.version, cur.state);
  const bread = inv.find((e) => e.defId === 'bread');
  const sb = await sock(base, u.pl2.cookie);
  t.after(() => sb.close());

  const sent = await tr(call, g, u.pl1, '', { as: 'seat', to: ids.b, give: [{ entryId: bread.id, qty: 2 }, { entryId: bar.id, qty: 1 }, { entryId: map.id, qty: 1 }], note: '拿着' });
  assert.equal(sent.status, 200);
  assert.equal(sent.data.transfer.kind, 'gift');
  inv = (await seatState(call, g, u.pl1)).state.inventory;
  assert.deepEqual([count(inv, 'bread'), count(inv, 'energy_bar'), count(inv, 'map')], [1, 0, 0], '托管：发起方已扣下');
  assert.equal(count((await seatState(call, g, u.pl2)).state.inventory, 'bread'), 0, '对方还没收到');
  await sb.waitFor('transfer:update', (m) => m.transfer.id === sent.data.transfer.id);

  assert.equal((await tr(call, g, u.pl1, `/${sent.data.transfer.id}/accept`, { as: 'seat' })).data.error, 'not_recipient');
  const ok = await tr(call, g, u.pl2, `/${sent.data.transfer.id}/accept`, { as: 'seat' });
  assert.equal(ok.data.transfer.status, 'accepted');
  const got = (await seatState(call, g, u.pl2)).state;
  assert.equal(count(got.inventory, 'bread'), 2);
  assert.equal(got.inventory.find((e) => e.defId === 'energy_bar').uses, 2);
  assert.deepEqual(got.inventory.find((e) => e.defId === 'map').notes, [{ id: 'n1', text: '北边有水' }]);
  assert.match(got.log[0].text, /接收（来自 pl1）/);
  const pushed = await sb.waitFor('state:update', (m) => m.reason === 'transfer');
  assert.equal(count(pushed.state.inventory, 'bread'), 2);
  assert.equal((await tr(call, g, u.pl2, `/${sent.data.transfer.id}/accept`, { as: 'seat' })).data.error, 'already_resolved', '不能重复处理');
});

test('拒收与撤回：物品原样退回发起方；数量不够、冒用身份、携带中的物品、暂停时都被拒', async (t) => {
  const { call } = await start(t);
  const { u, g, ids } = await activeGame(call);
  const inv = (await stock(call, g, u.pl1, [['water', 4]])).inventory;
  const water = inv[0];
  assert.equal((await tr(call, g, u.pl1, '', { as: 'seat', to: ids.b, give: [{ entryId: water.id, qty: 5 }] })).data.error, 'not_enough');
  assert.equal((await tr(call, g, u.pl1, '', { as: 'host', to: ids.b, give: [{ entryId: water.id, qty: 1 }] })).data.error, 'bad_identity');
  assert.equal((await tr(call, g, u.pl1, '', { as: 'seat', to: ids.a, give: [{ entryId: water.id, qty: 1 }] })).data.error, 'bad_recipient');

  const x = (await tr(call, g, u.pl1, '', { as: 'seat', to: ids.b, give: [{ entryId: water.id, qty: 3 }] })).data.transfer;
  await tr(call, g, u.pl2, `/${x.id}/reject`, { as: 'seat' });
  assert.equal(count((await seatState(call, g, u.pl1)).state.inventory, 'water'), 4, '拒收后退回');
  const y = (await tr(call, g, u.pl1, '', { as: 'seat', to: ids.b, give: [{ entryId: water.id, qty: 1 }] })).data.transfer;
  assert.equal((await tr(call, g, u.pl2, `/${y.id}/cancel`, { as: 'seat' })).data.error, 'not_sender');
  await tr(call, g, u.pl1, `/${y.id}/cancel`, { as: 'seat' });
  assert.equal(count((await seatState(call, g, u.pl1)).state.inventory, 'water'), 4, '撤回后退回');

  // 已确认携带的物品被锁定（退回后条目换了新 id，重新取一次）
  const cur = await seatState(call, g, u.pl1);
  const w = cur.state.inventory.find((e) => e.defId === 'water');
  cur.state.loadout = { context: 'event', label: '', day: 1, limitTicks: 4, items: [{ entryId: w.id, qty: 1 }], confirmed: true };
  await put(call, g, 'seat', u.pl1, cur.version, cur.state);
  assert.equal((await tr(call, g, u.pl1, '', { as: 'seat', to: ids.b, give: [{ entryId: w.id, qty: 1 }] })).data.error, 'in_loadout');

  // 暂停：发起和处理都不行
  const cur2 = await seatState(call, g, u.pl1);
  cur2.state.loadout = null;
  await put(call, g, 'seat', u.pl1, cur2.version, cur2.state);
  const z = (await tr(call, g, u.pl1, '', { as: 'seat', to: ids.b, give: [{ entryId: w.id, qty: 1 }] })).data.transfer;
  await call(`/api/games/${g.id}/status`, { body: { status: 'paused' }, cookie: u.host.cookie });
  assert.equal((await tr(call, g, u.pl2, `/${z.id}/accept`, { as: 'seat' })).data.error, 'read_only');
  assert.equal((await tr(call, g, u.pl1, '', { as: 'seat', to: ids.b, give: [{ entryId: w.id, qty: 1 }] })).data.error, 'read_only');
});

test('交易是原子的：接收方交出的种类和数量对得上才两边同时换手；对不上或不够时什么都不变', async (t) => {
  const { call } = await start(t);
  const { u, g, ids } = await activeGame(call);
  const a = (await stock(call, g, u.pl1, [['ammo', 2]])).inventory;
  const b = (await stock(call, g, u.pl2, [['water', 1], ['bread', 3]])).inventory;
  assert.equal((await tr(call, g, u.pl1, '', { as: 'seat', to: 'host', give: [{ entryId: a[0].id, qty: 1 }], wants: [{ defId: 'water', qty: 1 }] })).data.error, 'bad_wants', '交公不能要东西');
  const x = (await tr(call, g, u.pl1, '', { as: 'seat', to: ids.b, give: [{ entryId: a[0].id, qty: 2 }], wants: [{ defId: 'water', qty: 2 }] })).data.transfer;
  assert.equal(x.kind, 'trade');
  const water = b.find((e) => e.defId === 'water');
  const bread = b.find((e) => e.defId === 'bread');
  assert.equal((await tr(call, g, u.pl2, `/${x.id}/accept`, { as: 'seat', give: [{ entryId: water.id, qty: 2 }] })).data.error, 'not_enough');
  assert.equal((await tr(call, g, u.pl2, `/${x.id}/accept`, { as: 'seat', give: [{ entryId: water.id, qty: 1 }, { entryId: bread.id, qty: 1 }] })).data.error, 'wants_mismatch');
  const before = await seatState(call, g, u.pl2);
  assert.equal(count(before.state.inventory, 'water'), 1, '失败时接收方库存不变');
  assert.equal(count(before.state.inventory, 'ammo'), 0);
  await tr(call, g, u.pl2, `/${x.id}/reject`, { as: 'seat' });

  const a2 = (await seatState(call, g, u.pl1)).state.inventory.find((e) => e.defId === 'ammo');
  const y = (await tr(call, g, u.pl1, '', { as: 'seat', to: ids.b, give: [{ entryId: a2.id, qty: 1 }], wants: [{ defId: 'water', qty: 1 }, { defId: 'bread', qty: 2 }] })).data.transfer;
  const ok = await tr(call, g, u.pl2, `/${y.id}/accept`, { as: 'seat', give: [{ entryId: water.id, qty: 1 }, { entryId: bread.id, qty: 2 }] });
  assert.equal(ok.data.transfer.status, 'accepted');
  assert.deepEqual(ok.data.transfer.given.map((e) => [e.defId, e.qty]), [['water', 1], ['bread', 2]]);
  const sa = (await seatState(call, g, u.pl1)).state.inventory;
  const sb2 = (await seatState(call, g, u.pl2)).state.inventory;
  assert.deepEqual([count(sa, 'ammo'), count(sa, 'water'), count(sa, 'bread')], [1, 1, 2]);
  assert.deepEqual([count(sb2, 'ammo'), count(sb2, 'water'), count(sb2, 'bread')], [1, 0, 1]);
});

test('公共池：玩家交公由主持人接收入池；主持人从池中发放（托管）、凭空给予；拒收回到池里；主持人看得到全部记录，玩家只看自己的', async (t) => {
  const { call } = await start(t);
  const { u, g, ids } = await activeGame(call);
  const inv = (await stock(call, g, u.pl1, [['jewel', 2]])).inventory;
  const x = (await tr(call, g, u.pl1, '', { as: 'seat', to: 'host', give: [{ entryId: inv[0].id, qty: 2 }], kind: 'scavenge' })).data.transfer;
  assert.equal(x.kind, 'scavenge');
  assert.equal((await tr(call, g, u.pl2, `/${x.id}/accept`, { as: 'seat' })).data.error, 'not_recipient');
  await tr(call, g, u.host, `/${x.id}/accept`, { as: 'host' });
  assert.equal(count((await hostState(call, g, u.host)).state.pool, 'jewel'), 2, '入池');

  const y = (await tr(call, g, u.host, '', { as: 'host', to: ids.b, source: 'pool', give: [{ defId: 'jewel', qty: 1 }], kind: 'grant' })).data.transfer;
  assert.equal(count((await hostState(call, g, u.host)).state.pool, 'jewel'), 1, '从池里托管');
  await tr(call, g, u.pl2, `/${y.id}/reject`, { as: 'seat' });
  assert.equal(count((await hostState(call, g, u.host)).state.pool, 'jewel'), 2, '拒收回到池里');
  assert.equal((await tr(call, g, u.host, '', { as: 'host', to: ids.b, source: 'pool', give: [{ defId: 'medkit', qty: 1 }] })).data.error, 'not_enough');

  const z = (await tr(call, g, u.host, '', { as: 'host', to: ids.b, source: 'none', give: [{ defId: 'energy_bar', qty: 2 }], kind: 'opening' })).data.transfer;
  await tr(call, g, u.pl2, `/${z.id}/accept`, { as: 'seat' });
  const bars = (await seatState(call, g, u.pl2)).state.inventory.filter((e) => e.defId === 'energy_bar');
  assert.equal(bars.length, 2, '实例物品逐件加入');
  assert.ok(bars.every((e) => e.uses >= 1), '凭空给予也带实例默认值');

  const all = (await call(`/api/games/${g.id}/transfers?as=host`, { cookie: u.host.cookie })).data.transfers;
  assert.equal(all.length, 3);
  const mine = (await call(`/api/games/${g.id}/transfers?as=seat`, { cookie: u.pl1.cookie })).data.transfers;
  assert.deepEqual(mine.map((m) => m.id), [x.id], '玩家只看到和自己有关的');
});

test('补给批次：记录选择后登记给玩家（不重复扣池子、不能重复登记）；拒收时撤回这次选择、物品回到候选', async (t) => {
  const { call } = await start(t);
  const { u, g, ids } = await activeGame(call);
  const host = await hostState(call, g, u.host);
  const s = host.state;
  const pieces = [{ id: 'pc_bread', defId: 'bread', qty: 1 }, { id: 'pc_water', defId: 'water', qty: 1 }];
  s.batches = [{ id: 'b1', label: '第1天补给', kind: 'supply', status: 'open', day: 1, participantIds: [ids.a, ids.b], pickOrder: [ids.a, ids.b], picks: [], items: pieces }];
  assert.ok(C.pickFromBatch(s.batches[0], ids.a, 'pc_bread').ok);
  await put(call, g, 'host', u.host, host.version, s);

  assert.equal((await tr(call, g, u.host, '', { as: 'host', to: ids.b, source: 'batch', batchId: 'b1', pieceId: 'pc_bread' })).data.error, 'no_pick', '只能发给选了这件的人');
  const x = (await tr(call, g, u.host, '', { as: 'host', to: ids.a, source: 'batch', batchId: 'b1', pieceId: 'pc_bread', kind: 'supply' })).data.transfer;
  assert.equal(x.kind, 'supply');
  assert.equal((await tr(call, g, u.host, '', { as: 'host', to: ids.a, source: 'batch', batchId: 'b1', pieceId: 'pc_bread' })).data.error, 'already_sent');
  await tr(call, g, u.pl1, `/${x.id}/reject`, { as: 'seat' });
  const after = (await hostState(call, g, u.host)).state;
  assert.deepEqual(after.batches[0].picks, [], '撤回了选择');
  assert.deepEqual(after.batches[0].items.map((p) => p.id).sort(), ['pc_bread', 'pc_water']);
  assert.equal(after.pool.length, 0, '不会多出一份到池子里');
});

// ---------------------------------------------------------------- 玩家提交

const sub = (call, g, who, path, body) => call(`/api/games/${g.id}/submissions${path}`, { body, cookie: who.cookie });
const subs = async (call, g, who, as) => (await call(`/api/games/${g.id}/submissions?as=${as}`, { cookie: who.cookie })).data.submissions;

test('行动提交：同一天只留最新一份；主持人采用后当天不能再交；天数以主持人存档为准；玩家只看自己的', async (t) => {
  const { call, base } = await start(t);
  const { u, g, ids } = await activeGame(call);
  const hs = await sock(base, u.host.cookie);
  t.after(() => hs.close());
  const host = await hostState(call, g, u.host);
  host.state.day = 3;
  await put(call, g, 'host', u.host, host.version, host.state);

  assert.equal((await sub(call, g, u.pl1, '', { as: 'seat', kind: 'action', payload: { type: 'fly' } })).data.error, 'bad_payload');
  assert.equal((await sub(call, g, u.pl1, '', { as: 'host', kind: 'action', payload: { type: 'plan' } })).data.error, 'bad_identity');
  const a = (await sub(call, g, u.pl1, '', { as: 'seat', kind: 'action', payload: { type: 'plan' } })).data.submission;
  assert.deepEqual([a.from, a.to, a.day, a.status], [ids.a, 'host', 3, 'pending']);
  await hs.waitFor('submission:update', (m) => m.submission.id === a.id);
  const b = (await sub(call, g, u.pl1, '', { as: 'seat', kind: 'action', payload: { type: 'skill', note: '修门' } })).data.submission;
  const list = await subs(call, g, u.host, 'host');
  assert.deepEqual(list.map((x) => [x.payload.type, x.status]), [['plan', 'withdrawn'], ['skill', 'pending']], '改选时旧的自动撤回');

  assert.equal((await sub(call, g, u.pl1, `/${b.id}/adopt`, { as: 'seat' })).data.error, 'host_only');
  assert.equal((await sub(call, g, u.host, `/${b.id}/adopt`, { as: 'host' })).data.submission.status, 'adopted');
  assert.equal((await sub(call, g, u.host, `/${b.id}/dismiss`, { as: 'host' })).data.error, 'already_resolved');
  assert.equal((await sub(call, g, u.pl1, '', { as: 'seat', kind: 'action', payload: { type: 'pass' } })).data.error, 'already_adopted');
  assert.equal((await subs(call, g, u.pl2, 'seat')).length, 0, '别的玩家看不到');
});

test('换位：被请求者先回答，才进入主持人的待处理；只有被请求者能回答；发起者可以撤回；暂停时只读', async (t) => {
  const { call } = await start(t);
  const { u, g, ids } = await activeGame(call);
  assert.equal((await sub(call, g, u.pl1, '', { as: 'seat', kind: 'swap', to: ids.a })).data.error, 'no_recipient');
  const s1 = (await sub(call, g, u.pl1, '', { as: 'seat', kind: 'swap', to: ids.b })).data.submission;
  assert.equal(s1.status, 'asking');
  assert.equal((await subs(call, g, u.pl2, 'seat')).length, 1, '被请求者看得到');
  assert.equal((await sub(call, g, u.pl1, `/${s1.id}/answer`, { as: 'seat', accepted: true })).data.error, 'not_recipient');
  assert.equal((await sub(call, g, u.pl2, `/${s1.id}/answer`, { as: 'seat', accepted: 'yes' })).data.error, 'bad_answer');
  const answered = (await sub(call, g, u.pl2, `/${s1.id}/answer`, { as: 'seat', accepted: false })).data.submission;
  assert.deepEqual([answered.status, answered.answer], ['pending', { accepted: false }]);

  const s2 = (await sub(call, g, u.pl1, '', { as: 'seat', kind: 'swap', to: ids.b })).data.submission;
  assert.equal((await subs(call, g, u.host, 'host')).filter((x) => x.kind === 'swap' && x.status !== 'withdrawn').length, 2, '换位可以有多份');
  assert.equal((await sub(call, g, u.pl2, `/${s2.id}/withdraw`, { as: 'seat' })).data.error, 'not_sender');
  assert.equal((await sub(call, g, u.pl1, `/${s2.id}/withdraw`, { as: 'seat' })).data.submission.status, 'withdrawn');

  const s3 = (await sub(call, g, u.pl1, '', { as: 'seat', kind: 'swap', to: ids.b })).data.submission;
  assert.equal((await sub(call, g, u.host, `/${s3.id}/adopt`, { as: 'host' })).data.submission.status, 'adopted', '对方没回答时主持人也能直接处理');
  await call(`/api/games/${g.id}/status`, { body: { status: 'paused' }, cookie: u.host.cookie });
  assert.equal((await sub(call, g, u.pl1, '', { as: 'seat', kind: 'swap', to: ids.b })).data.error, 'read_only');
});

test('末位拍板：只有主持人能发起、只有末位能回答；守夜卡片与分数上报带上内容', async (t) => {
  const { call } = await start(t);
  const { u, g, ids } = await activeGame(call);
  const payload = { options: ['阿珍、老陈', '全员守夜'], candidateIds: ['c1', 'c2'] };
  assert.equal((await sub(call, g, u.pl1, '', { as: 'seat', kind: 'decide', to: ids.b, payload })).data.error, 'host_only');
  assert.equal((await sub(call, g, u.host, '', { as: 'host', kind: 'decide', to: ids.b, payload: { options: ['x'], candidateIds: ['c1'] } })).data.error, 'bad_payload');
  const d = (await sub(call, g, u.host, '', { as: 'host', kind: 'decide', to: ids.b, payload })).data.submission;
  assert.equal(d.status, 'asking');
  assert.equal((await sub(call, g, u.pl1, `/${d.id}/answer`, { as: 'seat', index: 0 })).data.error, 'not_recipient');
  assert.equal((await sub(call, g, u.pl2, `/${d.id}/answer`, { as: 'seat', index: 2 })).data.error, 'bad_answer');
  assert.deepEqual((await sub(call, g, u.pl2, `/${d.id}/answer`, { as: 'seat', index: 1 })).data.submission.answer, { index: 1 });

  const card = { v: 2, id: 'wc_1', all: true, names: [], skill: false, plan: false, tendency: null, total: 3 };
  const w = (await sub(call, g, u.pl1, '', { as: 'seat', kind: 'watch', payload: { card, from: 'pl1' } })).data.submission;
  assert.deepEqual(w.payload, { card, from: 'pl1' });
  const sc = (await sub(call, g, u.pl1, '', { as: 'seat', kind: 'score', payload: { cash: 3, painting: 1, jewel: -1, mapNotes: 2, text: '上报' } })).data.submission;
  assert.deepEqual(sc.payload, { cash: 3, painting: 1, jewel: null, mapNotes: 2, text: '上报' }, '件数不对的记为空');
  const sc2 = (await sub(call, g, u.pl1, '', { as: 'seat', kind: 'score', payload: { cash: 4 } })).data.submission;
  const mine = await subs(call, g, u.pl1, 'seat');
  assert.equal(mine.find((x) => x.id === sc.id).status, 'withdrawn', '分数只留最新一份');
  assert.equal(mine.find((x) => x.id === sc2.id).status, 'pending');
  const dismissed = (await sub(call, g, u.host, `/${sc2.id}/dismiss`, { as: 'host', note: '请先清点珠宝' })).data.submission;
  assert.deepEqual([dismissed.status, dismissed.note], ['dismissed', '请先清点珠宝']);
});

// ---------------------------------------------------------------- 站内投票

const poll = (call, g, who, path, body) => call(`/api/games/${g.id}/polls${path}`, { body, cookie: who.cookie });
const polls = async (call, g, who, as) => (await call(`/api/games/${g.id}/polls?as=${as}`, { cookie: who.cookie })).data.polls;
const OPTS = [{ id: 'fix', label: '修发电机' }, { id: 'run', label: '离开' }];

test('投票：只有主持人能发起和结束；名单里的人才能投，可以改票；结束后不能再投；采用结果只能在结束后', async (t) => {
  const { call } = await start(t);
  const { u, g, ids } = await activeGame(call);
  assert.equal((await poll(call, g, u.pl1, '', { as: 'seat', title: 'x', options: OPTS, voters: [ids.a] })).data.error, 'host_only');
  assert.equal((await poll(call, g, u.host, '', { as: 'host', title: 'x', options: [OPTS[0]], voters: [ids.a] })).data.error, 'bad_options');
  assert.equal((await poll(call, g, u.host, '', { as: 'host', title: 'x', options: OPTS, voters: ['nobody'] })).data.error, 'bad_voters');
  const p = (await poll(call, g, u.host, '', { as: 'host', title: '停电', body: '灯灭了', options: OPTS, voters: [ids.a, ids.b], flowRef: 'f1' })).data.poll;
  assert.deepEqual([p.status, p.total, p.voted], ['open', 2, 0]);

  assert.equal((await poll(call, g, u.pl1, `/${p.id}/vote`, { as: 'seat', option: 'nope' })).data.error, 'bad_option');
  assert.equal((await poll(call, g, u.pl1, `/${p.id}/vote`, { as: 'seat', option: 'fix' })).data.poll.myVote, 'fix');
  assert.equal((await poll(call, g, u.pl1, `/${p.id}/vote`, { as: 'seat', option: 'run' })).data.poll.myVote, 'run', '改票');
  await poll(call, g, u.pl2, `/${p.id}/vote`, { as: 'seat', option: 'run' });
  const hv = (await polls(call, g, u.host, 'host'))[0];
  assert.deepEqual([hv.voted, hv.counts], [2, { fix: 0, run: 2 }], '改票覆盖，不重复计');
  assert.equal((await poll(call, g, u.host, `/${p.id}/adopt`, { as: 'host', option: 'run' })).data.error, 'poll_not_closed');
  assert.equal((await poll(call, g, u.pl1, `/${p.id}/close`, { as: 'seat' })).data.error, 'host_only');
  assert.equal((await poll(call, g, u.host, `/${p.id}/close`, { as: 'host' })).data.poll.status, 'closed');
  assert.equal((await poll(call, g, u.pl1, `/${p.id}/vote`, { as: 'seat', option: 'fix' })).data.error, 'poll_closed');
  assert.equal((await poll(call, g, u.host, `/${p.id}/adopt`, { as: 'host', option: 'run' })).data.poll.result, 'run');

  // 名单外（主导自己的座位不在名单里）不能投；同一个事件流程重新发起时旧的取消
  const hostSeat = await seatIdOf(call, g, u.host);
  const q = (await poll(call, g, u.host, '', { as: 'host', title: '再来', options: OPTS, voters: [ids.a], flowRef: 'f2' })).data.poll;
  assert.equal((await poll(call, g, u.host, `/${q.id}/vote`, { as: 'seat', option: 'fix' })).data.error, 'not_voter');
  assert.ok(hostSeat);
  const q2 = (await poll(call, g, u.host, '', { as: 'host', title: '再来一次', options: OPTS, voters: [ids.a], flowRef: 'f2' })).data.poll;
  const all = await polls(call, g, u.host, 'host');
  assert.equal(all.find((x) => x.id === q.id).status, 'cancelled');
  assert.equal(all.find((x) => x.id === q2.id).status, 'open');
  await call(`/api/games/${g.id}/status`, { body: { status: 'paused' }, cookie: u.host.cookie });
  assert.equal((await poll(call, g, u.pl1, `/${q2.id}/vote`, { as: 'seat', option: 'fix' })).data.error, 'read_only');
});

test('投票保密：投票中玩家只看到已投人数和自己的票；结束后看到各选项票数；谁投了什么只有主持人看得到；推送按身份裁剪', async (t) => {
  const { call, base } = await start(t);
  const { u, g, ids } = await activeGame(call);
  const s2 = await sock(base, u.pl2.cookie);
  const hs = await sock(base, u.host.cookie);
  t.after(() => { s2.close(); hs.close(); });
  const p = (await poll(call, g, u.host, '', { as: 'host', title: '停电', options: OPTS, voters: [ids.a, ids.b] })).data.poll;
  await poll(call, g, u.pl1, `/${p.id}/vote`, { as: 'seat', option: 'fix' });

  const seen = (await polls(call, g, u.pl2, 'seat'))[0];
  assert.deepEqual([seen.voted, seen.myVote, seen.counts, seen.ballots], [1, null, undefined, undefined]);
  const pushed = await s2.waitFor('poll:update', (m) => m.as === 'seat' && m.poll.voted === 1);
  assert.equal(pushed.poll.counts, undefined, '推给玩家的也没有票数');
  const hostPushed = await hs.waitFor('poll:update', (m) => m.as === 'host' && m.poll.voted === 1);
  assert.deepEqual(hostPushed.poll.ballots, [{ seat: ids.a, option: 'fix' }]);

  await poll(call, g, u.host, `/${p.id}/close`, { as: 'host' });
  const after = (await polls(call, g, u.pl2, 'seat'))[0];
  assert.deepEqual(after.counts, { fix: 1, run: 0 });
  assert.equal(after.ballots, undefined, '结束后也看不到谁投了什么');
});
