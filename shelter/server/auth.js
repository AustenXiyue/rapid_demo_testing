// 账户：注册、登录、登出、当前账户，以及给 Socket.IO 用的身份识别。
//
// - 密码用 Node 自带的 scrypt 加随机盐哈希，不引入额外依赖。
// - 登录后发一个随机令牌放进 httpOnly cookie；数据库只存令牌的 SHA-256，泄露数据库也拿不到可用的令牌。
// - cookie 的 Path 由 basePath 决定：反向代理会去掉 /Misc/ShelterPT 前缀，服务端自己看不到它。

const crypto = require('node:crypto');
const { promisify } = require('node:util');
const express = require('express');

const scrypt = promisify(crypto.scrypt);
const COOKIE = 'shelterpt_sid';
const SESSION_MS = 30 * 24 * 3600 * 1000;
const USERNAME_RE = /^[\p{L}\p{N}_]{3,20}$/u;
const PASSWORD_MIN = 8;
const PASSWORD_MAX = 200;
const KEY_LEN = 64;
// 用户名不存在时也算一次哈希，让「用户名不存在」和「密码错」的响应时间一样
const DUMMY_HASH = 'scrypt$' + crypto.randomBytes(16).toString('base64') + '$' + crypto.randomBytes(KEY_LEN).toString('base64');

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password, salt, KEY_LEN);
  return 'scrypt$' + salt.toString('base64') + '$' + key.toString('base64');
}

async function verifyPassword(password, stored) {
  const [scheme, salt, hash] = String(stored).split('$');
  if (scheme !== 'scrypt' || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64');
  const key = await scrypt(password, Buffer.from(salt, 'base64'), expected.length);
  return crypto.timingSafeEqual(key, expected);
}

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

function createSession(db, userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  const now = Date.now();
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(now);
  db.prepare('INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
    .run(sha256(token), userId, now, now + SESSION_MS);
  return token;
}

// 从 Cookie 请求头里取出令牌，查到对应的账户；无效或过期时返回 null
function userFromCookie(db, cookieHeader) {
  const m = /(?:^|;\s*)shelterpt_sid=([A-Za-z0-9_-]+)/.exec(cookieHeader || '');
  if (!m) return null;
  const row = db.prepare(
    `SELECT u.id, u.username, s.expires_at FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?`
  ).get(sha256(m[1]));
  if (!row || row.expires_at < Date.now()) return null;
  return { id: row.id, username: row.username, token: m[1] };
}

// 管理员重置密码：换上新密码，同时让这个账户所有已登录的设备下线
async function setPassword(db, username, password) {
  const user = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
  if (!user) return false;
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(await hashPassword(password), user.id);
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(user.id);
  return true;
}

function router(db, { basePath = '/', rateLimit = { max: 20, windowMs: 10 * 60 * 1000 } } = {}) {
  const r = express.Router();
  r.use(express.json({ limit: '4kb' }));

  // 注册、登录按 IP 计数，防暴力破解；只存在内存里，重启清零
  const hits = new Map();
  function limited(req, res, next) {
    const now = Date.now();
    const h = hits.get(req.ip);
    if (!h || h.reset < now) hits.set(req.ip, { count: 1, reset: now + rateLimit.windowMs });
    else if (++h.count > rateLimit.max) return res.status(429).json({ error: 'rate_limited' });
    if (hits.size > 10000) for (const [ip, v] of hits) if (v.reset < now) hits.delete(ip);
    next();
  }

  function login(req, res, user) {
    res.cookie(COOKIE, createSession(db, user.id), {
      path: basePath, httpOnly: true, sameSite: 'lax', secure: req.secure, maxAge: SESSION_MS,
    });
    res.json({ user: { id: user.id, username: user.username } });
  }

  r.post('/register', limited, async (req, res) => {
    const { username, password } = req.body || {};
    if (typeof username !== 'string' || !USERNAME_RE.test(username)) return res.status(400).json({ error: 'bad_username' });
    if (typeof password !== 'string' || password.length < PASSWORD_MIN || password.length > PASSWORD_MAX) {
      return res.status(400).json({ error: 'bad_password' });
    }
    const user = { id: crypto.randomUUID(), username };
    const hash = await hashPassword(password);
    try {
      db.prepare('INSERT INTO users (id, username, password_hash, created_at) VALUES (?, ?, ?, ?)')
        .run(user.id, username, hash, Date.now());
    } catch (e) {
      if (/UNIQUE/.test(e.message)) return res.status(409).json({ error: 'username_taken' });
      throw e;
    }
    login(req, res, user);
  });

  r.post('/login', limited, async (req, res) => {
    const { username, password } = req.body || {};
    if (typeof username !== 'string' || typeof password !== 'string' || password.length > PASSWORD_MAX) {
      return res.status(400).json({ error: 'bad_request' });
    }
    const user = db.prepare('SELECT id, username, password_hash FROM users WHERE username = ?').get(username);
    const ok = await verifyPassword(password, user ? user.password_hash : DUMMY_HASH);
    if (!user || !ok) return res.status(401).json({ error: 'wrong_credentials' });
    login(req, res, user);
  });

  r.post('/logout', (req, res) => {
    const me = userFromCookie(db, req.headers.cookie);
    if (me) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(me.token));
    res.clearCookie(COOKIE, { path: basePath, httpOnly: true, sameSite: 'lax', secure: req.secure });
    res.json({ ok: true });
  });

  r.get('/me', (req, res) => {
    const me = userFromCookie(db, req.headers.cookie);
    res.json({ user: me ? { id: me.id, username: me.username } : null });
  });

  return r;
}

// Socket.IO 中间件：连接时带着同一个 cookie，认不出账户就拒绝
function socketAuth(db) {
  return (socket, next) => {
    const me = userFromCookie(db, socket.request.headers.cookie);
    if (!me) return next(new Error('unauthorized'));
    socket.data.user = { id: me.id, username: me.username };
    next();
  };
}

module.exports = { router, socketAuth, setPassword };
