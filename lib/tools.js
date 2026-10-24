/**
 * dsh-clarify-tier — 两个只读工具（clarify_tier / forge_level）
 *
 * 轮语义：同一轮里只认「本轮开工时」的快照；轮内点击只改下轮的值。
 * `exec.agent` 是带注入校验的 cordis 代理——取属性必须逐个惰性求值并各自兜错，
 * 写成数组字面量一次性求值会让整段落到 catch（1.1.0 的教训）。
 */
import { MODES, LEVELS, LABELS, LOOP_PLAN, counterPlan, DEFAULT_SESSION, sanitizeSession, emit } from "./core.js";
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
      current.turn.counter !== current.counter;
    return {
      mode: current.turn.mode,
      level: current.turn.level,
      counter: current.turn.counter === true,
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
      pending: false,
      turnLocked: true,
      updatedAt: saved.updatedAt,
    });
  }
  return {
    mode: snapshot.mode,
    level: snapshot.level,
    counter: snapshot.counter === true,
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

const OUTPUT = {
  schema: { type: "object", additionalProperties: true },
  render: (args, value) => [{ type: "text", text: String(value && value.text ? value.text : "") }],
};

/** 注册两个工具。ctx 必须有 tools（由 index.js 的 inject 保证）。 */
export function registerTools(ctx, log) {
  ctx.tools.register({
    name: "clarify_tier",
    description:
      "读取当前对话的档位（思考模式：常规/严格/极致，第一格值为 off 表示不锚定；循环模式下返回 off，表示不叠加锚定）。开工前若本工具可用先调用；读不到按 high。不要复述结果。",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    output: OUTPUT,
    execute: async (args, exec) => {
      const sessionId = sessionFromExec(exec);
      const state = turnState(sessionId, turnIdFromExec(exec));
      const thinkCounter = counterPlan("think", state.level, state.counter);
      if (state.mode === "loop") {
        return {
          tier: "off",
          mode: state.mode,
          session: sessionId,
          counter: counterPlan("loop", state.level, state.counter),
          turnLocked: state.turnLocked,
          pending: state.pending,
          updatedAt: state.updatedAt,
          text: "当前是循环模式：不叠加思考档（判据在循环第 1 步写）；需要强提问就先退回思考档。",
        };
      }
      return {
        tier: state.level,
        mode: state.mode,
        session: sessionId,
        counter: thinkCounter,
        turnLocked: state.turnLocked,
        pending: state.pending,
        updatedAt: state.updatedAt,
        text: `思考档位 = ${state.level}（${LABELS.think[state.level]}）；常规=按平时标准直接做（不锚定），严格为默认。对抗审：${thinkCounter.enabled ? `开（每轮最多 ${thinkCounter.maxAttacks} 条，动手前审方案 + 交付前审改动）` : "关"}。`,
      };
    },
  });
  log("clarify_tier 工具已注册");

  ctx.tools.register({
    name: "forge_level",
    description:
      "读取当前对话的循环档位：未进循环模式返回 off；循环模式下返回 lite（3 轮）/ high（5 轮）/ max（8 轮）。跑 loop-forge 前先调用。不要复述结果。",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    output: OUTPUT,
    execute: async (args, exec) => {
      const sessionId = sessionFromExec(exec);
      const state = turnState(sessionId, turnIdFromExec(exec));
      if (state.mode !== "loop") {
        return {
          forge: "off",
          mode: state.mode,
          session: sessionId,
          turnLocked: state.turnLocked,
          pending: state.pending,
          maxRounds: 0,
          review: "未进入循环模式",
          counter: counterPlan("think", state.level, state.counter),
          updatedAt: state.updatedAt,
          text: "未进入循环模式：交付后不自动打磨（要打磨就把模式拨到「循环」）。",
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
        counter,
        updatedAt: state.updatedAt,
        text: `循环档位 = ${plan.forge}（${LABELS.loop[state.level]}：上限 ${plan.maxRounds} 轮，${plan.review}；对抗审 ${counter.enabled ? `开，每轮最多 ${counter.maxAttacks} 条` : "关"}）。`,
      };
    },
  });
  log("forge_level 工具已注册");
}

export { MODES, LEVELS };
