// 避难所联机服务端入口：HTTP 接口 + 静态页面 + Socket.IO，监听 3000 端口。
//
// 路径一律按根 / 编写：线上由 Caddy 把 https://xiyueym.com/Misc/ShelterPT/* 去掉前缀后转发过来。
// 环境变量：
//   PORT              监听端口，默认 3000
//   DB_PATH           SQLite 文件，默认 shelter/data/shelter.db
//   PUBLIC_BASE_PATH  对外的路径前缀，只用于 cookie 的 Path，默认 /（线上设为 /Misc/ShelterPT/）
//   TRUST_PROXY       信任哪些反向代理传来的 X-Forwarded-*，默认 loopback, uniquelocal（本机与 Docker 内网）

const http = require('node:http');
const { join } = require('node:path');
const express = require('express');
const { Server } = require('socket.io');
const { openDb } = require('./db');
const auth = require('./auth');
const { createGames } = require('./games');

const ROOT = join(__dirname, '..');
// 只公开这些页面；src/、tests/、server/、data/ 等一律不对外
const PAGES = ['index.html', 'host.html', 'player.html'];

function createServer({
  dbPath = join(ROOT, 'data', 'shelter.db'),
  basePath = '/',
  trustProxy = 'loopback, uniquelocal',
  rateLimit,
} = {}) {
  const db = openDb(dbPath);
  const app = express();
  app.set('trust proxy', trustProxy);
  app.disable('x-powered-by');

  const server = http.createServer(app);
  const io = new Server(server, { path: '/socket.io' });
  const games = createGames(db, io);

  app.get('/healthz', (req, res) => res.json({ ok: true }));
  app.use('/api/games', games.router);
  app.use('/api', auth.router(db, { basePath, rateLimit }));
  app.get('/', (req, res) => res.sendFile(join(ROOT, 'index.html')));
  for (const page of PAGES) app.get('/' + page, (req, res) => res.sendFile(join(ROOT, page)));

  io.use(auth.socketAuth(db));
  io.on('connection', (socket) => {
    const user = socket.data.user;
    socket.join('user:' + user.id);
    games.attach(socket);
    socket.emit('hello', { user });
  });

  return { app, server, io, db };
}

if (require.main === module) {
  const port = Number(process.env.PORT) || 3000;
  const { server } = createServer({
    dbPath: process.env.DB_PATH || undefined,
    basePath: process.env.PUBLIC_BASE_PATH || '/',
    trustProxy: process.env.TRUST_PROXY || undefined,
  });
  server.listen(port, () => console.log(`避难所服务端已启动：http://localhost:${port}/`));
}

module.exports = { createServer };
