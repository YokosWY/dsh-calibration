// 模型路由与 verify_claims 的纯函数测试（v3.0.0）
// 依赖 DSH_HOME：在 import 之前指到临时目录，避免读写真实凭据/状态。
import test from "node:test";
import assert from "node:assert";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "ct-routing-"));
process.env.DSH_HOME = home;
mkdirSync(join(home, "storages"), { recursive: true });

const agents = await import("../lib/agents.js");
const verify = await import("../lib/verify.js");

const ROUTES = [
  agents.scoreRoute("yokos-cc", "claude-opus-5-5"),
  agents.scoreRoute("yokos-cc", "claude-sonnet-5-5"),
  agents.scoreRoute("deepseek-account", "deepseek-flash"),
  agents.scoreRoute("yokos-grok", "grok-4.7"),
];

test("能力族：按名字匹配基线，未知族给 5 分并标 unknown", () => {
  assert.equal(agents.familyOf("claude-opus-5-5").reasoning, 10);
  assert.equal(agents.familyOf("claude-sonnet-5-5").reasoning, 8);
  assert.equal(agents.familyOf("deepseek-flash").tier, "low");
  const unknown = agents.familyOf("mystery-model-9");
  assert.equal(unknown.reasoning, 5);
  assert.equal(unknown.tier, "unknown");
  assert.equal(unknown.match, null);
});

test("scoreRoute：同族不同 provider 都能打分，contextWindow 可覆盖", () => {
  const a = agents.scoreRoute("p1", "claude-opus-5-5");
  assert.equal(a.provider, "p1");
  assert.equal(a.score.reasoning, 10);
  assert.equal(a.overridden, false);
  const b = agents.scoreRoute("p1", "claude-opus-5-5", { "p1/claude-opus-5-5": { reasoning: 6, contextWindow: 999 } });
  assert.equal(b.score.reasoning, 6, "用户覆盖优先于基线");
  assert.equal(b.overridden, true);
  assert.equal(b.contextWindow, 999, "覆盖可带上下文窗口");
});

test("指纹：排序稳定，注册表变化即变", () => {
  const f1 = agents.fingerprintOf(ROUTES);
  const f2 = agents.fingerprintOf([...ROUTES].reverse());
  assert.equal(f1, f2, "顺序不影响指纹");
  const f3 = agents.fingerprintOf([...ROUTES, agents.scoreRoute("x", "gpt-9")]);
  assert.notEqual(f1, f3);
  assert.equal(f1.length, 12);
});

test("免费线名单可配：models.json 的 providers 覆盖内置默认（不用改代码）", () => {
  const file = join(home, "storages", "calibration-models.json");
  assert.equal(agents.readFreeLines().has("buddy"), true, "内置名单默认含 buddy");

  writeFileSync(file, JSON.stringify({ providers: { buddy: false, "my-free-channel": true } }));
  const set = agents.readFreeLines();
  assert.equal(set.has("buddy"), false, "providers 里 false 可摘掉内置项");
  assert.equal(set.has("my-free-channel"), true, "providers 里 true 可加新渠道");
  assert.equal(agents.scoreRoute("buddy", "deepseek-v4-flash").free, false, "scoreRoute 跟着名单走");
  assert.equal(agents.scoreRoute("my-free-channel", "deepseek-v4-flash").free, true);

  rmSync(file);
  assert.equal(agents.readFreeLines().has("buddy"), true, "删掉配置即回到内置默认");
});

test("免费线只做同分降权：官方/自配同分时优先，手动点名与 free 覆盖都照旧", () => {
  // 实测坑：buddy/deepseek-v4-flash 与 deepseek-account/deepseek-v4-flash 同族同分，
  // 原来按 provider 名序 → "buddy" 排前 → 挑到免费线，运行期静默失败
  const free = agents.scoreRoute("buddy", "deepseek-v4-flash");
  const paid = agents.scoreRoute("deepseek-account", "deepseek-v4-flash");
  assert.equal(free.free, true, "免费线要打标记");
  assert.equal(paid.free, false);
  const picked = agents.pickRoute([free, paid], "executor", "efficiency");
  assert.equal(picked.provider, "deepseek-account", "同分优先非免费线");

  // 能力分更高时免费线照样能选中（不是无条件封杀）
  const strongFree = agents.scoreRoute("buddy", "claude-opus-5-5");
  const weakPaid = agents.scoreRoute("deepseek-account", "deepseek-flash");
  assert.equal(agents.pickRoute([strongFree, weakPaid], "review", "performance").provider, "buddy");

  // 单条覆盖：明确标 free:false 就不再降权（名称序回到 tie-break）
  const opted = agents.scoreRoute("buddy", "deepseek-v4-flash", { "buddy/deepseek-v4-flash": { free: false } });
  assert.equal(opted.free, false, "覆盖优先于默认名单");
});

test("挑 route：性能档取领域分最高，效率档只在 low/mid 里挑", () => {
  const perf = agents.pickRoute(ROUTES, "review", "performance");
  assert.equal(perf.model, "claude-opus-5-5", "reasoning 10 分最高");
  assert.equal(perf.reasoningEffort, undefined, "模型没声明 efforts 就不传（传了会被适配器拒）");

  const eff = agents.pickRoute(ROUTES, "review", "efficiency");
  assert.notEqual(eff.model, "claude-opus-5-5", "效率档不挑 high tier");
  assert.ok(["low", "mid"].includes(eff.tier), `效率档挑到了 ${eff.tier}`);
});

test("推理等级：模型声明了 efforts 才传，性能取最高、效率取默认", () => {
  const base = agents.scoreRoute("p-eff", "claude-opus-5-5");
  const withEfforts = {
    ...base,
    tier: "mid",
    efforts: [
      { id: "low", name: "low", default: false },
      { id: "medium", name: "medium", default: true },
      { id: "high", name: "high", default: false },
    ],
  };
  assert.equal(agents.pickRoute([withEfforts], "review", "performance").reasoningEffort, "high");
  assert.equal(agents.pickRoute([withEfforts], "review", "efficiency").reasoningEffort, "medium", "效率档取默认档");
  const none = { ...base, tier: "mid", efforts: [] };
  assert.equal(agents.pickRoute([none], "review", "efficiency").reasoningEffort, undefined);
});

test("对抗：必须避开主模型 provider；只能同 provider 时降级为中/低", () => {
  const isolated = agents.pickRoute(ROUTES, "counter", "performance", {
    mainProvider: "deepseek-account",
    mainModel: "deepseek-flash",
  });
  assert.notEqual(isolated.provider, "deepseek-account");
  assert.equal(isolated.isolation, "high");

  const sameProvider = agents.pickRoute(
    [agents.scoreRoute("deepseek-account", "deepseek-flash"), agents.scoreRoute("deepseek-account", "deepseek-v4-pro")],
    "counter",
    "performance",
    { mainProvider: "deepseek-account", mainModel: "deepseek-flash" },
  );
  assert.equal(sameProvider.provider, "deepseek-account");
  assert.equal(sameProvider.isolation, "mid", "同 provider 但换 model → 中");
});

test("对抗：拿不到主模型 provider 时不假装隔离，标 unknown", () => {
  const r = agents.pickRoute(ROUTES, "counter", "performance");
  assert.equal(r.isolation, "unknown", "未知主模型不能报 high");
  assert.ok(r.provider && r.model);
});

test("planRoutes：性能档带效率档回退（三级回退前两级），效率档自身不带", () => {
  const perf = agents.planRoutes(ROUTES, "performance");
  assert.ok(perf.fallback, "性能档必须给回退");
  assert.equal(perf.fallback.profile, "efficiency");
  assert.equal(perf.fallback.label, "效率");
  assert.deepEqual(Object.keys(perf.fallback.modules).sort(), ["counter", "executor", "research", "review"]);
  assert.ok(perf.fallback.modules.review, "回退档也要有 review route");

  const eff = agents.planRoutes(ROUTES, "efficiency");
  assert.equal(eff.fallback, undefined, "效率档没有更低一档可退");
});

test("agentSection：把回退链与 planId 一起透给模型", async () => {
  const mod = await import("../lib/tools.js");
  agents.invalidateRoutes();
  const fakeCtx = {
    get: () => ({
      listProviders: () => [{ id: "p-a" }, { id: "p-b" }],
      listModels: async (id) =>
        id === "p-a"
          ? [{ id: "claude-opus-5-5", contextWindow: 1000000 }]
          : [{ id: "deepseek-flash", contextWindow: 128000 }],
    }),
  };
  const out = await mod.agentSection(
    fakeCtx,
    { mode: "think", session: "s-x", turnId: "9", agent: { on: true, profile: "performance" }, exec: {} },
    { enabled: true },
    { on: false, plan: null },
  );
  assert.equal(out.agent.on, true);
  assert.match(out.agent.planId, /^[0-9a-f]{8}$/);
  assert.ok(out.agent.modules.executor || out.agent.modules.counter, "至少要给出一个模块");
  assert.ok(out.agent.fallback, "性能档要带 fallback");
  assert.ok(out.text.includes("回退"), out.text);
  assert.ok(out.text.includes("planId="), out.text);
});

test("planRoutes：四模块齐全，挑不到时该模块为 null", () => {
  const plan = agents.planRoutes(ROUTES, "performance");
  assert.deepEqual(Object.keys(plan.modules).sort(), ["counter", "executor", "research", "review"]);
  assert.equal(plan.maxChildren, 3);
  assert.ok(plan.text.includes("性能档"));
  const empty = agents.planRoutes([], "performance");
  assert.equal(empty.available, false);
  assert.equal(empty.modules.executor, null);
});

test("allowedRoutes：两档合并去重", () => {
  const list = agents.allowedRoutes(ROUTES);
  assert.ok(list.length >= 2);
  const keys = list.map((r) => `${r.provider}/${r.model}`);
  assert.equal(new Set(keys).size, keys.length, "不许重复");
});

test("resolveRoutes：宿主没有 llm 服务时返回 available:false，不抛", async () => {
  agents.invalidateRoutes(); // 前面 agentSection 用例写过缓存，先清掉
  const res = await agents.resolveRoutes({});
  assert.equal(res.available, false);
  assert.equal(res.error, "llm-unavailable");
});

test("resolveRoutes：有 llm 时枚举并写指纹；listModels 抛错只跳过该 provider", async () => {
  agents.invalidateRoutes();
  const fake = {
    get() {
      return {
        listProviders: () => [{ id: "p-ok" }, { id: "p-bad" }],
        listModels: async (id) => {
          if (id === "p-bad") throw new Error("boom");
          return [{ id: "claude-opus-5-5", contextWindow: 1000000 }];
        },
      };
    },
  };
  const res = await agents.resolveRoutes(fake);
  assert.equal(res.available, true);
  assert.equal(res.routes.length, 1);
  assert.equal(res.routes[0].contextWindow, 1000000);
  assert.equal(res.fingerprint.length, 12);
});

test("域名分级：官方/学术/媒体/其余", () => {
  assert.equal(verify.domainTier("docs.python.org"), "L1");
  assert.equal(verify.domainTier("www.nature.com"), "L2");
  assert.equal(verify.domainTier("reuters.com"), "L3");
  assert.equal(verify.domainTier("some-blog.example"), "L4");
});

test("锚点：优先数字，其次引号短语，都没有取前 24 字", () => {
  assert.deepEqual(verify.anchorsOf("退化率 3.2% 与 12 个样本"), ["3.2%", "12"]);
  assert.deepEqual(verify.anchorsOf("他说「不要编数据」"), ["不要编数据"]);
  assert.equal(verify.anchorsOf("一句话断言").length, 1);
});

test("verifyOne：文件命中、行号越界、锚点不匹配、越界路径", () => {
  const root = mkdtempSync(join(tmpdir(), "ct-verify-"));
  writeFileSync(join(root, "a.md"), "第一行\n退化率 3.2%\n第三行\n", "utf8");
  const hit = verify.verifyOne({ text: "退化率 3.2%", source: { kind: "file", path: "a.md", line: 2 } }, root);
  assert.equal(hit.ok, true);
  assert.equal(hit.level, "file-verified");

  const badLine = verify.verifyOne({ text: "退化率 3.2%", source: { kind: "file", path: "a.md", line: 99 } }, root);
  assert.equal(badLine.ok, false);
  assert.match(badLine.reasons[0], /行号超出范围/);

  const miss = verify.verifyOne({ text: "退化率 9.9%", source: { kind: "file", path: "a.md", line: 2 } }, root);
  assert.equal(miss.ok, false);
  assert.match(miss.reasons[0], /找不到锚点/);

  const outside = verify.verifyOne({ text: "x", source: { kind: "file", path: "../../etc/passwd" } }, root);
  assert.equal(outside.ok, false);
  assert.equal(outside.reasons[0], "outside-workspace");
});

test("verifyOne：URL 只验语法与分级，命令只标 weak", () => {
  const url = verify.verifyOne({ text: "x", source: { kind: "url", url: "https://docs.python.org/3/" } }, process.cwd());
  assert.equal(url.ok, true);
  assert.equal(url.level, "url-L1");

  const badUrl = verify.verifyOne({ text: "x", source: { kind: "url", url: "not a url" } }, process.cwd());
  assert.equal(badUrl.ok, false);

  const cmd = verify.verifyOne({ text: "x", source: { kind: "command", snippet: "# pass 86" } }, process.cwd());
  assert.equal(cmd.ok, null);
  assert.equal(cmd.level, "weak");

  const placeholder = verify.verifyOne({ text: "x", source: { kind: "command", snippet: "TODO ..." } }, process.cwd());
  assert.equal(placeholder.ok, false);
  assert.equal(placeholder.level, "weak");
});

test("verifyClaims：批量计数与逐条结果", () => {
  const root = mkdtempSync(join(tmpdir(), "ct-verify2-"));
  writeFileSync(join(root, "b.md"), "node 22 以上\n", "utf8");
  const rep = verify.verifyClaims(
    [
      { text: "node 22", source: { kind: "file", path: "b.md", line: 1 } },
      { text: "node 99", source: { kind: "file", path: "b.md", line: 1 } },
      { text: "x", source: { kind: "command", snippet: "# ok" } },
    ],
    root,
  );
  assert.equal(rep.total, 3);
  assert.equal(rep.counts.ok, 1);
  assert.equal(rep.counts.missing, 1);
  assert.equal(rep.counts.weak, 1);
});
