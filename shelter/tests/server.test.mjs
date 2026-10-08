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
  assert.deepEqual(m.reason, { rules: true, roster: false });
  assert.equal(m.version, 3);
  assert.equal(m.state.rules.inventoryCapacityTicks, 24);
  assert.equal(m.state.hp, 4, '库存和状态不动');
  assert.match(m.state.log[0].text, /主持人更新了规则/);

  ps.clearSeen();
  host.state.players[2].name = '二狗';
  await put(call, g, 'host', u.host, 3, host.state);
  const m2 = await ps.waitFor('state:update', (x) => x.reason);
  assert.deepEqual(m2.reason, { rules: false, roster: true });
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
