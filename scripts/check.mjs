// 语法检查：lib 下所有模块 + 所有测试 + 本脚本自己。
// 不引第三方 lint：这个插件零依赖，装 ESLint 的收益不如守住「每个文件都能被 node 解析」。
import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pick = (dir, ext) =>
  readdirSync(join(root, dir))
    .filter((f) => f.endsWith(ext))
    .sort()
    .map((f) => join(dir, f));

const targets = [...pick("lib", ".js"), ...pick("test", ".mjs"), join("scripts", "check.mjs")];
let bad = 0;
for (const rel of targets) {
  const res = spawnSync(process.execPath, ["--check", join(root, rel)], { encoding: "utf8" });
  if (res.status !== 0) {
    bad += 1;
    process.stderr.write(`✖ ${rel}\n${res.stderr || res.error || ""}`);
  }
}
if (bad) {
  console.error(`语法检查失败：${bad} / ${targets.length} 个文件`);
  process.exit(1);
}
console.log(`语法检查通过：${targets.length} 个文件`);
