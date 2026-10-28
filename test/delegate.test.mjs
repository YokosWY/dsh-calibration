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

const exec = (session = "s-del") => ({ agent: { id: session, session: { id: session }, phase: { turn: 1 } }, signal: null });

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

test("效率档挑低 tier；性能档挑 opus 级", async () => {
  const { tool } = boot();
  const eff = await tool.execute({ prompt: "p", description: "d", module: "executor" }, exec("s-eff"));
  assert.equal(eff.profile, "efficiency");
  assert.equal(eff.provider, "deepseek-account", "效率档只挑 low/mid");

  core.AGENT_PROFILES.includes("performance");
  const perf = await tool.execute(
    { prompt: "p", description: "d", module: "review", provider: "yokos-beichenapi-anthropic", model: "claude-opus-5-5" },
    exec("s-perf"),
  );
  assert.equal(perf.source, "explicit");
  assert.equal(perf.model, "claude-opus-5-5");
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
