/**
 * dsh-calibration-tier — 两个只读工具（clarify_tier / forge_level）
 *
 * 轮语义：同一轮里只认「本轮开工时」的快照；轮内点击只改下轮的值。
 * `exec.agent` 是带注入校验的 cordis 代理——取属性必须逐个惰性求值并各自兜错，
 * 写成数组字面量一次性求值会让整段落到 catch（1.1.0 的教训）。
 */
import {
  MODES,
  LEVELS,
  LABELS,
  LOOP_PLAN,
  counterPlan,
  routePlan,
  thinkPlan,
  DEFAULT_SESSION,
  sanitizeSession,
  emit,
} from "./core.js";
import { readStore, sessionState, writeSession } from "./state.js";

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
      current.turn.route.level !== current.route.level;
    return {
      mode: current.turn.mode,
      level: current.turn.level,
      counter: current.turn.counter === true,
      route: current.turn.route,
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

/** 检索开关的一句话交代：关着时说「关」，开着时把三档的执行口径压成一行。 */
function routeLine(route) {
  if (!route.on) return "检索：关（只用已装技能，按需 ls/read）";
  const p = route.plan;
  return `检索=${route.label}（${p.scope}${p.network ? " + 联网" : ""}）：关键词 ${p.queries}，读取 ${p.reads}，产出 ${p.artifact}；${p.guard}`;
}

const OUTPUT = {
  schema: { type: "object", additionalProperties: true },
  render: (args, value) => [{ type: "text", text: String(value && value.text ? value.text : "") }],
};

/** 注册两个工具。ctx 必须有 tools（由 index.js 的 inject 保证）。 */
export function registerTools(ctx, log) {
  ctx.tools.register({
    name: "clarify_tier",
    description:
      "读取当前对话的思考强度（常规/严格/极致，思考与循环两种模式都返回）：常规 0 / 严格 2 / 极致 3，随强度给出三张清单——歧义点（问不问由它决定）、覆盖轴（多全面）、逆向（pre-mortem / 反证 / 反例），以及提问口径。同时返回对抗开关与检索开关。开工前若本工具可用先调用；读不到按 high。不要复述结果。",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    output: OUTPUT,
    execute: async (args, exec) => {
      const sessionId = sessionFromExec(exec);
      const state = turnState(sessionId, turnIdFromExec(exec));
      const think = thinkPlan(state.mode, state.level);
      const counter = counterPlan(state.mode, state.level, state.counter);
      const route = routePlan(state.route.on, state.route.level);
      const counterLine = counter.enabled
        ? `对抗审：开（每轮最多 ${counter.maxAttacks} 条，${counter.scope === "round-changes" ? "每轮审改动" : "动手前审方案 + 交付前审改动"}）`
        : "对抗审：关";
      if (state.mode === "loop") {
        const plan = LOOP_PLAN[state.level] || LOOP_PLAN.high;
        return {
          tier: state.level,
          mode: state.mode,
          session: sessionId,
          think,
          counter,
          route,
          turnLocked: state.turnLocked,
          pending: state.pending,
          updatedAt: state.updatedAt,
          text: `循环档位 = ${plan.forge}（${LABELS.loop[state.level]}：上限 ${plan.maxRounds} 轮，${plan.review}）；思考强度同档位映射——${think.text}；${think.ask}。${counterLine}。${routeLine(route)}。`,
        };
      }
      return {
        tier: state.level,
        mode: state.mode,
        session: sessionId,
        think,
        counter,
        route,
        turnLocked: state.turnLocked,
        pending: state.pending,
        updatedAt: state.updatedAt,
        text: `思考档位 = ${state.level}（${LABELS.think[state.level]}）；${think.text}；${think.ask}。${counterLine}。${routeLine(route)}。`,
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
      const state = turnState(sessionId, turnIdFromExec(exec));
      const route = routePlan(state.route.on, state.route.level);
      const think = thinkPlan(state.mode, state.level);
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
          updatedAt: state.updatedAt,
          text: `未进入循环模式：交付后不自动打磨（要打磨就把模式拨到「循环」）。${think.text}。`,
        };
      }
      const plan = LOOP_PLAN[state.level] || LOOP_PLAN.high;
      const counter = counterPlan("loop", state.level, state.counter);
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
        updatedAt: state.updatedAt,
        text: `循环档位 = ${plan.forge}（${LABELS.loop[state.level]}：上限 ${plan.maxRounds} 轮，${plan.review}；对抗审 ${counter.enabled ? `开，每轮最多 ${counter.maxAttacks} 条` : "关"}）；${think.text}。`,
      };
    },
  });
  log("forge_level 工具已注册");
}

export { MODES, LEVELS };
