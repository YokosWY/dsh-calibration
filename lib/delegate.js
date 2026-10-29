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
import { resolveRoutes, pickRoute, nearPeers } from "./agents.js";
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

/**
 * 池内兜底：只认传进来的那份候选。
 * 坑：`pickRoute` 走效率档时，池里挑不到「比基线更强」的会退回基线 route（主模型），
 * 于是池子明明是官方池，拿回来的却是自配/主模型 —— 降级链会把它当成「官方第一跳」。
 */
function inPool(picked, pool) {
  if (!picked) return pool[0] || null;
  const hit = pool.find((r) => r.provider === picked.provider && r.model === picked.model);
  return hit || pool[0] || null;
}

/** 官方兜底候选：只从 deepseek-* 里挑，按同一领域/档位。 */
function officialFallback(routes, profile, domain, opts) {
  const pool = routes.filter((r) => OFFICIAL_PROVIDER.test(r.provider));
  if (pool.length === 0) return null;
  return inPool(pickRoute(pool, "executor", profile, { ...opts, domain }), pool);
}

/**
 * 降级链（v3.7.0）：启动期与运行期共用同一份有序候选。
 *
 * 顺序：性能档同级次优（非官方，如 opus → sonnet）→ 官方同域同档 → 官方放宽（不限域/档位）
 * → 主模型。同级次优只对性能档生效：效率档本来就在挑「够用且便宜」，再插同质备选
 * 等于偷偷升级，故不插。
 * 去重，排除当前已选 route 与 `skip`（启动期已经失败过的 provider/model）；
 * 返回 `[{provider, model, route?}]`，route 可能为 null（主模型没走注册表时
 * 只给 provider/model，够 startActivation 用）。
 */
function buildFallbackChain(routes, profile, domain, pickOpts, current, skip, module = "executor") {
  const out = [];
  const seen = new Set();
  if (current && current.provider && current.model) seen.add(`${current.provider}/${current.model}`);
  for (const key of skip || []) if (key) seen.add(String(key));
  const push = (provider, model, route) => {
    if (!provider || !model) return;
    const key = `${provider}/${model}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ provider, model, route: route || null });
  };
  // 0) 性能档同级次优：opus 限流/不可用时先退 sonnet，而不是直接掉到官方效率档
  if (profile === "performance") {
    for (const peer of nearPeers(routes, module, profile, { ...pickOpts }, { current, skip, limit: 2 })) {
      if (OFFICIAL_PROVIDER.test(peer.provider)) continue;
      push(peer.provider, peer.model, peer);
    }
  }
  // 1) 官方同域同档
  const same = officialFallback(routes, profile, domain, pickOpts);
  if (same) push(same.provider, same.model, same);
  // 2) 官方放宽：还在官方池里，但不再要求域/档位匹配
  const pool = routes.filter((r) => OFFICIAL_PROVIDER.test(r.provider));
  if (pool.length > 0) {
    const loose = inPool(pickRoute(pool, "executor", profile, { ...pickOpts }), pool);
    if (loose) push(loose.provider, loose.model, loose);
  }
  // 3) 主模型：注册表里能找到就带 route，找不到只给标识
  if (pickOpts.mainProvider && pickOpts.mainModel) {
    const main = routes.find((r) => r.provider === pickOpts.mainProvider && r.model === pickOpts.mainModel);
    push(pickOpts.mainProvider, pickOpts.mainModel, main || null);
  }
  return out;
}

/**
 * 推理等级跟着候选走（v3.2.1 的口径：只在模型自己声明了 efforts 时才传）。
 * 回退换模型时，原模型的等级不能直接套过去——目标没声明就清空，声明了但
 * 当前值不在列表里就改用它的默认档。
 * @param {{route?: object|null}} cand buildFallbackChain 的一项
 * @param {string} preferred 原定等级（可能为空）
 */
function effortFor(cand, preferred) {
  const list = Array.isArray(cand && cand.route && cand.route.efforts)
    ? cand.route.efforts.filter((e) => e && e.id)
    : [];
  if (list.length === 0) return "";
  if (preferred && list.some((e) => e.id === preferred)) return preferred;
  const def = list.find((e) => e.default);
  return def ? def.id : list[0].id;
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

      // 代理开关关 = 不强化（v3.4.0）：沿用主模型，不挑更强的 route；主模型未知才退回 auto
      let baselineNote = "";
      if (!provider && !model && !agent.on) {
        if (main.provider && main.model) {
          provider = main.provider;
          model = main.model;
          source = "baseline";
          baselineNote = "代理关：不强化，沿用主模型";
          const resolved = await resolveRoutes(ctx);
          routes = resolved.available ? resolved.routes : [];
        } else {
          baselineNote = "代理关且主模型未知：按效率档挑";
        }
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
            // 性能档先退同级次优（opus 预检挂了先试 sonnet），没有同级才退官方
            const peer =
              agent.profile === "performance"
                ? nearPeers(routes, module, agent.profile, pickOpts, { current: picked, limit: 1 }).find(
                    (r) => !OFFICIAL_PROVIDER.test(r.provider),
                  )
                : undefined;
            const alt = peer || officialFallback(routes, agent.profile, domain, pickOpts);
            if (alt) {
              if (peer && effectiveEffort) effectiveEffort = effortFor({ route: peer }, effectiveEffort);
              fellBack = true;
              used = alt;
              provider = alt.provider;
              model = alt.model;
              isolation = "none";
              fallbackNote = peer
                ? `自配 ${routeLabel(picked)} 预检失败（${probe.reason}），已回退到同级 ${routeLabel(alt)}`
                : `自配 ${routeLabel(picked)} 预检失败（${probe.reason}），已回退到官方 ${routeLabel(alt)}`;
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
      let failedAtStart = null;
      try {
        started = await startWith({ provider, model });
      } catch (error) {
        const firstReason = String((error && error.message) || error).slice(0, 160);
        // 启动失败沿降级链逐条重试：官方同档 → 官方放宽 → 主模型。
        // 统一落回 spawn——CLI 后端起不来时，换模型也救不了同一个 CLI。
        // 起不来的候选记进 failedAtStart：运行期那条链不再重复给它们。
        const chain = buildFallbackChain(routes, agent.profile, domain, pickOpts, { provider, model }, null, module);
        if (chain.length === 0) throw error;
        failedAtStart = new Set([`${provider}/${model}`]);
        const tried = [];
        const preferredEffort = effectiveEffort;
        let lastError = error;
        for (const cand of chain) {
          // 推理等级跟着候选走：目标没声明 efforts 就不传（v3.2.1 口径）
          effectiveEffort = effortFor(cand, preferredEffort);
          try {
            started = await startWith({ provider: cand.provider, model: cand.model }, "spawn");
            backend = "spawn";
            fellBack = true;
            provider = cand.provider;
            model = cand.model;
            fallbackNote =
              `启动失败（${firstReason}），已回退到 ${cand.provider}/${cand.model}` +
              (tried.length ? `（之前 ${tried.join("、")} 也失败）` : "") +
              (isolation !== "none" ? "，隔离度降为 none" : "");
            isolation = "none";
            break;
          } catch (e2) {
            tried.push(`${cand.provider}/${cand.model}`);
            failedAtStart.add(`${cand.provider}/${cand.model}`);
            lastError = e2;
          }
        }
        if (!started) throw lastError;
      }

      const childId = started && (started.childId || started.id);
      const profileLabel = LABELS.agent[agent.profile] || agent.profile;
      const head = fellBack ? "⚠️ 已回退" : "已启动子代理";
      const backendNote = modelSelectable ? "" : `${backend} 后端不接运行时模型参数，模型由该 CLI 的配置决定；`;
      // 运行期兜底：子代理启动成功但跑挂时，工具没法自己等（结果异步投递），
      // 所以把有序链一起返回；跳过当前 route 与启动期已失败的候选，免得重派到死路
      const chain = buildFallbackChain(routes, agent.profile, domain, pickOpts, { provider, model }, failedAtStart, module);
      const fallbacks = chain.map((c) => ({ provider: c.provider, model: c.model }));
      const fallbackRoute = fallbacks[0];
      return {
        subagentId: childId || null,
        provider,
        model,
        backend,
        module,
        domain,
        profile: agent.profile,
        ...(fallbackRoute ? { fallbackRoute } : {}),
        ...(fallbacks.length ? { fallbacks } : {}),
        source,
        isolation,
        fellBack,
        ...(fallbackNote ? { note: fallbackNote } : {}),
        text: `${head} ${childId || "(未知 id)"}：${modelSelectable ? `${provider}/${model}` : `${backend}（CLI 配置模型）`}（${source === "auto" && modelSelectable ? `${profileLabel}档 · ${domain}域自动选` : source === "baseline" && modelSelectable ? "未强化 · 主模型" : "手动指定"}${isolation !== "none" && modelSelectable ? ` · 隔离${isolation}` : ""}）。${backendNote}${baselineNote ? baselineNote + "。" : ""}${fallbackNote ? fallbackNote + "。" : ""}${fallbacks.length ? `运行中若收到 failed 通知，按此顺序重派（每条失败换下一条）：${fallbacks.map((f, i) => `${i + 1}.${f.provider}/${f.model}`).join("；")}；全部失败再报用户「子代理链路全挂」并附原因。` : ""}结果会异步回到本会话。`,
      };
    },
  });
  log("agent_delegate 工具已注册（绕过 allowedModels，走 provider 层；自配故障自动回退官方）");
}
