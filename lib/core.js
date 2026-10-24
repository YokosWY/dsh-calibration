/**
 * dsh-clarify-tier — 常量与文案（唯一事实源）
 *
 * 拆出来的理由：档名、悬停、轮次表、会话键清洗、广播总线都不属于「HTTP」也不属于「工具」，
 * 但这两边都要用；放一个文件里，改档名只改这一处。
 */
import { join } from "node:path";
import { homedir } from "node:os";

export const PACKAGE_ID = "dsh-clarify-tier";
export const MODES = ["think", "loop"];
export const LEVELS = ["off", "high", "max"];
export const DEFAULT_MODE = "think";
export const DEFAULT_LEVEL = "high";
export const SCHEMA = 7;
export const DEFAULT_SESSION = "default";
export const SESSION_LIMIT = 100;

/** 唯一事实源：档名、悬停、轮次、评审方式。客户端通过 /state 读这两张表。 */
export const LABELS = {
  think: { off: "常规", high: "严格", max: "极致" },
  loop: { off: "轻量", high: "交付", max: "极致" },
};
export const TITLES = {
  think: {
    off: "常规：按平时标准直接做，不锚定、不复述、不提问",
    high: "严格：复述 + 2 确认点 + 回滚 + 验收 + 失败分支",
    max: "极致：严格之上再加反例与代价、对抗自检、对抗复审",
  },
  loop: {
    off: "轻量：3 轮纯自检，适合小修小补",
    high: "交付：5 轮，第 2 轮独立评审 + 收敛复核",
    max: "极致：8 轮，第 2 轮起每轮独立评审",
  },
};
export const LOOP_PLAN = {
  off: { forge: "lite", maxRounds: 3, review: "纯自检，不做独立评审" },
  high: { forge: "high", maxRounds: 5, review: "第 2 轮一次独立评审 + 收敛轮复核" },
  max: { forge: "max", maxRounds: 8, review: "第 2 轮起每轮独立评审" },
};

// 给测试用：保证客户端兜底文案与宿主表一致。
export const TIER_LABELS = LABELS;
export const TIER_TITLES = TITLES;

/**
 * 「对抗」是独立开关，不是档位：开/关记在会话的 counter 上，密度随档位走。
 * - 思考模式：动手前审方案 + 交付前审改动（scope=plan+delivery）
 * - 循环模式：每轮审改动（scope=round-changes）
 */
export const COUNTER_ATTACKS = { off: 3, high: 3, max: 5 };

export function counterPlan(mode, level, enabled) {
  const on = Boolean(enabled);
  return {
    enabled: on,
    maxAttacks: on ? COUNTER_ATTACKS[level] || COUNTER_ATTACKS.high : 0,
    scope: mode === "loop" ? "round-changes" : "plan+delivery",
  };
}

export const PORT = Number(process.env.DSH_CLARIFY_TIER_PORT || 43871);
export const PORT_SPAN = 10; // 43871..43880；两套 DSH 同时开着时靠这段区间避让
export const DSH_HOME = process.env.DSH_HOME || join(homedir(), ".dsh");
export const STATE_FILE = join(DSH_HOME, "storages", "clarify-tier.json");
export const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

export function sanitizeSession(id) {
  if (typeof id !== "string") return DEFAULT_SESSION;
  const trimmed = id.trim().slice(0, 128);
  return trimmed || DEFAULT_SESSION;
}

/**
 * 广播总线：桥接（SSE）负责真正推送，工具在开新一轮时也要广播一次。
 * 两边都只认 emit()，谁也别直接抓对方的函数。
 */
let broadcaster = () => {};

export function setBroadcaster(fn) {
  broadcaster = typeof fn === "function" ? fn : () => {};
}

export function emit(sessionId, state) {
  try {
    broadcaster(sessionId, state);
  } catch {
    /* 推送失败不影响读写 */
  }
}
