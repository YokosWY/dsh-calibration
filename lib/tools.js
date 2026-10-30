/**
 * dsh-calibration-tier — 三个工具（clarify_tier / forge_level / verify_claims）
 *
 * 轮语义：同一轮里只认「本轮开工时」的快照；轮内点击只改下轮的值。
 * `exec.agent` 是带注入校验的 cordis 代理——取属性必须逐个惰性求值并各自兜错，
 * 写成数组字面量一次性求值会让整段落到 catch（1.1.0 的教训）。
 */
import { createHash } from "node:crypto";
import {
  MODES,
  LEVELS,
  LABELS,
  LOOP_PLAN,
  AGENT_PLAN,
  THINK_PLAN,
  counterPlan,
  routePlan,
  agentPlan,
  thinkPlan,
  DEFAULT_SESSION,
  sanitizeSession,
  emit,
  AGENT_PROFILES,
} from "./core.js";
import { resolveRoutes, planRoutes } from "./agents.js";
import { verifyClaims } from "./verify.js";
import { readStore, sessionState, writeSession } from "./state.js";
import { fanoutLine, fanoutPlan } from "./fanout.js";

/** 读 agent.phase.turn；兼容 phase 是 getter / 函数 / 对象三种形状。 */
export function readPhaseTurn(agent) {
  try {
    let phase = agent && agent.phase;
    if (typeof phase === "function") phase = phase();
    if (phase && typeof phase === "object" && phase.turn !== undefined && phase.turn !== null) {
      return String(phase.turn);
    }
  } catch {
    /* 忽略 */
  }
  return null;
}

/**
 * 从工具执行上下文取本轮 id；取不到返回 null（此时不做轮内保护）。
 *
 * 注意：`exec.agent` 是带注入校验的 cordis 上下文代理——访问未声明的属性会抛
 * “cannot get property X without inject”。所以候选必须**逐个惰性求值**并各自兜错，
 * 不能写成数组字面量一次性求值（那会让整个函数直接落到 catch）。
 */
export function turnIdFromExec(exec) {
  const pick = (value) => (typeof value === "string" && value ? value : null);
  const getters = [
    () => readPhaseTurn(exec && exec.agent),
    () => (exec && typeof exec.turnId === "string" ? exec.turnId : null),
  ];
  for (const get of getters) {
    try {
      const id = pick(get());
      if (id) return id;
    } catch {
      /* 该候选取不到，继续下一个 */
    }
  }
  return null;
}

/**
 * 工具侧读状态：同一轮里用「本轮开工时」的快照，轮间点击只改下轮的值。
 * 轮 id 取不到时退回实时值（不做轮内保护，但功能不坏）。
 */
export function turnState(sessionId, turnId) {
  const store = readStore();
  const current = sessionState(store, sessionId);
  if (!turnId) return { ...current, turnLocked: false, pending: false };
  if (current.turn && current.turn.id === turnId) {
    const pending =
      current.turn.mode !== current.mode ||
      current.turn.level !== current.level ||
      current.turn.counter !== current.counter ||
      current.turn.route.on !== current.route.on ||
      current.turn.route.level !== current.route.level ||
      current.turn.agent.on !== current.agent.on ||
      current.turn.agent.profile !== current.agent.profile;
    return {
      mode: current.turn.mode,
      level: current.turn.level,
      counter: current.turn.counter === true,
      route: current.turn.route,
      agent: current.turn.agent,
      updatedAt: current.updatedAt,
      turnLocked: true,
      pending,
    };
  }
  const snapshot = {
    id: turnId,
    mode: current.mode,
    level: current.level,
    counter: current.counter === true,
    route: current.route,
    agent: current.agent,
    at: new Date().toISOString(),
  };
  // owner=tool：这一笔只有「本实例的工具」能写，客户端拿它认领实例
  const saved = writeSession(sessionId, {}, { turn: snapshot, owner: "tool" });
  if (saved.ok) {
    emit(sessionId, {
      session: sessionId,
      mode: snapshot.mode,
      level: snapshot.level,
      counter: snapshot.counter === true,
      route: snapshot.route,
      agent: snapshot.agent,
      pending: false,
      turnLocked: true,
      updatedAt: saved.updatedAt,
    });
  }
  return {
    mode: snapshot.mode,
    level: snapshot.level,
    counter: snapshot.counter === true,
    route: snapshot.route,
    agent: snapshot.agent,
    updatedAt: saved.updatedAt || current.updatedAt,
    turnLocked: true,
    pending: false,
  };
}

/** 工具执行上下文里的会话 id；读不到落 default。 */
export function sessionFromExec(exec) {
  try {
    const agent = exec && exec.agent;
    const session = agent && agent.session;
    if (session && typeof session.id === "string") return sanitizeSession(session.id);
    if (agent && typeof agent.id === "string") return sanitizeSession(agent.id);
  } catch {
    /* 忽略 */
  }
  return DEFAULT_SESSION;
}

/** 主模型 route：能拿到就用来保证对抗隔离；拿不到返回空（v3.8.0 起隔离度按 low 算，不再报 unknown）。
 * 宿主版本不同，`exec` 上暴露的位置也不一样，按几种常见形状逐个试。
 */
export function mainRouteFromExec(exec) {
  const str = (v) => (typeof v === "string" && v ? v : null);
  const read = (fn) => {
    try {
      return fn();
    } catch {
      return null;
    }
  };
  const shapes = [
    () => [read(() => exec.agent.model.provider), read(() => exec.agent.model.id)],
    () => [read(() => exec.agent.model.provider), read(() => exec.agent.model.model)],
    () => [read(() => exec.model.provider), read(() => exec.model.id)],
    () => [read(() => exec.provider), read(() => exec.model)],
    () => [read(() => exec.request.model.provider), read(() => exec.request.model.id)],
  ];
  for (const shape of shapes) {
    const [provider, model] = shape();
    const p = str(provider);
    const m = str(model);
    if (p && m) return { provider: p, model: m };
  }
  return { provider: "", model: "" };
}

/** 工具执行上下文里的工作区根：优先 exec 上的 cwd，拿不到落进程 cwd。 */
export function rootFromExec(exec) {
  const pick = (fn) => {
    try {
      const v = fn();
      return typeof v === "string" && v ? v : null;
    } catch {
      return null;
    }
  };
  const fromExec = pick(() => exec && exec.cwd) || pick(() => exec && exec.agent && exec.agent.cwd);
  return fromExec || process.cwd();
}

/** 检索回执的日期戳：YYYYMMDD（本地时区），只用于拼落盘路径。 */
function dayStamp(d) {
  const x = d || new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${x.getFullYear()}${p(x.getMonth() + 1)}${p(x.getDate())}`;
}

/**
 * 回执里的占位符：渲染成可读的「<查询数>」而不是 {queries}，免得模型照抄花括号。
 * 五个模式的回执共用这张表，加字段只加这里。
 */
export const RECEIPT_FIELDS = {
  level: "档位",
  assumptions: "假设数",
  checks: "已核",
  total: "总数",
  lines: "条目数",
  rounds: "轮数",
  maxRounds: "上限",
  fixes: "修订数",
  accepted: "采纳",
  rejected: "驳回",
  bounds: "边界",
  attacks: "条数",
  mode: "模式",
  modules: "模块",
  children: "孩子数",
  retries: "重派数",
  queries: "查询数",
  candidates: "候选数",
  installs: "安装数",
  groups: "同组数",
};

/**
 * 统一契约渲染（v3.7.0）：头 → 编号步骤 → 提问口径 → 产出/落盘 → 收尾回执 → 守卫。
 *
 * 为什么统一：v3.6.0 只给「检索」补了 steps/ledger/receipt，其余四个模式仍是一句口径，
 * 切了档看不出差别、事后也验不出做没做。五个模式共用这一份渲染器，差异只来自数据。
 *
 * @param {string} head 一行头（含档位名与上限）
 * @param {object} plan 档位计划（steps / ledger / ask / artifact / receipt / guard）
 * @param {Date} [today] 用于拼落盘日期（测试注入）
 */
export function renderContract(head, plan, today) {
  const p = plan || {};
  const ledger = String(p.ledger || "").replace(/<YYYYMMDD>/g, dayStamp(today));
  const steps = (p.steps || []).map((s, i) => `${i + 1}) ${String(s).replace(/<LEDGER>/g, ledger)}`).join("\n");
  const askLine = p.ask ? `提问：${p.ask}` : "";
  const artifact = p.artifact
    ? `产出：${p.artifact}${ledger ? `；落盘 ${ledger}` : ""}`
    : ledger
      ? `落盘 ${ledger}`
      : "";
  const receiptText = p.receipt
    ? String(p.receipt).replace(/\{(\w+)\}/g, (m, k) => (k === "ledger" ? ledger : `<${RECEIPT_FIELDS[k] || k}>`))
    : "";
  // 回执只在「真发生」时要求（v3.7.1）：没派子代理 / 没提对抗条目 / 没跑够轮次就不写，
  // 否则每轮硬凑「0 孩子 / 0 条」，噪声盖过结论。
  const cond = p.receiptWhen ? String(p.receiptWhen) : "";
  const receipt = receiptText
    ? `收尾${cond ? `仅当${cond}时` : "必须"}在回复末尾单起一行「${receiptText}」${
        ledger ? `，数字跟 ${ledger} 里的实际条目一致；没落盘就不许写这行` : "，数字跟实际条目一致"
      }${cond ? "；没发生就不写这行" : ""}`
    : "";
  return [head, steps, askLine, artifact, receipt, p.guard].filter(Boolean).join("\n");
}

/**
 * 检索档位的可执行交代（v3.6.0，v3.7.0 走统一渲染器）。
 */
export function routeLine(route, today) {
  if (!route.on) return "检索：关（本地行为，按需 ls/read）";
  const p = route.plan || {};
  const head = `检索=${route.label}（${p.scope}${p.network ? " + 联网" : ""}）：关键词 ${p.queries}，读取 ${p.reads}`;
  return renderContract(head, p, today);
}

/** 思考档位：清单 + 回执（off 不带清单，按平时标准直接做）。 */
export function thinkLine(think, today) {
  const p = THINK_PLAN[think.level] || THINK_PLAN.high;
  return renderContract(`思考档位 = ${think.level}｜${think.text}`, p, today);
}

/** 循环档位：轮次清单 + 落盘 + 回执。 */
export function loopLine(level, today) {
  const p = LOOP_PLAN[level] || LOOP_PLAN.high;
  return renderContract(`循环档位 = ${p.forge}（${LABELS.loop[level]}：上限 ${p.maxRounds} 轮，${p.review}）`, p, today);
}

/** 对抗开关：开=审什么、怎么收口、回执长什么样；关=一行。 */
export function counterLineOf(counter, mode, today) {
  if (!counter.enabled) return "对抗审：关";
  const scopeText = counter.scope === "round-changes" ? "每轮审改动" : "动手前审方案 + 交付前审改动";
  return renderContract(
    `对抗审：开（每轮最多 ${counter.maxAttacks} 条，${scopeText}）`,
    { ...counter, mode },
    today,
  );
}

/** 代理计划：只算当前模式用得到的模块，减少每步注入体积。 */
export async function agentSection(ctx, state, counter, route) {
  if (!state.agent.on) return { agent: { on: false }, text: "代理：关（按官方默认派活）" };
  const resolved = await resolveRoutes(ctx);
  if (!resolved.available) {
    return {
      agent: { on: true, profile: state.agent.profile, available: false, note: "宿主未暴露 llm 服务或注册表为空" },
      text: `代理：开（${LABELS.agent[state.agent.profile]}）但模型注册表不可用——不派子代理，按主模型自己跑`,
    };
  }
  const main = mainRouteFromExec(state.exec);
  const plan = planRoutes(resolved.routes, state.agent.profile, { mainProvider: main.provider, mainModel: main.model });
  const wanted = new Set();
  if (state.agent.on) wanted.add("executor");
  if (state.mode === "loop") wanted.add("review");
  if (counter.enabled) wanted.add("counter");
  if (route.on) wanted.add("research");
  const modules = {};
  for (const key of wanted) modules[key] = plan.modules[key] || null;
  // 三级回退：性能档 → 效率档 → 主模型自审（第三级在技能里执行，工具只给前两级 route）
  const fallback = plan.fallback
    ? {
        profile: plan.fallback.profile,
        label: plan.fallback.label,
        modules: Object.fromEntries([...wanted].map((k) => [k, plan.fallback.modules[k] || null])),
      }
    : undefined;
  const planId = createHash("sha1")
    .update(`${state.session}|${state.turnId || ""}|${state.agent.profile}|${JSON.stringify(modules)}`)
    .digest("hex")
    .slice(0, 8);
  const isolation = Object.entries(modules)
    .filter(([, v]) => v && v.isolation && v.isolation !== "none")
    .map(([k, v]) => `${k}=${v.isolation}`)
    .join("，");
  const text = [
    renderContract(
      `代理：开（${plan.label}，最多 ${plan.maxChildren} 个孩子，planId=${planId}）`,
      AGENT_PLAN[state.agent.profile] || AGENT_PLAN.efficiency,
    ),
    `模块：${Object.entries(modules)
      .map(([k, v]) => (v ? `${k}→${v.provider}/${v.model}` : `${k}=不可用`))
      .join("；")}`,
    isolation ? `隔离：${isolation}` : "",
    fallback ? "回退：这条调不通就降到效率档，再不行主模型自审并标「隔离度：低」" : "",
    "派活用 agent_delegate（给 module，自动按档位选模型；当前会话立刻可用）；官方 subagent 的白名单在会话创建时快照，只对新会话生效",
    "子代理若运行中失败（会收到 failed 通知），按 agent_delegate 返回的 fallbacks 顺序重派，每条失败换下一条（fallbackRoute 是链首）；全挂再报「子代理链路全挂」",
    "子代理 prompt 首行写 [CT-plan:" + planId + " module:<名>]",
    fanoutLine(plan),
  ]
    .filter(Boolean)
    .join("\n");
  const agentPlan = AGENT_PLAN[state.agent.profile] || AGENT_PLAN.efficiency;
  return {
    agent: {
      on: true,
      profile: state.agent.profile,
      label: plan.label,
      planId,
      maxChildren: plan.maxChildren,
      isolation: plan.isolation,
      modules,
      ...(fallback ? { fallback } : {}),
      fingerprint: resolved.fingerprint,
      ...(main.provider && main.model ? { mainRoute: main } : {}),
      fanout: fanoutPlan(plan),
      contract: {
        steps: agentPlan.steps.slice(),
        receipt: agentPlan.receipt,
        guard: agentPlan.guard,
      },
    },
    text,
  };
}

const OUTPUT = {
  schema: { type: "object", additionalProperties: true },
  render: (args, value) => [{ type: "text", text: String(value && value.text ? value.text : "") }],
};

/** 注册三个工具。ctx 必须有 tools（由 index.js 的 inject 保证）。 */
export function registerTools(ctx, log) {
  ctx.tools.register({
    name: "clarify_tier",
    description:
      "读取当前对话的思考强度（常规/严格/极致，思考与循环两种模式都返回）：常规 0 / 严格 2 / 极致 3，随强度给出三张清单——歧义点（问不问由它决定）、覆盖轴（多全面）、逆向（pre-mortem / 反证 / 反例），以及提问口径。同时返回对抗、检索、代理三个开关：代理开着时给本轮的模型路由计划（各模块 provider/model 与隔离级别），关着时只回 on:false。开工前若本工具可用先调用；读不到按 high。不要复述结果。",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    output: OUTPUT,
    execute: async (args, exec) => {
      const sessionId = sessionFromExec(exec);
      const turnId = turnIdFromExec(exec);
      const state = turnState(sessionId, turnId);
      const think = thinkPlan(state.mode, state.level);
      const counter = counterPlan(state.mode, state.level, state.counter);
      const route = routePlan(state.route.on, state.route.level);
      const agentState = {
        ...state,
        session: sessionId,
        turnId: turnId || "",
        exec,
      };
      const agentSectionValue = await agentSection(ctx, agentState, counter, route);
      const counterLine = counterLineOf(counter, state.mode);
      const blocks = (...parts) => parts.filter(Boolean).join("\n\n");
      if (state.mode === "loop") {
        const plan = LOOP_PLAN[state.level] || LOOP_PLAN.high;
        return {
          tier: state.level,
          mode: state.mode,
          session: sessionId,
          think,
          counter,
          route,
          agent: agentSectionValue.agent,
          turnLocked: state.turnLocked,
          pending: state.pending,
          updatedAt: state.updatedAt,
          contract: { steps: plan.steps.slice(), ledger: plan.ledger, receipt: plan.receipt, guard: plan.guard },
          text: blocks(
            loopLine(state.level),
            `思考强度同档位映射 —— ${think.text}；${think.ask}`,
            counterLine,
            routeLine(route),
            agentSectionValue.text,
          ),
        };
      }
      return {
        tier: state.level,
        mode: state.mode,
        session: sessionId,
        think,
        counter,
        route,
        agent: agentSectionValue.agent,
        turnLocked: state.turnLocked,
        pending: state.pending,
        updatedAt: state.updatedAt,
        contract: {
          steps: (THINK_PLAN[state.level] || THINK_PLAN.high).steps.slice(),
          ledger: (THINK_PLAN[state.level] || THINK_PLAN.high).ledger,
          receipt: (THINK_PLAN[state.level] || THINK_PLAN.high).receipt,
          guard: (THINK_PLAN[state.level] || THINK_PLAN.high).guard,
        },
        text: blocks(thinkLine(think), counterLine, routeLine(route), agentSectionValue.text),
      };
    },
  });
  log("clarify_tier 工具已注册");

  ctx.tools.register({
    name: "forge_level",
    description:
      "读取当前对话的循环档位：未进循环模式返回 off；循环模式下返回 lite（3 轮）/ high（5 轮）/ max（8 轮），并带同档位的思考强度（think：歧义点 / 覆盖轴 / 逆向三张清单）。跑 loop-forge 前先调用。不要复述结果。",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    output: OUTPUT,
    execute: async (args, exec) => {
      const sessionId = sessionFromExec(exec);
      const turnId = turnIdFromExec(exec);
      const state = turnState(sessionId, turnId);
      const route = routePlan(state.route.on, state.route.level);
      const think = thinkPlan(state.mode, state.level);
      const counter = counterPlan(state.mode, state.level, state.counter);
      const agentSectionValue = await agentSection(
        ctx,
        { ...state, session: sessionId, turnId: turnId || "", exec },
        counter,
        route,
      );
      if (state.mode !== "loop") {
        return {
          forge: "off",
          mode: state.mode,
          session: sessionId,
          turnLocked: state.turnLocked,
          pending: state.pending,
          maxRounds: 0,
          review: "未进入循环模式",
          think,
          counter: counterPlan("think", state.level, state.counter),
          route,
          agent: agentSectionValue.agent,
          updatedAt: state.updatedAt,
          text: `未进入循环模式：交付后不自动打磨（要打磨就把模式拨到「循环」）。${think.text}。${agentSectionValue.text}`,
        };
      }
      const plan = LOOP_PLAN[state.level] || LOOP_PLAN.high;
      return {
        forge: plan.forge,
        mode: state.mode,
        level: state.level,
        label: LABELS.loop[state.level],
        session: sessionId,
        turnLocked: state.turnLocked,
        pending: state.pending,
        maxRounds: plan.maxRounds,
        review: plan.review,
        think,
        counter,
        route,
        agent: agentSectionValue.agent,
        updatedAt: state.updatedAt,
        contract: { steps: plan.steps.slice(), ledger: plan.ledger, receipt: plan.receipt, guard: plan.guard },
        text: [
          loopLine(state.level),
          `思考强度同档位映射 —— ${think.text}；${think.ask}`,
          counterLineOf(counter, state.mode),
          routeLine(route),
          agentSectionValue.text,
        ]
          .filter(Boolean)
          .join("\n\n"),
      };
    },
  });
  log("forge_level 工具已注册");

  ctx.tools.register({
    name: "verify_claims",
    description:
      "机械校验「断言 ↔ 来源」是否对得上（只读、纯本地、不联网、不写盘）。文件类：路径必须在工作区内、行号在范围内、断言里的数字或引号短语要出现在该行 ±3 行；URL 类：只验语法与域名分级（L1 一手/官方、L2 学术、L3 媒体、L4 其余），不抓内容；命令类：只确认片段非空无占位符，标 weak；回执类（kind=ledger）：给落盘文件与其「候选数」，数 Markdown 表格数据行（跳过表头与分隔行）跟回执对不对得上——这是把「检索回执」变成可机械核对的那一步。它只能证明「有对应的源」，不能证明源本身真实——报告里必须分「已核 / 未核 / 核不了」，别自己声称已核对。",
    parameters: {
      type: "object",
      properties: {
        claims: {
          type: "array",
          items: {
            type: "object",
            properties: {
              text: { type: "string", description: "要核对的断言原文（含数字/日期/引号短语）" },
              source: {
                type: "object",
                properties: {
                  kind: { type: "string", enum: ["file", "url", "command", "ledger"] },
                  path: { type: "string", description: "kind=file/ledger 时的相对路径（限工作区）" },
                  line: { type: "number", description: "kind=file 时的行号（1 起）" },
                  url: { type: "string", description: "kind=url" },
                  snippet: { type: "string", description: "kind=command 时的输出片段" },
                  expect: {
                    type: "object",
                    description: "kind=ledger 时的期望：candidates=表格数据行要等于几条；min=至少要几条",
                    properties: {
                      candidates: { type: "number" },
                      min: { type: "number" },
                    },
                    additionalProperties: false,
                  },
                },
                additionalProperties: true,
              },
            },
            required: ["text", "source"],
            additionalProperties: true,
          },
        },
      },
      required: ["claims"],
      additionalProperties: false,
    },
    output: OUTPUT,
    execute: async (args, exec) => {
      const report = verifyClaims(args && args.claims, rootFromExec(exec));
      const head = `共 ${report.total} 条：已核 ${report.counts.ok} · 未核 ${report.counts.missing} · 核不了(weak) ${report.counts.weak}`;
      const detail = report.results
        .slice(0, 8)
        .map((r) => `#${r.index + 1} ${r.ok === true ? "已核" : r.level === "weak" ? "核不了" : "未核"}：${r.reasons.join("；")}`)
        .join("\n");
      return { ...report, text: `${head}\n${detail}` };
    },
  });
  log("verify_claims 工具已注册");
}

export { MODES, LEVELS, AGENT_PROFILES };
