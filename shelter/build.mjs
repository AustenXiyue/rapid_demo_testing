#!/usr/bin/env node
// 把 src/ 下共用的数据与代码内联成两个自包含页面：host.html、player.html。
// 产物不依赖任何外部资源，双击即可离线打开；部署到 Vercel 时也是这两个文件原样上传。
//
//   node build.mjs          生成
//   node build.mjs --check  只检查产物是否与源码一致（不一致时退出码 1）

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const PAGES = [
  { template: 'src/host/host.html', out: 'host.html' },
  { template: 'src/player/player.html', out: 'player.html' },
];
const BANNER = '<!-- 此文件由 shelter/build.mjs 从 shelter/src/ 生成，请勿直接修改。 -->';

function inline(templatePath) {
  const template = readFileSync(join(ROOT, templatePath), 'utf8');
  return template.replace(/<!-- inline:(css|js) ([^ ]+) -->/g, (_, kind, file) => {
    const source = readFileSync(join(ROOT, file), 'utf8').trimEnd();
    if (kind === 'css') {
      if (/<\/style/i.test(source)) throw new Error(`${file} 含有 </style，无法内联`);
      return `<style>\n/* ${file} */\n${source}\n</style>`;
    }
    // 防止脚本里出现的 </script 提前结束标签
    return `<script>\n/* ${file} */\n${source.replace(/<\/script/gi, '<\\/script')}\n</script>`;
  }).replace(/^<!doctype html>\n/i, (m) => m + BANNER + '\n');
}

const check = process.argv.includes('--check');
let stale = 0;
for (const page of PAGES) {
  const html = inline(page.template);
  if (/<!-- inline:/.test(html)) throw new Error(`${page.template} 还有未处理的 inline 占位`);
  if (/\b(src|href)=["']https?:/i.test(html)) throw new Error(`${page.out} 引用了外部资源`);
  const outPath = join(ROOT, page.out);
  if (check) {
    const current = existsSync(outPath) ? readFileSync(outPath, 'utf8') : '';
    if (current !== html) {
      console.error(`✗ ${page.out} 与源码不一致，请运行 node shelter/build.mjs`);
      stale += 1;
    } else {
      console.log(`✓ ${page.out} 已是最新`);
    }
  } else {
    writeFileSync(outPath, html);
    console.log(`已生成 ${page.out}（${(Buffer.byteLength(html) / 1024).toFixed(1)} KB）`);
  }
}
if (stale) process.exit(1);
