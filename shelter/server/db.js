// 数据库：Node 自带的 SQLite（node:sqlite），单文件，部署时挂在 Docker 卷上。
// 表结构按 PRAGMA user_version 逐步升级：往 MIGRATIONS 末尾追加，已上线的条目不要改。

const { DatabaseSync } = require('node:sqlite');
const { mkdirSync } = require('node:fs');
const { dirname } = require('node:path');

const MIGRATIONS = [
  // 1：账户与登录会话（一个账户可以同时在多台设备上登录）
  `CREATE TABLE users (
     id            TEXT PRIMARY KEY,
     username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
     password_hash TEXT NOT NULL,
     created_at    INTEGER NOT NULL
   );
   CREATE TABLE sessions (
     token_hash TEXT PRIMARY KEY,
     user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     created_at INTEGER NOT NULL,
     expires_at INTEGER NOT NULL
   );
   CREATE INDEX sessions_user ON sessions(user_id);`,
  // 2：对局与座位。主导不一定占座位（只主持）；座位的 user_id 为空＝已被释放，数据留在座位上等新人接手。
  // 主导在开局后删除对局只是对自己隐藏（owner_deleted_at），记录仍保留在服务器上。
  `CREATE TABLE games (
     id               TEXT PRIMARY KEY,
     owner_id         TEXT NOT NULL REFERENCES users(id),
     title            TEXT NOT NULL,
     code             TEXT NOT NULL UNIQUE,
     status           TEXT NOT NULL,
     max_seats        INTEGER NOT NULL,
     created_at       INTEGER NOT NULL,
     updated_at       INTEGER NOT NULL,
     owner_deleted_at INTEGER
   );
   CREATE INDEX games_owner ON games(owner_id);
   CREATE TABLE seats (
     id        TEXT PRIMARY KEY,
     game_id   TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
     seat_no   INTEGER NOT NULL,
     user_id   TEXT REFERENCES users(id),
     joined_at INTEGER,
     UNIQUE (game_id, seat_no),
     UNIQUE (game_id, user_id)
   );
   CREATE INDEX seats_user ON seats(user_id);`,
  // 3：面板存档（JSON）。主持人存档跟着对局，玩家存档跟着座位；version 用来发现两台设备同时修改。
  `ALTER TABLE games ADD COLUMN host_state TEXT;
   ALTER TABLE games ADD COLUMN host_version INTEGER NOT NULL DEFAULT 0;
   ALTER TABLE seats ADD COLUMN state TEXT;
   ALTER TABLE seats ADD COLUMN version INTEGER NOT NULL DEFAULT 0;`,
];

function openDb(path) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  const version = db.prepare('PRAGMA user_version').get().user_version;
  for (let v = version; v < MIGRATIONS.length; v++) {
    db.exec('BEGIN');
    try {
      db.exec(MIGRATIONS[v]);
      db.exec(`PRAGMA user_version = ${v + 1}`);
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }
  return db;
}

module.exports = { openDb };
