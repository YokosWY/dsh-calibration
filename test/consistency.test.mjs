// 一致性守则：版本、名字、文档、发布面。
// 起因（1.2.1）：代码改了名，工具描述和 README 还停在旧说法——这类漂移靠人盯不住，交给测试。
// 运行：npm test
import test from "node:test";
import assert from "node:assert";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { LEVELS, ROUTE_LEVELS, ROUTE_PLAN, LABELS, TITLES, DEFAULT_ROUTE, counterPlan, COUNTER_ATTACKS, routePlan, THINK_PLAN, THINK_LEVELS, thinkPlan, AGENT_PROFILES, AGENT_PLAN, DEFAULT_AGENT, agentPlan } from "../lib/core.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const read = (...p) => readFileSync(join(root, ...p), "utf8");
const pkg = JSON.parse(read("package.json"));
const libFiles = readdirSync(join(root, "lib"))
  .filter((f) => f.endsWith(".js"))
  .sort()
  .map((f) => `lib/${f}`);

test("版本号与 CHANGELOG 首条一致", () => {
  const first = read("CHANGELOG.md").match(/^## (\d+\.\d+\.\d+)/m);
  assert.ok(first, "CHANGELOG 里找不到版本标题");
  assert.equal(pkg.version, first[1], "package.json 版本与 CHANGELOG 首条不一致");
});

test("发布面文件都在（package.json files 清单）", () => {
  for (const f of pkg.files) {
    assert.ok(existsSync(join(root, f)), `files 清单里的 ${f} 不存在`);
  }
});

test("lib 下每个模块都被 files 清单覆盖", () => {
  const covered = new Set(pkg.files);
  for (const file of libFiles) {
    const dir = file.split("/")[0] + "/";
    assert.ok(covered.has(file) || covered.has(dir), `${file} 没进 package.json files，发版会缺文件`);
  }
});

test("当前文案统一叫「极致」，历史记录除外", () => {
  for (const f of [...libFiles, "docs/demo.svg"]) {
    assert.ok(!read(f).includes("极限"), `${f} 里还有旧名「极限」`);
  }
  assert.ok(pkg.description.includes("极致"), "package.json 描述没提到「极致」");
  assert.ok(!pkg.description.includes("极限"), "package.json 描述里还有旧名「极限」");
});

test("clarify_tier 的工具描述与宿主档位表同字", () => {
  const hit = libFiles.map((f) => [f, read(f).match(/name: "clarify_tier",\s*description:\s*\n?\s*"([^"]+)"/)]).find(([, m]) => m);
  assert.ok(hit, "lib 下找不到 clarify_tier 的描述");
  const [file, m] = hit;
  assert.ok(m[1].includes("常规/严格/极致"), `${file} 的工具描述没跟档位表对齐：${m[1]}`);
});

test("skill 的当前状态表用「极致」", () => {
  const rows = read("skill", "clarify-needs", "README.md").split(/\r?\n/);
  const row = rows.find((l) => l.startsWith("| **max**"));
  assert.ok(row, "skill README 里找不到 max 档那一行");
  assert.ok(row.includes("极致"), `max 档那一行还是旧名：${row}`);
});

test("技能里的档位表与宿主 LEVELS 是同一套", () => {
  // 档位条只有 off/high/max 三格；技能文档里多写一档，模型就会去读一个拨不到的档
  const levelsIn = (file) =>
    [...read(file).matchAll(/^\|\s*\*\*(off|low|high|max)\*\*\s*\|/gm)].map((m) => m[1]);
  for (const file of ["skill/clarify-needs/SKILL.md", "skill/clarify-needs/README.md"]) {
    assert.deepEqual(levelsIn(file), LEVELS, `${file} 的档位表与宿主 LEVELS 不一致`);
  }
});

test("对抗审：默认关、开之后密度随档位、scope 随模式、隔离随开关", () => {
  assert.deepEqual(Object.keys(COUNTER_ATTACKS).sort(), [...LEVELS].sort(), "COUNTER_ATTACKS 的键必须与 LEVELS 一致");
  assert.deepEqual(counterPlan("think", "high", false), {
    enabled: false,
    maxAttacks: 0,
    scope: "plan+delivery",
    isolation: "none",
  });
  assert.deepEqual(counterPlan("think", "high", true), {
    enabled: true,
    maxAttacks: 3,
    scope: "plan+delivery",
    isolation: "subagent-preferred",
  });
  assert.deepEqual(counterPlan("loop", "max", true), {
    enabled: true,
    maxAttacks: 5,
    scope: "round-changes",
    isolation: "subagent-preferred",
  });
});

test("文案统一叫「五模式」：现行文档不再出现「双模式 / 两个模式 / 三模式 / 四模式」", () => {
  const readme = read("README.md");
  assert.match(readme, /五模式/, "README 必须明确写「五模式」");
  const files = [
    ["README.md"],
    ["skill", "clarify-needs", "SKILL.md"],
    ["skill", "counter-review", "SKILL.md"],
    ["skill", "counter-review", "README.md"],
  ];
  for (const parts of files) {
    const text = read(...parts);
    assert.equal(/双模式|两个模式|三模式|四模式/.exec(text), null, `${parts.join("/")} 仍在用旧说法`);
  }
  assert.match(read("docs", "demo.svg"), /同框五模式/, "demo 标题要写「同框五模式」");
});

test("检索两档：标签、说明、执行计划三张表与 ROUTE_LEVELS 同键", () => {
  assert.deepEqual(Object.keys(LABELS.route).sort(), [...ROUTE_LEVELS].sort(), "LABELS.route 的键必须与 ROUTE_LEVELS 一致");
  assert.deepEqual(Object.keys(TITLES.route).sort(), [...ROUTE_LEVELS].sort(), "TITLES.route 的键必须与 ROUTE_LEVELS 一致");
  assert.deepEqual(Object.keys(ROUTE_PLAN).sort(), [...ROUTE_LEVELS].sort(), "ROUTE_PLAN 的键必须与 ROUTE_LEVELS 一致");
  assert.deepEqual([...ROUTE_LEVELS], ["high", "max"], "v3.0.0：去掉「本地」档——关掉开关就是本地");
  assert.equal("off" in ROUTE_PLAN, false, "off 不再是一档，关 = 不检索");
  assert.equal(ROUTE_PLAN.high.network, true);
  assert.equal(ROUTE_PLAN.max.network, true);
  // 全量不设读取上限（用户口径 2026-10-27），降本靠「只跑首轮」而不是砍读取
  assert.ok(ROUTE_PLAN.max.reads.includes("不设上限"), ROUTE_PLAN.max.reads);
  assert.ok(ROUTE_PLAN.max.guard.includes("只跑首轮"), ROUTE_PLAN.max.guard);
});

test("代理两档：标签、说明与 AGENT_PROFILES 同键，关着只回 on:false", () => {
  assert.deepEqual(Object.keys(LABELS.agent).sort(), [...AGENT_PROFILES].sort());
  assert.deepEqual(Object.keys(TITLES.agent).sort(), [...AGENT_PROFILES].sort());
  assert.deepEqual(Object.keys(AGENT_PLAN).sort(), [...AGENT_PROFILES].sort());
  assert.deepEqual(DEFAULT_AGENT, { on: false, profile: "efficiency" });
  const off = agentPlan(false, "performance");
  assert.deepEqual(off, { on: false }, "关着时只回 on:false，不占每步字");
  const on = agentPlan(true, "performance");
  assert.equal(on.on, true);
  assert.equal(on.label, "性能");
  assert.equal(on.maxChildren, 3);
  assert.equal(on.isolation, "require");
  assert.equal(typeof on.domains.executor, "string");
});

test("检索开关默认关、默认档位「增量」，关着时不发空计划", () => {
  assert.deepEqual(DEFAULT_ROUTE, { on: false, level: "high" });
  const off = routePlan(false, "max");
  assert.equal(off.on, false);
  assert.equal(off.plan, null, "关着时 plan 必须是 null");
  assert.equal(off.label, "全量", "关着也带档位名，客户端不用另算");
  const on = routePlan(true, "max");
  assert.equal(on.plan, ROUTE_PLAN.max);
  assert.equal(on.label, "全量");
});

test("公开文案不用口语词「万一」", () => {
  const files = [
    ["README.md"],
    ["docs", "使用说明.md"],
    ["docs", "demo.svg"],
    ["skill", "clarify-needs", "SKILL.md"],
    ["skill", "counter-review", "SKILL.md"],
    ["skill", "counter-review", "README.md"],
  ];
  for (const parts of files) {
    assert.equal(/万一/.exec(read(...parts)), null, `${parts.join("/")} 仍有口语「万一」`);
  }
});

test("counter-review 技能在位，description 合规", () => {
  const text = read("skill", "counter-review", "SKILL.md");
  assert.ok(text.startsWith("---"), "SKILL.md 缺少 frontmatter");
  assert.match(text, /^name: counter-review$/m, "name 必须是 counter-review");
  const m = text.match(/^description: "([^"]+)"$/m);
  assert.ok(m, "SKILL.md 缺 description");
  assert.ok(m[1].length <= 200, `description 长度 ${m[1].length}，超过 200`);
});

test("README 已知边界不再回头说全局与写死端口", () => {
  const parts = read("README.md").split("## 已知边界");
  assert.equal(parts.length, 2, "README 里找不到「已知边界」小节");
  const section = parts[1].split(/\n## /)[0];
  assert.ok(!section.includes("全局"), "已知边界又写成全局档位了（实际按会话存）");
  assert.ok(!section.includes("写死"), "已知边界又写成客户端端口写死了（1.2.0 起自动发现）");
  assert.ok(section.includes("43871"), "已知边界应写明端口区间");
});

test("README 写的测试条数跟实际一致", () => {
  const claimed = Number((read("README.md").match(/npm test\s+#.*?(\d+) 项/) || [])[1]);
  assert.ok(Number.isFinite(claimed), "README 测试段没写「N 项」");
  const files = readdirSync(join(root, "test")).filter((f) => f.endsWith(".test.mjs"));
  let actual = 0;
  for (const f of files) {
    const body = read("test", f).replace(/^\s*\/\/.*$/gm, "");
    actual += (body.match(/\btest\(/g) || []).length;
  }
  assert.equal(claimed, actual, `README 写 ${claimed} 项，实际 ${actual} 项`);
});

test("GitHub About 的源：package.json description 必须写「五模式」且列全五种", () => {
  // About 只存在仓库设置里，离线测试碰不到；能守的是它的唯一事实源（description 逐字复制到 About）
  assert.match(pkg.description, /五模式/, "description 还停在旧的「四模式」说法");
  for (const w of ["思考", "循环", "对抗", "检索", "代理"]) {
    assert.ok(pkg.description.includes(w), `description 缺「${w}」`);
  }
});

test("package.json 版本到 3.x：schema 9 是大版本变更", () => {
  assert.match(pkg.version, /^3\./, "v3 起 schema 9 与五模式是同一批口径，版本号要对上");
});

test("发布清单在位，且 release-notes 首节就是当前版本", () => {
  assert.ok(existsSync(join(root, "docs", "release-checklist.md")), "缺少 docs/release-checklist.md");
  const first = read("docs", "release-notes.md").match(/^## (v\d+\.\d+\.\d+)/m);
  assert.ok(first, "release-notes 里找不到版本标题");
  assert.equal(first[1], `v${pkg.version}`, "release-notes 首节版本与 package.json 不一致");
  assert.deepEqual(pkg.files.includes("docs"), true, "files 清单要带 docs，否则 npm 包里没有发布清单");
});

test("思考强度按档位分配：常规 0、严格 2/3/1、极致 3/6/3", () => {
  const counts = (l) => {
    const p = THINK_PLAN[l];
    return [p.probes.length, p.axes.length, p.reverse.length];
  };
  assert.deepEqual(THINK_LEVELS, ["off", "high", "max"]);
  assert.deepEqual(counts("off"), [0, 0, 0], "常规不问、不列轴");
  assert.deepEqual(counts("high"), [2, 3, 1], "严格：2 歧义点 / 3 覆盖轴 / 1 逆向");
  assert.deepEqual(counts("max"), [3, 6, 3], "极致：3 歧义点 / 6 覆盖轴 / 3 逆向");
  assert.equal(THINK_PLAN.off.confirm, 0);
  assert.equal(THINK_PLAN.high.confirm, 2);
  assert.equal(THINK_PLAN.max.confirm, 3);
});

test("循环模式不再短路思考强度：同档位映射，来源标 loop", () => {
  for (const l of THINK_LEVELS) {
    const think = thinkPlan("think", l);
    const loop = thinkPlan("loop", l);
    assert.equal(loop.level, think.level);
    assert.equal(loop.intensity, think.intensity);
    assert.equal(loop.text, think.text);
    assert.equal(think.source, "think");
    assert.equal(loop.source, "loop");
  }
  assert.equal(thinkPlan("loop", "bogus").level, "high", "非法档位落回 high");
  assert.equal(thinkPlan("think", "max").reverse.length, 3, "极致要带三条逆向");
  assert.equal(/不叠加思考档/.exec(read("lib", "tools.js")), null, "工具文案里不许再写「不叠加思考档」");
});
