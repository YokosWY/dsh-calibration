#!/usr/bin/env node
/**
 * 模型路由自检（v3.9.0）
 *
 * 作用：把「宿主注册表里有什么 → 按当前能力表打成几分 → 两档各挑谁」摊开给用户看。
 * 换台机器 / 别人装完后先跑这一条，确认能达到同样的效果，顺带指出该覆盖哪几条。
 *
 * 用法：
 *   node scripts/doctor.mjs
 *   node scripts/doctor.mjs --home=D:/AI/DSH-NEXT
 *   node scripts/doctor.mjs --main=deepseek-account/deepseek-flash
 *
 * 只读：读 `storages/calibration-models.cache.json`（插件上次枚举的注册表快照）与
 * `storages/calibration-models.json`（覆盖配置）；不联网、不读凭据、不写盘。
 * 快照里的族分会被**当前代码重新打分**，所以改完能力表直接重跑就能看效果。
 */
import { join } from "node:path";
import { homedir } from "node:os";
import { existsSync, readFileSync } from "node:fs";

const argv = process.argv.slice(2);
const flag = (name) => {
  const eq = argv.find((a) => a.startsWith(`--${name}=`));
  if (eq) return eq.slice(name.length + 3);
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : "";
};
const home = flag("home") || process.env.DSH_HOME || join(homedir(), ".dsh");
process.env.DSH_HOME = home;

const { planRoutes, scoreRoute, isChatModel, excludedKeys, readConfig, families } = await import("../lib/agents.js");

const cachePath = join(home, "storages", "calibration-models.cache.json");
const configPath = join(home, "storages", "calibration-models.json");
const line = (s = "") => console.log(s);

/** 中文/全角算 2 列，避免表格错位。 */
const width = (s) => [...String(s)].reduce((n, ch) => n + (/[\u1100-\uFFEF]/.test(ch) ? 2 : 1), 0);
const pad = (s, n) => String(s) + " ".repeat(Math.max(0, n - width(s)));

line(`模型路由自检 · DSH_HOME=${home}`);
line(`覆盖配置：${existsSync(configPath) ? configPath : "(无，沿用内置能力表)"}`);

let cache = null;
try {
  cache = JSON.parse(readFileSync(cachePath, "utf8"));
} catch {
  line("");
  line("⚠ 没有注册表快照：先在 DSH 里发一轮消息（插件会调一次 clarify_tier），或确认插件已加载。");
  process.exit(2);
}

const cfg = readConfig();
const excluded = excludedKeys();
const overrides = cfg.models && typeof cfg.models === "object" ? cfg.models : {};
const raw = Array.isArray(cache.routes) ? cache.routes : [];
const all = raw.map((r) => {
  const route = scoreRoute(r.provider, r.model, overrides);
  route.contextWindow = Number(r.contextWindow) || route.contextWindow;
  route.efforts = Array.isArray(r.efforts) ? r.efforts : [];
  return route;
});
const skipped = all.filter((r) => excluded.has(`${r.provider}/${r.model}`) || !isChatModel(r.model, overrides[`${r.provider}/${r.model}`]));
const routes = all.filter((r) => !skipped.includes(r));

line(`注册表快照：${raw.length} 条 → 参与打分 ${routes.length} 条（剔除 ${skipped.length} 条）· 指纹 ${cache.fingerprint || "?"} · ${cache.at || "?"}`);
line("");

// 表头（分值列不写字，避免中英混排错位；顺位见下）
line(`${pad("provider / model", 46)}${pad("族", 16)}${pad("档", 5)}${pad("分值(代码/推理/写作/长文/工具)", 30)}${pad("ctx", 9)}标记`);
const unknown = [];
for (const r of routes) {
  const k = `${r.provider}/${r.model}`;
  if (!r.family) unknown.push(k);
  const s = r.score || {};
  const marks = [];
  if (r.free) marks.push("免费线");
  if (r.overridden) marks.push("已覆盖");
  line(
    `${pad(k, 46)}${pad(r.family || "未识别", 16)}${pad(r.tier, 5)}` +
      `${pad([s.code, s.reasoning, s.writing, s.longContext, s.toolUse].join("/"), 30)}` +
      `${pad(r.contextWindow || 0, 9)}${marks.join(" ")}`,
  );
}
if (skipped.length > 0) {
  line("");
  line(`剔除（非聊天 / 显式排除）：${skipped.map((r) => `${r.provider}/${r.model}`).join("、")}`);
}
line("");

const mainArg = flag("main");
const [mainProvider, mainModel] = mainArg.includes("/") ? mainArg.split("/") : ["", ""];
if (mainProvider) line(`基线（主模型）：${mainProvider}/${mainModel}`);
else line("基线（主模型）：未指定 —— 隔离度一律按最差算；要贴近真实运行请加 --main=provider/model");
line("");

for (const profile of ["efficiency", "performance"]) {
  const plan = planRoutes(routes, profile, { mainProvider, mainModel });
  line(`── ${profile === "efficiency" ? "效率档（强化一档 + 性价比）" : "性能档（绝对质量）"} · 最多 ${plan.maxChildren} 个孩子`);
  for (const [module, v] of Object.entries(plan.modules)) {
    line(
      `   ${pad(module, 10)}` +
        (v
          ? `${v.provider}/${v.model}（隔离 ${v.isolation}${v.isolationReason ? " · " + v.isolationReason : ""}${v.isolationRole ? " · " + v.isolationRole : ""}）`
          : "不可用（该模块没有候选）"),
    );
  }
  if (plan.fallback) {
    const ok = Object.entries(plan.fallback.modules).filter(([, v]) => v).length;
    line(`   ${pad("回退", 10)}效率档 ${ok}/4 个模块可用`);
  }
  line("");
}

line("提示");
if (unknown.length > 0) {
  line(`· ${unknown.length} 条模型未识别（5 分兜底）：${unknown.slice(0, 6).join("、")}${unknown.length > 6 ? " …" : ""}`);
  line(`  想让它们参与排序，在 ${configPath} 里加 families 或 models 覆盖，格式见 README「换台机器 / 别人用」。`);
}
if (skipped.length > 0) line("· 被剔除的模型不会进入任何档；要保留请在覆盖文件里设 chat: true。");
line(`· 内置能力族 ${families().length} 条；覆盖文件支持 models / providers / families / exclude 四类键。`);
