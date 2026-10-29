/**
 * dsh-calibration-tier — 并行判据（v3.6.0-fanout）
 *
 * 目的：代理开时，把「该不该拆、拆几块」从口头建议变成可执行约束。
 * 判据来源：token-governance 的 fanout-criteria.md（六步 + 净值公式），
 * 实测口径（近 10 天 80 会话，step/start→step/end 配对）：
 *   主会话 5873 步，中位 4.8s；子代理 1209 步，中位 3.0s。
 *
 * 纪律：
 * - 只产出文本与数字，不派活、不读凭据、不联网；派活仍归 agent_delegate。
 * - 调用方只在代理开且模型注册表可用时注入，关着不背这份。
 */

/** 六步判据，一行一步，顺序即执行顺序。 */
export const FANOUT_RULES = [
  "依赖图无环且能切出 >=2 块，切不出就串行（写代码→测试→修 是一条链，拆了只会互相等）",
  "每块能写出一行可机械判定的验收断言，写不出说明没切干净",
  "Gain = n*t - (ceil(n/p)*0.6t + beta*t) > 0 才拆；beta 是任务书+汇总开销，beta >= n-0.6 必亏",
  "回传只给摘要（结论 + 证据路径:行号 + 不确定项），全文回传会把省下的时间还回去",
  "汇总必须是机械合并（拼接/去重/排序），要再推理就退回串行",
  "并发 p 不超过 maxChildren；同构批量走 subagent 白名单，异构才用 agent_delegate",
];

/** 必亏与反面情形：命中任一条就不拆。 */
export const FANOUT_NEVER = [
  "赛马：同一任务开 N 路取最快或投票，墙钟省不到 40%，成本 xN",
  "同一文件由两个子代理并行写",
  "块之间靠同一个中间文件互等（伪并行）",
];

/** 上限兜底：plan 缺 maxChildren 时按效率档的 2 块。 */
function capOf(plan) {
  const n = Number(plan && plan.maxChildren);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 2;
}

/**
 * 注入用的一行：短、带上限、可执行。完整规则走 fanoutPlan（结构化字段）。
 * @param {{maxChildren?:number}} [plan] AGENT_PLAN[profile]
 * @returns {string}
 */
export function fanoutLine(plan = {}) {
  return `并行：<=${capOf(plan)} 块；先过依赖图与验收断言，净值 <=0 就别拆；回传只给摘要；赛马不省时（成本 xN）`;
}

/**
 * 结构化快照：给 agentSection 的返回值用，前端与调参可读。
 * @param {{maxChildren?:number}} [plan]
 */
export function fanoutPlan(plan = {}) {
  // 注意：slice() 是浅复制，只隔离容器。FANOUT_RULES/FANOUT_NEVER 是字符串数组，
  // 元素不可变，所以安全；若将来改成对象数组，这里必须换成深拷贝。
  return { maxBlocks: capOf(plan), rules: FANOUT_RULES.slice(), never: FANOUT_NEVER.slice() };
}
