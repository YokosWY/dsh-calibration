/**
 * dsh-calibration-tier — `agent_delegate`（v3.2.0）
 *
 * 为什么需要它：官方 `subagent` 工具的白名单（allowedModels）在**会话创建时写进
 * session projection，且只写一次**（`recordSubagentModelSelection` 已存在即 return）。
 * 所以「改配置 → 当前会话就能用自配 API」在官方工具上做不到。
 *
 * 但官方那条校验只在「模型显式传了 provider/model」时才生效：
 *   `assertAllowedModelSelection`：`if (policy === undefined || !hasDelegationModelRequest(request)) return;`
 * 我们不在官方工具里传参，而是自己调 `ctx.subagents.startActivation`，把 route 放进
 * `request.agentOptions` —— 走 provider 层，不经过白名单。
 *
 * v3.2.0 新增：
 * - `domain` 直接按领域挑（code/reasoning/writing/longContext/toolUse），不再只能靠 module 映射；
 * - **自配 API 故障兜底**：先用 `llm.resolveCallConfig` 预检；预检或启动失败时自动回退到
 *   官方 deepseek route，并在返回文本里明确提醒「已回退」。
 *
 * 代价（必须写在文档里）：这个工具**绕过宿主 allowedModels**，没有额度护栏。
 */
import { resolveRoutes, pickRoute } from "./agents.js";
import { AGENT_DOMAINS, AGENT_PROFILES, DEFAULT_AGENT, LABELS } from "./core.js";
import { sessionFromExec, turnState, turnIdFromExec, mainRouteFromExec } from "./tools.js";

const DOMAINS = ["code", "reasoning", "writing", "longContext", "toolUse"];
const OFFICIAL_PROVIDER = /^deepseek-/;
const OUTPUT = {
  schema: { type: "object", additionalProperties: true },
  render: (args, value) => [{ type: "text", text: String(value && value.text ? value.text : "") }],
};

function safeGet(ctx, name) {
  try {
    return ctx && typeof ctx.get === "function" ? ctx.get(name) : undefined;
  } catch {
    return undefined;
  }
}

/** 当前会话的代理档位：读轮内快照（点一下下一轮生效），拿不到落默认。 */
export function currentAgent(exec) {
  try {
    const sessionId = sessionFromExec(exec);
    const state = turnState(sessionId, turnIdFromExec(exec));
    const profile = AGENT_PROFILES.includes(state.agent && state.agent.profile)
      ? state.agent.profile
      : DEFAULT_AGENT.profile;
    return { sessionId, on: state.agent.on === true, profile };
  } catch {
    return { sessionId: "default", on: false, profile: DEFAULT_AGENT.profile };
  }
}

/**
 * 预检一条 route：宿主有 `llm.resolveCallConfig` 就用它解析一次（官方 preflight 同款做法）。
 * 它只解析配置与适配器，不产生对话；失败通常意味着 provider 没注册、key 缺失或模型名不对。
 */
async function preflightRoute(ctx, route, signal) {
  const llm = safeGet(ctx, "llm");
  if (!llm || typeof llm.resolveCallConfig !== "function") return { ok: true, skipped: true };
  try {
    await llm.resolveCallConfig(
      {
        provider: route.provider,
        model: route.model,
        ...(route.reasoningEffort ? { reasoningEffort: route.reasoningEffort } : {}),
      },
      signal,
    );
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: String((error && error.message) || error).slice(0, 160) };
  }
}

/** 官方兜底候选：只从 deepseek-* 里挑，按同一领域/档位。 */
function officialFallback(routes, profile, domain, opts) {
  const pool = routes.filter((r) => OFFICIAL_PROVIDER.test(r.provider));
  if (pool.length === 0) return null;
  return pickRoute(pool, "executor", profile, { ...opts, domain });
}

function routeLabel(route) {
  return route ? `${route.provider}/${route.model}` : "(无)";
}

export function registerDelegate(ctx, log) {
  ctx.tools.register({
    name: "agent_delegate",
    description:
      "启动一个独立子代理，并可指定它用哪个模型（不传 provider/model 就按当前「代理」档位与领域自动挑，含用户自配的 API）。与官方 subagent 的区别：本工具把模型放进子代理的 agentOptions、走 provider 层，因此**不受会话 allowedModels 白名单限制**，当前会话立刻可用。**自配 API 出意外时会自动回退到官方 deepseek 模型，并在返回里明确提醒**。参数：prompt（完整自包含任务）、description（一句话标签）、module（executor/review/counter/research）、domain（可选，直接指定 code/reasoning/writing/longContext/toolUse）、provider/model/reasoning_effort（可选，显式指定就按指定来）、cwd（可选）。代价是没有额度护栏，别拿它跑批量。",
    parameters: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "给子代理的完整任务（它看不到本会话上下文，要自包含）" },
        description: { type: "string", description: "一句话标签，显示在子代理列表里" },
        module: {
          type: "string",
          enum: ["executor", "review", "counter", "research"],
          description: "决定用哪个领域的能力分挑模型；省略按 executor",
        },
        domain: {
          type: "string",
          enum: DOMAINS,
          description: "直接指定领域（优先于 module 的映射）",
        },
        backend: {
          type: "string",
          enum: ["spawn", "claude-code", "codex"],
          description:
            "子代理运行时：spawn（默认，可运行时换模型）/ claude-code / codex（后两者用各自 CLI 的配置与登录态，模型不能在这里切）",
        },
        provider: { type: "string", description: "显式指定 provider；与 model 同时给" },
        model: { type: "string", description: "显式指定 model；与 provider 同时给" },
        reasoning_effort: { type: "string", description: "可选推理强度（如 low/medium/high），以适配器支持为准" },
        cwd: { type: "string", description: "子代理初始工作目录；省略继承本会话" },
      },
      required: ["prompt", "description"],
      additionalProperties: false,
    },
    output: OUTPUT,
    execute: async (args, exec) => {
      const subagents = safeGet(ctx, "subagents");
      if (!subagents || typeof subagents.startActivation !== "function") {
        throw new Error("agent_delegate 不可用：宿主没有 subagents 服务（本插件需要 @deepseek-ai/dsh-subagents）");
      }
      const agent = currentAgent(exec);
      const module = args && args.module && AGENT_DOMAINS[args.module] ? String(args.module) : "executor";
      const domain =
        args && args.domain && DOMAINS.includes(args.domain) ? args.domain : AGENT_DOMAINS[module] || "reasoning";
      let backend = args && ["spawn", "claude-code", "codex"].includes(args.backend) ? args.backend : "spawn";
      const main = mainRouteFromExec(exec);
      const pickOpts = { mainProvider: main.provider, mainModel: main.model, domain };
      let effectiveEffort = args && typeof args.reasoning_effort === "string" && args.reasoning_effort ? args.reasoning_effort : "";

      let provider = args && typeof args.provider === "string" ? args.provider.trim() : "";
      let model = args && typeof args.model === "string" ? args.model.trim() : "";
      let source = "explicit";
      let isolation = "none";
      let routes = [];
      let fellBack = false;
      let fallbackNote = "";
      let used = null;

      // claude-code / codex：模型由 CLI 配置决定，这里不选 route（auto 也不跑）
      if (backend !== "spawn") {
        provider = provider || "(cli)";
        model = model || "(cli)";
        source = "backend";
        const resolved = await resolveRoutes(ctx);
        routes = resolved.available ? resolved.routes : [];
      }

      if (!provider || !model) {
        provider = "";
        model = "";
        source = "auto";
        const resolved = await resolveRoutes(ctx);
        if (!resolved.available) {
          throw new Error("agent_delegate 不可用：llm 注册表为空或宿主未暴露 llm 服务（模型自检失败）");
        }
        routes = resolved.routes;
        const picked = pickRoute(routes, module, agent.profile, pickOpts);
        if (!picked) throw new Error("agent_delegate 不可用：这个模块在当前模型清单里挑不到 route");
        used = picked;
        provider = picked.provider;
        model = picked.model;
        isolation = picked.isolation;
        // 自动挑出来的推理等级也要真正生效（v3.2.0 的 bug：只用了用户显式传的）
        if (!effectiveEffort && picked.reasoningEffort) effectiveEffort = picked.reasoningEffort;

        // 自配（非 deepseek-*）先预检；失败先试「去掉推理等级」，再不行才换官方
        if (!OFFICIAL_PROVIDER.test(provider)) {
          let probe = await preflightRoute(ctx, { ...picked, reasoningEffort: effectiveEffort }, exec.signal);
          if (!probe.ok && effectiveEffort && /reasoning.?effort/i.test(probe.reason)) {
            const retry = await preflightRoute(ctx, { ...picked, reasoningEffort: "" }, exec.signal);
            if (retry.ok) {
              effectiveEffort = "";
              probe = { ok: true, skipped: true };
              fallbackNote = `模型 ${routeLabel(picked)} 不支持推理等级，已去掉 reasoning_effort 继续用自配`;
            }
          }
          if (!probe.ok) {
            const off = officialFallback(routes, agent.profile, domain, pickOpts);
            if (off) {
              fellBack = true;
              used = off;
              provider = off.provider;
              model = off.model;
              isolation = "none";
              fallbackNote = `自配 ${routeLabel(picked)} 预检失败（${probe.reason}），已回退到官方 ${routeLabel(off)}`;
            } else {
              fallbackNote = `自配 ${routeLabel(picked)} 预检失败（${probe.reason}），且注册表里没有官方 route 可退`;
            }
          }
        }
      } else {
        // 显式指定：也兜底，但保留原始意图，便于发现配置问题
        const resolved = await resolveRoutes(ctx);
        routes = resolved.available ? resolved.routes : [];
      }

      if (!provider || !model) {
        throw new Error(`agent_delegate 不可用：${fallbackNote || "没有可用的模型 route"}`);
      }

      // 只有 spawn 支持运行时指定模型；claude-code / codex 的模型由各自 CLI 配置决定
      const modelSelectable = backend === "spawn";
      const makeRequest = (route) => ({
        prompt: [{ type: "text", text: String(args.prompt) }],
        parent: exec.agent,
        ...(modelSelectable
          ? {
              agentOptions: {
                provider: route.provider,
                model: route.model,
                ...(effectiveEffort ? { reasoningEffort: effectiveEffort } : {}),
              },
            }
          : {}),
        ...(args && typeof args.cwd === "string" && args.cwd ? { cwd: args.cwd } : {}),
      });

      const startWith = async (route, providerName = backend) =>
        subagents.startActivation({
          provider: providerName,
          label: String(args.description || "delegate"),
          request: makeRequest(route),
          signal: exec.signal,
          delivery: "parent",
        });

      let started;
      try {
        started = await startWith({ provider, model });
      } catch (error) {
        const firstReason = String((error && error.message) || error).slice(0, 160);
        if (backend !== "spawn") {
          // CLI 后端起不来（没登录/版本不对）→ 回退到 spawn + 官方模型
          const off = officialFallback(routes, agent.profile, domain, pickOpts);
          if (!off) throw error;
          started = await startWith(off, "spawn");
          backend = "spawn";
          fellBack = true;
          provider = off.provider;
          model = off.model;
          fallbackNote = `${backend} 后端启动失败（${firstReason}），已回退到 spawn + 官方 ${routeLabel(off)}`;
        } else {
          const off = officialFallback(routes, agent.profile, domain, pickOpts);
          if (!off || OFFICIAL_PROVIDER.test(provider)) throw error;
          started = await startWith(off);
          fellBack = true;
          provider = off.provider;
          model = off.model;
          isolation = "none";
          fallbackNote = `自配 ${routeLabel(used || { provider, model })} 启动失败（${firstReason}），已回退到官方 ${routeLabel(off)}`;
        }
      }

      const childId = started && (started.childId || started.id);
      const profileLabel = LABELS.agent[agent.profile] || agent.profile;
      const head = fellBack ? "⚠️ 已回退" : "已启动子代理";
      const backendNote = modelSelectable ? "" : `${backend} 后端不接运行时模型参数，模型由该 CLI 的配置决定；`;
      return {
        subagentId: childId || null,
        provider,
        model,
        backend,
        module,
        domain,
        profile: agent.profile,
        source,
        isolation,
        fellBack,
        ...(fallbackNote ? { note: fallbackNote } : {}),
        text: `${head} ${childId || "(未知 id)"}：${modelSelectable ? `${provider}/${model}` : `${backend}（CLI 配置模型）`}（${source === "auto" && modelSelectable ? `${profileLabel}档 · ${domain}域自动选` : "手动指定"}${isolation !== "none" && modelSelectable ? ` · 隔离${isolation}` : ""}）。${backendNote}${fallbackNote ? fallbackNote + "。" : ""}结果会异步回到本会话。`,
      };
    },
  });
  log("agent_delegate 工具已注册（绕过 allowedModels，走 provider 层；自配故障自动回退官方）");
}
