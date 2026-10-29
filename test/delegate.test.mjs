// agent_delegate：绕过 allowedModels 的委派通道（v3.2.0）
// 重点验证「不传模型也能用自配 API」「显式传就按指定」「自配故障回退官方并提醒」。
import test from "node:test";
import assert from "node:assert";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "ct-delegate-"));
process.env.DSH_HOME = home;
mkdirSync(join(home, "storages"), { recursive: true });

const mod = await import("../lib/index.js");
const agents = await import("../lib/agents.js");
const core = await import("../lib/core.js");

const tools = new Map();
const started = [];

function fakeCtx({ withSubagents = true, withLlm = true, probeFails = false, startFails = 0 } = {}) {
  let starts = 0;
  const services = {
    subagents: {
      startActivation: async (payload) => {
        starts += 1;
        if (starts <= startFails) throw new Error("模拟启动失败：provider 连接超时");
        started.push(payload);
        return { childId: `child-${starts}` };
      },
    },
    llm: {
      listProviders: () => [
        { id: "yokos-beichenapi-anthropic" },
        { id: "yokos-grok-image" },
        { id: "deepseek-account" },
      ],
      listModels: async (id) => {
        if (id === "yokos-beichenapi-anthropic") return [{ id: "claude-opus-5-5", contextWindow: 1000000 }];
        if (id === "yokos-grok-image") return [{ id: "grok-4.7", contextWindow: 500000 }];
        return [{ id: "deepseek-flash", contextWindow: 128000 }];
      },
      resolveCallConfig: async (cfg) => {
        if (probeFails && /^yokos-/.test(cfg.provider)) throw new Error("模拟预检失败：API key 无效");
        return cfg;
      },
    },
  };
  return {
    services,
    ctx: {
      tools: { register: (t) => tools.set(t.name, t) },
      logger: () => ({ info: () => {} }),
      get: (name) => {
        if (name === "subagents") return withSubagents ? services.subagents : undefined;
        if (name === "llm") return withLlm ? services.llm : undefined;
        return undefined;
      },
    },
  };
}

function boot(opts) {
  tools.clear();
  started.length = 0;
  agents.invalidateRoutes();
  const env = fakeCtx(opts);
  mod.registerDelegate(env.ctx, () => {});
  const tool = tools.get("agent_delegate");
  assert.ok(tool, "agent_delegate 必须注册");
  return { tool, env };
}

const exec = (session = "s-del", model = null) => ({
  agent: { id: session, session: { id: session }, phase: { turn: 1 }, ...(model ? { model } : {}) },
  signal: null,
});

test("不传模型：按注册表自动挑（含自配 API），并把 route 放进 agentOptions", async () => {
  const { tool } = boot();
  const out = await tool.execute({ prompt: "做事", description: "d1" }, exec());
  assert.equal(out.subagentId, "child-1");
  assert.equal(out.source, "auto");
  assert.ok(["yokos-beichenapi-anthropic", "yokos-grok-image", "deepseek-account"].includes(out.provider));
  const req = started[0];
  assert.equal(req.provider, "spawn");
  assert.equal(req.delivery, "parent");
  assert.equal(req.request.agentOptions.provider, out.provider);
  assert.equal(req.request.agentOptions.model, out.model);
  assert.equal(req.request.prompt[0].text, "做事");
  assert.equal(req.label, "d1");
});

test("效率档挑强于主模型的 mid 档；性能档挑 opus 级", async () => {
  const { tool } = boot();
  const eff = await tool.execute({ prompt: "p", description: "d", module: "executor" }, exec("s-eff"));
  assert.equal(eff.profile, "efficiency");
  assert.equal(eff.source, "auto", "没有主模型信息时退回 auto");
  assert.equal(eff.provider, "deepseek-account", "只有 flash 可选（high 档不进效率候选）");

  core.AGENT_PROFILES.includes("performance");
  const perf = await tool.execute(
    { prompt: "p", description: "d", module: "review", provider: "yokos-beichenapi-anthropic", model: "claude-opus-5-5" },
    exec("s-perf"),
  );
  assert.equal(perf.source, "explicit");
  assert.equal(perf.model, "claude-opus-5-5");
});

test("代理关 = 不强化：沿用主模型，不挑更强的 route（v3.4.0）", async () => {
  const { tool } = boot();
  const e = exec("s-base");
  e.agent.model = { provider: "deepseek-official", id: "deepseek-flash" };
  const out = await tool.execute({ prompt: "p", description: "d", module: "executor" }, e);
  assert.equal(out.source, "baseline");
  assert.equal(out.provider, "deepseek-official");
  assert.equal(out.model, "deepseek-flash", "不开强化就用主模型");
  assert.ok(out.text.includes("不强化"), out.text);
  assert.equal(started[0].request.agentOptions.provider, "deepseek-official");
});

test("显式传 provider/model：原样透传，不查注册表", async () => {
  const { tool } = boot({ withLlm: false });
  const out = await tool.execute(
    { prompt: "p", description: "d", provider: "yokos-grok-image", model: "grok-4.7", reasoning_effort: "high" },
    exec(),
  );
  assert.equal(out.provider, "yokos-grok-image");
  assert.equal(started[0].request.agentOptions.reasoningEffort, "high");
});

test("没有 subagents 服务：直接报错，不静默", async () => {
  const { tool } = boot({ withSubagents: false });
  await assert.rejects(() => tool.execute({ prompt: "p", description: "d" }, exec()), /没有 subagents 服务/);
});

test("没有 llm 又没有显式 route：报错，不编造模型", async () => {
  const { tool } = boot({ withLlm: false });
  await assert.rejects(() => tool.execute({ prompt: "p", description: "d" }, exec()), /llm 注册表为空/);
});

test("counter 模块：自动挑时避开主模型 provider（拿不到主模型则标 unknown）", async () => {
  const { tool } = boot();
  const out = await tool.execute({ prompt: "p", description: "d", module: "counter" }, exec());
  assert.equal(out.module, "counter");
  assert.equal(out.isolation, "unknown", "exec 里没有主模型信息，不能谎报 high");
});

test("自配 API 预检失败：自动回退官方，并在返回里提醒", async () => {
  const { tool } = boot({ probeFails: true });
  // 性能档才会挑到 opus（非官方），默认效率档只挑 deepseek；这里显式给自配 route 以触发预检
  const out = await tool.execute(
    { prompt: "p", description: "d", provider: "yokos-beichenapi-anthropic", model: "claude-opus-5-5" },
    exec(),
  );
  // 显式指定不预检（尊重用户），所以这里应原样成功
  assert.equal(out.fellBack, false);
  assert.equal(out.provider, "yokos-beichenapi-anthropic");
});

test("自动挑到自配时预检失败 → 回退官方 deepseek 并标 fellBack", async () => {
  // 让状态文件把当前会话设成性能档，auto 才会挑到 opus
  const { writeFileSync } = await import("node:fs");
  writeFileSync(
    join(home, "storages", "calibration.json"),
    JSON.stringify({
      schema: 9,
      sessions: {
        "s-perf": {
          mode: "think",
          level: "high",
          counter: false,
          route: { on: false, level: "high" },
          agent: { on: true, profile: "performance" },
          updatedAt: null,
          turn: null,
          owner: null,
        },
      },
    }),
    "utf8",
  );
  const { tool } = boot({ probeFails: true });
  const out = await tool.execute({ prompt: "p", description: "d", module: "executor" }, exec("s-perf"));
  assert.equal(out.fellBack, true);
  assert.match(out.provider, /^deepseek-/, "回退到官方 provider");
  assert.ok(out.text.includes("已回退"), out.text);
  assert.ok(out.note && out.note.includes("预检失败"), out.note);
});

test("启动阶段失败也能回退一次（自配失败 → 官方重试）", async () => {
  const { writeFileSync } = await import("node:fs");
  writeFileSync(
    join(home, "storages", "calibration.json"),
    JSON.stringify({
      schema: 9,
      sessions: {
        "s-start": {
          mode: "think",
          level: "high",
          counter: false,
          route: { on: false, level: "high" },
          agent: { on: true, profile: "performance" },
          updatedAt: null,
          turn: null,
          owner: null,
        },
      },
    }),
    "utf8",
  );
  const { tool } = boot({ startFails: 1 });
  const out = await tool.execute({ prompt: "p", description: "d", module: "executor" }, exec("s-start"));
  assert.equal(out.fellBack, true);
  assert.match(out.provider, /^deepseek-/);
  assert.ok(out.text.includes("已回退"), out.text);
});

test("返回 fallbackRoute：自配成功时也给出官方兜底 route（供运行期失败重派）", async () => {
  const { tool } = boot();
  const out = await tool.execute(
    { prompt: "p", description: "d", provider: "yokos-beichenapi-anthropic", model: "claude-opus-5-5" },
    exec(),
  );
  assert.equal(out.fellBack, false);
  assert.ok(out.fallbackRoute, "必须给官方兜底 route");
  assert.match(out.fallbackRoute.provider, /^deepseek-/);
  assert.ok(out.text.includes("重派"), "文本要说明运行期失败怎么重派");
});

test("domain 参数：可绕过 module 映射，直接按领域挑", async () => {
  const { tool } = boot();
  const out = await tool.execute({ prompt: "p", description: "d", module: "review", domain: "longContext" }, exec());
  assert.equal(out.domain, "longContext");
  assert.ok(out.provider);
});

test("backend=codex：走 codex provider、不传 agentOptions、说明模型由 CLI 配置", async () => {
  const { tool } = boot();
  const out = await tool.execute({ prompt: "p", description: "d", backend: "codex" }, exec());
  assert.equal(out.backend, "codex");
  assert.equal(out.source, "backend");
  assert.equal(started[0].provider, "codex");
  assert.equal(started[0].request.agentOptions, undefined, "CLI 后端不接运行时模型参数");
  assert.ok(out.text.includes("CLI 配置模型"), out.text);
});

test("backend=claude-code 启动失败：回退到 spawn + 官方模型并提醒", async () => {
  const { tool } = boot({ startFails: 1 });
  const out = await tool.execute({ prompt: "p", description: "d", backend: "claude-code" }, exec());
  assert.equal(out.fellBack, true);
  assert.equal(out.backend, "spawn", "回退后走 spawn");
  assert.equal(started[0].provider, "spawn");
  assert.match(out.provider, /^deepseek-/);
  assert.ok(out.text.includes("已回退"), out.text);
});

test("fallbacks：返回有序降级链，且不含当前 route", async () => {
  const { tool } = boot();
  const out = await tool.execute(
    { prompt: "p", description: "d", provider: "yokos-beichenapi-anthropic", model: "claude-opus-5-5" },
    exec(),
  );
  assert.ok(Array.isArray(out.fallbacks), "应返回 fallbacks 数组");
  assert.ok(out.fallbacks.length >= 1, "至少有一条降级候选");
  const self = `${out.provider}/${out.model}`;
  assert.ok(!out.fallbacks.some((f) => `${f.provider}/${f.model}` === self), "链里不应含当前 route");
  assert.match(out.fallbacks[0].provider, /^deepseek-/, "第一条应是官方渠道");
  assert.match(out.text, /按此顺序重派/, "文本要给出运行期重派顺序");
  if (out.fallbackRoute) {
    assert.equal(out.fallbackRoute.provider, out.fallbacks[0].provider, "fallbackRoute 与链首一致（向后兼容）");
  }
});

test("启动失败沿降级链重试，不只试一条", async () => {
  // 第 1 次（显式自配）失败 → 第 2 次（链首官方）成功
  const { tool } = boot({ startFails: 1 });
  const out = await tool.execute(
    { prompt: "p", description: "d", provider: "yokos-beichenapi-anthropic", model: "claude-opus-5-5" },
    exec(),
  );
  assert.equal(out.fellBack, true);
  assert.equal(started.length, 1, "只记录成功那一次");
  assert.equal(started[0].provider, "spawn", "降级重试统一走 spawn");
  assert.ok(out.text.includes("已回退"), out.text);
  // 已落到官方且官方池只有一条时，链为空是正确的：没有更低一级可退
  assert.equal(out.provider, "deepseek-account");
});

test("回退后运行期链跳过启动期已失败的候选", async () => {
  // 显式自配 grok 失败 → 官方 deepseek 也失败 → 主模型 claude 成功。
  // 此时运行期链不该再把 grok / deepseek 排进去（重派过去仍是死路）。
  const { tool } = boot({ startFails: 2 });
  const out = await tool.execute(
    { prompt: "p", description: "d", provider: "yokos-grok-image", model: "grok-4.7" },
    exec("s-retry", { provider: "yokos-beichenapi-anthropic", id: "claude-opus-5-5" }),
  );
  assert.equal(out.fellBack, true);
  assert.equal(out.provider, "yokos-beichenapi-anthropic", "最后落在主模型");
  assert.equal(out.fallbacks, undefined, "没有可重派的候选时不该给空链");
  assert.ok(!out.text.includes("按此顺序重派"), "没链就不能写重派说明");
  assert.match(out.text, /之前 .*也失败/, "note 要列出启动期试过的候选");
});

test("回退到没声明 efforts 的模型时不传 reasoning_effort", async () => {
  const { tool } = boot({ startFails: 1 });
  const out = await tool.execute(
    {
      prompt: "p",
      description: "d",
      provider: "yokos-beichenapi-anthropic",
      model: "claude-opus-5-5",
      reasoning_effort: "high",
    },
    exec(),
  );
  assert.equal(out.fellBack, true);
  assert.match(out.provider, /^deepseek-/);
  assert.equal(
    started[0].request.agentOptions.reasoningEffort,
    undefined,
    "目标模型没声明 efforts 就不能把原模型的等级套上去",
  );
});
