#!/usr/bin/env node
// 管理员命令（在服务器上执行）：
//   node server/admin.js reset-password <用户名>   生成临时密码并打印，同时让该账户所有设备下线
//   node server/admin.js list-users                列出全部账户
// Docker 里：docker compose exec shelter node server/admin.js reset-password alice
// 数据库位置与服务端一致：读 DB_PATH，默认 shelter/data/shelter.db

const crypto = require('node:crypto');
const { join } = require('node:path');
const { openDb } = require('./db');
const { setPassword } = require('./auth');

async function main([cmd, arg]) {
  const db = openDb(process.env.DB_PATH || join(__dirname, '..', 'data', 'shelter.db'));
  if (cmd === 'reset-password' && arg) {
    const temp = crypto.randomBytes(9).toString('base64url');
    if (!(await setPassword(db, arg, temp))) {
      console.error(`没有这个用户：${arg}`);
      return 1;
    }
    console.log(`已重置 ${arg} 的密码，临时密码：${temp}`);
    return 0;
  }
  if (cmd === 'list-users') {
    for (const u of db.prepare('SELECT id, username, created_at FROM users ORDER BY created_at').all()) {
      console.log(`${u.username}\t${u.id}\t${new Date(u.created_at).toISOString()}`);
    }
    return 0;
  }
  console.error('用法：node server/admin.js reset-password <用户名> | list-users');
  return 1;
}

main(process.argv.slice(2)).then((code) => { process.exitCode = code; });
