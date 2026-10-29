#!/usr/bin/env node
/**
 * 客户端分片拼接（v3.7.0）
 *
 * 为什么要有这一步：`lib/client.js` 是浏览器侧的单文件模块（`window.__ModuleLoader__.load`
 * 只认一个 id 一个文件），拆成真模块加载不了；但 1072 行单文件又难维护。
 * 折中：源码按职责切成 `lib/client/*.js` 分片，构建时按文件名排序拼回 `lib/client.js`，
 * 发布面仍是单文件。分片只许改 `lib/client/`，改 `lib/client.js` 会被 `--check` 判漂移。
 *
 * 用法：
 *   node scripts/build-client.mjs           # 重新生成 lib/client.js
 *   node scripts/build-client.mjs --check   # 只比对，漂移则退出码 1（CI / npm run verify 用）
 */
import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const PARTS = join(root, "lib", "client");
const TARGET = join(root, "lib", "client.js");

if (!existsSync(PARTS)) {
  console.error(`缺分片目录：${PARTS}`);
  process.exit(1);
}
const parts = readdirSync(PARTS)
  .filter((f) => f.endsWith(".js"))
  .sort();
if (parts.length === 0) {
  console.error(`${PARTS} 下没有分片`);
  process.exit(1);
}

// 用 Buffer 拼接：分片里 CRLF/LF 都要原样带过去，字符串模式会吃掉 \r
const built = Buffer.concat(parts.map((f) => readFileSync(join(PARTS, f))));
const current = existsSync(TARGET) ? readFileSync(TARGET) : Buffer.alloc(0);
const check = process.argv.includes("--check");

if (check) {
  if (!built.equals(current)) {
    console.error(`lib/client.js 与 lib/client/*.js 拼接结果不一致（${parts.length} 个分片）——改完分片跑 npm run build:client`);
    process.exit(1);
  }
  console.log(`客户端分片一致：${parts.length} 个分片 → ${built.length} 字节`);
} else {
  writeFileSync(TARGET, built);
  console.log(`已生成 lib/client.js：${parts.length} 个分片 → ${built.length} 字节`);
}
