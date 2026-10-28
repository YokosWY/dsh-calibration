#!/usr/bin/env node
/**
 * 生成 allowedModels 片段（v3.0.0）
 *
 * 为什么需要它：宿主把「子代理能用哪些 provider/model」记在
 * `subagent-model-selection-settings.allowedModels`，而且白名单在会话创建时就快照了。
 * CT 自己的能力档案算出的两档 route，必须**一次性全写进白名单**，效率/性能切换才能即时生效。
 *
 * 用法：
 *   node scripts/allowed-models.mjs                 # 读 CT 写下的注册表缓存（storages/calibration-models.cache.json）
 *   node scripts/allowed-models.mjs <models.json>   # 或给一份 [{provider,model}, ...]
 *   node scripts/allowed-models.mjs --write <profile/cordis.patch.yml>   # 直接改 profile 的 yml（会先备份）
 *
 * 输出是 YAML 片段，形如：
 *   - provider: xxx
 *     model: yyy
 */
import { readFileSync, writeFileSync, existsSync, copyFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { scoreRoute, planRoutes, allowedRoutes, fingerprintOf } from "../lib/agents.js";
import { AGENT_PROFILES } from "../lib/core.js";

const DSH_HOME = process.env.DSH_HOME || join(homedir(), ".dsh");
const CACHE = join(DSH_HOME, "storages", "calibration-models.cache.json");

function die(msg) {
  console.error(`[allowed-models] ${msg}`);
  process.exit(1);
}

const args = process.argv.slice(2);
const writeIdx = args.indexOf("--write");
const writeTarget = writeIdx >= 0 ? args[writeIdx + 1] : null;
const fileArg = args.find((a, i) => !a.startsWith("--") && i !== writeIdx + 1);

let raw = [];
if (fileArg) {
  if (!existsSync(fileArg)) die(`找不到文件：${fileArg}`);
  raw = JSON.parse(readFileSync(fileArg, "utf8"));
} else if (existsSync(CACHE)) {
  raw = JSON.parse(readFileSync(CACHE, "utf8")).routes || [];
} else {
  die(`没有注册表缓存（${CACHE}）。先让 CT 跑一次工具，或手动给一份 [{provider,model}] JSON。`);
}

const routes = (Array.isArray(raw) ? raw : []).map((r) => {
  if (!r || typeof r !== "object" || !r.provider || !r.model) die("每条 route 必须有非空 provider 与 model");
  return scoreRoute(r.provider, r.model);
});
if (routes.length === 0) die("模型清单为空");

const picked = allowedRoutes(routes);
if (picked.length === 0) die("算不出任何可用 route（模型清单为空？）");

const yaml =
  "allowedModels:\n" +
  picked.map((r) => `  - provider: ${r.provider}\n    model: ${r.model}`).join("\n") +
  "\n";

console.log(`# 注册表指纹：${fingerprintOf(routes)}（${routes.length} 个候选 → ${picked.length} 条 route）`);
for (const profile of AGENT_PROFILES) {
  const plan = planRoutes(routes, profile);
  console.log(`# ${profile}: ${plan.text}`);
}
console.log("");
console.log(yaml);

if (writeTarget) {
  if (!existsSync(writeTarget)) die(`要写入的文件不存在：${writeTarget}`);
  const text = readFileSync(writeTarget, "utf8");
  const marker = "allowedModels:";
  if (!text.includes(marker)) die(`文件里没有 ${marker}，不自动插入（避免改坏结构）`);
  // 只替换 allowedModels 段：到下一条同级 `- id:` 或文件末尾
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((l) => l.includes(marker));
  let end = start + 1;
  while (end < lines.length) {
    const l = lines[end];
    if (/^\s{0,2}- id:/.test(l) || /^\s{0,2}disabled:/.test(l)) break;
    end += 1;
  }
  const indent = (lines[start].match(/^\s*/) || [""])[0];
  const block = yaml
    .trimEnd()
    .split("\n")
    .map((l) => indent + l)
    .join("\n");
  const next = [...lines.slice(0, start), block, ...lines.slice(end)].join("\n");
  copyFileSync(writeTarget, `${writeTarget}.bak-allowed-models-${Date.now()}`);
  writeFileSync(writeTarget, next, "utf8");
  console.log(`# 已写入 ${writeTarget}（备份在同目录 .bak-allowed-models-*）`);
  console.log("# 改完要重启 DSH；白名单在会话创建时快照，只对之后新建的会话生效");
}
