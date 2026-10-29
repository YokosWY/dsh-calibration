/**
 * dsh-calibration-tier — 常量与文案（唯一事实源）
 *
 * 拆出来的理由：档名、悬停、轮次表、会话键清洗、广播总线都不属于「HTTP」也不属于「工具」，
 * 但这两边都要用；放一个文件里，改档名只改这一处。
 */
import { join } from "node:path";
import { homedir } from "node:os";

export const PACKAGE_ID = "dsh-calibration";
export const MODES = ["think", "loop"];
export const LEVELS = ["off", "high", "max"];
/**
 * 「检索」是第三个独立开关（v2.2.0），有自己的档位，不跟 mode/level 抢字段。
 * v3.0.0：去掉「本地」档——开关关着就是不检索，等于本地行为。
 * v3.5.0（2026-10-29）：检索收成**一个轮换格**「本地 → 增量 → 全量」，省两格。
 * 「本地」只回到**显示位**（关 = 本地），不进 ROUTE_LEVELS，也不进 ROUTE_PLAN：
 * 状态仍是 `route.on` + `route.level`，没有「开检索但不检索」这种状态。
 */
export const ROUTE_LEVELS = ["high", "max"];
export const DEFAULT_MODE = "think";
export const DEFAULT_LEVEL = "high";
export const DEFAULT_ROUTE = { on: false, level: "high" };
/**
 * 「代理」是第四个独立开关（v3.0.0）：开 = 按计划派子代理，关 = 回到官方默认。
 * 它管「派谁、用哪个模型」，不管「怎么执行」——执行仍走官方 subagent 工具。
 * v3.5.0：同样收成一个轮换格「默认 → 效率 → 性能」，「默认」只是 off 的显示名。
 */
export const AGENT_PROFILES = ["efficiency", "performance"];
export const DEFAULT_AGENT = { on: false, profile: "efficiency" };
export const SCHEMA = 9;
export const DEFAULT_SESSION = "default";
export const SESSION_LIMIT = 100;

/** 唯一事实源：档名、悬停、轮次、评审方式。客户端通过 /state 读这两张表。 */
export const LABELS = {
  think: { off: "常规", high: "严格", max: "极致" },
  loop: { off: "轻量", high: "交付", max: "极致" },
  // off 是轮换格的显示名（v3.5.0），不是可提交的档位：ROUTE_LEVELS/AGENT_PROFILES 仍然只有两档
  route: { off: "本地", high: "增量", max: "全量" },
  agent: { off: "默认", efficiency: "效率", performance: "性能" },
};
export const AGENT_LABELS = LABELS.agent;
/**
 * 思考强度（v2.3.0）：档位不再只报一个名字，而是一张「怎么想」的清单——
 * ① 歧义点 probes：先判定哪些地方会有歧义，问不问由它决定；
 * ② 覆盖轴 axes：全面性，一轴一条，不许留空；
 * ③ 逆向 reverse：pre-mortem / 反证 / 反例，三档按强度分配。
 * 循环模式不再短路思考强度：同档位映射一份（轻量=常规、交付=严格、极致=极致），
 * 否则「在循环档里从不提问」就成了默认行为（2.2.1 那次 About 漏更新就是这么来的）。
 */
export const THINK_PLAN = {
  off: {
    intensity: 0,
    probes: [],
    axes: [],
    reverse: [],
    confirm: 0,
    ask: "不问、不复述：按平时标准直接做",
    steps: [],
    ledger: "",
    receipt: "",
    guard: "按平时标准直接做：不出清单、不出回执",
  },
  high: {
    intensity: 2,
    probes: [
      "目标与验收：完成的样子能不能一句话验收，说不清就是歧义",
      "不可逆与外部动作：推送 / 发布 / 改设置 / 删除，谁批准、怎么回滚",
    ],
    axes: ["正常路径", "边界与空值", "失败与回滚"],
    reverse: ["pre-mortem：先写「最可能怎么坏」，再倒推要避开的点"],
    confirm: 2,
    ask: "只问会改变执行的分歧；能自己查证的，不占提问额度",
    steps: [
      "复述目标与验收：完成的样子压成一句，超过三句先压缩",
      "列歧义点：只问会改变执行的分歧（≤2 处）；能自己查证的不占额度",
      "开工前写假设清单（≤3 条）：不做什么、为什么不做",
      "交付前逐条回勾验收，每条给证据（路径 / 命令 / 版本号）",
      "收尾单起一行「思考回执：…」，数字跟实际相符",
    ],
    ledger: "",
    receipt: "思考回执：{level} · {assumptions} 假设 · {checks}/{total} 验收回勾",
    guard: "说不清验收目标就先问，别先做",
  },
  max: {
    intensity: 3,
    probes: [
      "目标与验收：一句话验收，说不清就是歧义",
      "不可逆与外部动作：谁批准、回滚路径、失败分支",
      "范围与取舍：不做什么、为什么不做，把代价写明",
    ],
    axes: ["正常路径", "边界与空值", "失败与回滚", "依赖与副作用", "成本与性能", "后续与可维护"],
    reverse: ["pre-mortem：假设已经失败，倒推原因", "反证：什么证据会直接推翻这个结论", "反例：每条给触发条件 / 后果 / 检查方法"],
    confirm: 3,
    ask: "先弹窗问 frontier（会改变执行的分歧），能查证的自己查",
    steps: [
      "复述目标与验收（一句能验收的），并写清不做什么",
      "先弹窗问 frontier 歧义点；能自己查证的不占额度",
      "写设计树：方案 → 取舍 → 代价（≤3 条），落进 <LEDGER>",
      "逆向三条：pre-mortem / 反证 / 反例（每条给触发条件、后果、检查方法），落进 <LEDGER>",
      "开工后做对抗自检：按反驳意见改一轮",
      "交付前回勾验收，附回滚与失败分支",
      "定止损线：连续 3 步无落物就停手报阻塞",
    ],
    ledger: "tmp\\tier-plan-<YYYYMMDD>.md",
    receipt: "思考回执：极致 · {assumptions} 假设 · {checks}/{total} 验收回勾 · {lines} 条目 · {ledger}",
    guard: "缺件即未达标；说不清验收目标就先问",
  },
};
export const THINK_LEVELS = ["off", "high", "max"];

/** 思考强度的对外快照：思考/循环两种模式都有——循环按同档位映射，不再返回 off。 */
export function thinkPlan(mode, level) {
  const lv = THINK_LEVELS.includes(level) ? level : DEFAULT_LEVEL;
  const plan = THINK_PLAN[lv];
  return {
    source: mode === "loop" ? "loop" : "think",
    level: lv,
    label: LABELS.think[lv],
    intensity: plan.intensity,
    probes: plan.probes.slice(),
    axes: plan.axes.slice(),
    reverse: plan.reverse.slice(),
    confirm: plan.confirm,
    ask: plan.ask,
    text: `${LABELS.think[lv]}（强度 ${plan.intensity}）：歧义点 ${plan.probes.length} · 覆盖轴 ${plan.axes.length} · 逆向 ${plan.reverse.length}`,
  };
}
export const TITLES = {
  think: {
    off: "常规：按平时标准直接做，不锚定、不复述、不提问",
    high: "严格：5 步清单——复述 → 歧义点 → 假设≤3 → 回勾验收 → 思考回执；不强制落盘",
    max: "极致：7 步清单 + 方案/反例落 tmp\\tier-plan-<日期>.md + 对抗自检 + 止损线",
  },
  loop: {
    off: "轻量：3 轮纯自检，出循环回执，不落盘",
    high: "交付：5 轮，第 2 轮独立评审 + 收敛复核；清单落 tmp\\forge-<日期>.md，出循环回执",
    max: "极致：8 轮，第 2 轮起每轮独立评审；落 tmp\\forge-full-<日期>.md，出循环回执",
  },
  route: {
    off: "本地：不联网检索，只用已装技能（命中隐藏技能会先 read 说明）",
    high: "增量：本地盘点 → 3 组查询 → 候选表落 tmp\\skill-scan-<日期>.md，给装/不装一句结论；回复末尾带检索回执",
    max: "全量：≥5 组查询、候选 ≥20、同组差异 → 判别卡落 tmp\\skill-scan-full-<日期>.md；回复末尾带检索回执",
  },
  agent: {
    off: "默认：不派子代理、不强化，派活沿用主模型",
    efficiency: "效率：强化一档——比主模型强、同档取便宜的；派活 4 步 + 代理回执（真派了才写）",
    performance: "性能：绝对质量——最强模型 + 最高推理等级；派活 5 步 + 代理回执（真派了才写，含隔离说明）",
  },
};
/**
 * 循环档位（v3.7.0）：同样补 steps + ledger + receipt，让「磨几轮」变成可核对的清单。
 */
export const LOOP_PLAN = {
  off: {
    forge: "lite",
    maxRounds: 3,
    review: "纯自检，不做独立评审",
    steps: [
      "第 1–3 轮：每轮自检改一版，只记改了什么、为什么",
      "第 3 轮收敛复核：判据全过或写明还剩什么，不许无限磨",
    ],
    ledger: "",
    receipt: "循环回执：轻量 · {rounds}/{maxRounds} 轮 · {fixes} 修",
    guard: "轮数到顶就收手，别为了磨而磨",
  },
  high: {
    forge: "high",
    maxRounds: 5,
    review: "第 2 轮一次独立评审 + 收敛轮复核",
    steps: [
      "第 1 轮：按 plan 改一版，记改动清单",
      "第 2 轮：派独立评审（另一模型 / 独立会话），只看需求与产物文件",
      "第 3–4 轮：按评审意见逐条修，不采纳的写驳回理由",
      "第 5 轮：收敛复核，判据全过才停",
    ],
    ledger: "tmp\\forge-<YYYYMMDD>.md",
    receipt: "循环回执：交付 · {rounds}/{maxRounds} 轮 · {fixes} 修 · {accepted}/{total} 采纳 · {ledger}",
    receiptWhen: "本轮真跑到 ≥2 轮",
    guard: "未落盘 = 未执行；判据全过才收手",
  },
  max: {
    forge: "max",
    maxRounds: 8,
    review: "第 2 轮起每轮独立评审",
    steps: [
      "第 1 轮：按 plan 改一版，记改动清单",
      "第 2 轮：派独立评审（另一模型 / 独立会话），只看需求与产物文件",
      "第 2 轮起每轮都评审 + 对抗复审（≥3 条反对意见，含反例）",
      "第 3–7 轮：按意见逐条修，不采纳的写驳回理由",
      "第 8 轮：收敛复核，判据全过才停",
    ],
    ledger: "tmp\\forge-full-<YYYYMMDD>.md",
    receipt: "循环回执：极致 · {rounds}/{maxRounds} 轮 · {fixes} 修 · {accepted}/{total} 采纳 · {ledger}",
    receiptWhen: "本轮真跑到 ≥2 轮",
    guard: "未落盘 = 未执行；判据全过且复核确认才收手",
  },
};

/**
 * 检索档位（v3.6.0）：每档带可执行 steps + 必交落盘文件 + 收尾回执。
 * 旧字段（scope/network/queries/reads/artifact/guard）保留兼容；v3.0.0 起的毛病是只给一句口径，
 * 模型看不出要做什么、事后也验不出做没做，所以补 steps/ledger/receipt。
 */
export const ROUTE_PLAN = {
  high: {
    scope: "local+registry",
    network: true,
    queries: "≥3 组英文同义词（带 site:github.com 收窄，躲目录站与博客转述）",
    reads: "≤3 篇，只读文本不安装",
    artifact: "候选表 + 装/不装建议 + 风险 + 一句为什么值得",
    ledger: "tmp\\skill-scan-<YYYYMMDD>.md",
    steps: [
      "本地先盘点：skillq \"<需求>\" 拿 Top-N 与命中理由；本地已够就只写这张表，不联网",
      "联网 ≤3 组英文同义词（anysearch），每组至少留一条命中或写「0 命中」",
      "候选表写进 <LEDGER>：名 / 来源 / 是否已装 / 星数 / 一句用途",
      "结论一行：装 ≤1 个（给理由与风险）或「不装」（说明本地为什么不够）",
    ],
    receipt: "检索回执：增量 · {queries} 查询 · {candidates} 候选 · {installs} 安装 · {ledger}",
    guard: "本地已够即收手；检索只跑首轮；未落盘 = 未执行",
  },
  max: {
    scope: "local+registry",
    network: true,
    queries: "≥5 组，候选 ≥20",
    reads: "不设上限，只跑首轮",
    artifact: "判别卡 + 安装清单 + 冲突清单",
    ledger: "tmp\\skill-scan-full-<YYYYMMDD>.md",
    steps: [
      "本地全量盘点：中/英各 ≥2 组关键词走 skillq，记命中数",
      "联网 ≥5 组查询（anysearch），候选 ≥20，去重后按星数与近期更新排序",
      "重合组做差异分析：同组 ≥2 个才比规格，标出重叠能力与各自短板",
      "判别卡写进 <LEDGER>：判别卡（三段）/ 安装清单 / 冲突清单",
      "结论一行：装 ≤2 个（给理由与风险）或「不装」",
    ],
    receipt: "检索回执：全量 · {queries} 查询 · {candidates} 候选 · {groups} 组对比 · {ledger}",
    guard: "同组 ≥2 才做规格对比；只跑首轮，不跟循环叠加；未落盘 = 未执行",
  },
};

/**
 * 代理计划（v3.0.0，v3.4.0 定语义）。只管「派不派、派几个、给哪些模块发哪条 route」。
 * - 代理开关 = **强化**开关：关 = 不强化（沿用主模型）；开 = 强化，再选强度。
 * - efficiency：强化一档——严格强于主模型，且只升一档、同分取代价低的。
 * - performance：绝对质量——各域最高分 + 模型声明的最高推理等级。
 * isolation：counter 必须异族 provider；只能同族时降级为 "mid"。
 */
export const AGENT_PLAN = {
  efficiency: {
    maxChildren: 2,
    counterAttacks: 3,
    isolation: "prefer",
    reviewRounds: "第 2 轮一次",
    steps: [
      "先过并行判据（依赖图 / 验收断言 / 净值公式），不过就自己跑",
      "派活用 agent_delegate，prompt 首行写 [CT-plan:<id> module:<名>]",
      "挑模型：按模块领域取最强、同分取代价低的，不跨档硬升",
      "收到 failed 按 fallbacks 顺序重派，每条失败换下一条；全挂报链路全挂",
    ],
    ledger: "",
    receipt: "代理回执：效率 · {modules}=模块 · {children} 孩子 · {retries} 重派",
    receiptWhen: "本轮真派了子代理（children ≥1）",
    guard: "赛马不省时；同一文件不许两路并行写",
  },
  performance: {
    maxChildren: 3,
    counterAttacks: 5,
    isolation: "require",
    reviewRounds: "第 2 轮起每轮",
    steps: [
      "先过并行判据（依赖图 / 验收断言 / 净值公式），不过就自己跑",
      "派活用 agent_delegate，prompt 首行写 [CT-plan:<id> module:<名>]",
      "重要任务可开满 maxChildren=3，对抗复审按档位条数执行",
      "收到 failed 按 fallbacks 顺序重派，每条失败换下一条；全挂报链路全挂",
    ],
    ledger: "",
    receipt: "代理回执：性能 · {modules}=模块 · {children} 孩子 · {retries} 重派",
    receiptWhen: "本轮真派了子代理（children ≥1）",
    guard: "赛马不省时；同一文件不许两路并行写；隔离不足要写明",
  },
};

/** 模块 → 领域：决定用哪一列能力分挑模型。 */
export const AGENT_DOMAINS = {
  executor: "code",
  review: "reasoning",
  counter: "reasoning",
  research: "longContext",
};
/**
 * 打分必须覆盖的领域（v3.3.1 修）：模块映射只用到上面三列，但 `agent_delegate` 的
 * `domain` 参数另外暴露 writing / toolUse——只按 AGENT_DOMAINS 打分会让这两列恒为
 * undefined，`better()` 的比较谓词恒真/恒假，`domain=writing|toolUse` 挑中哪条不可预测。
 * 计分域 = 模块用到的域 ∪ 工具暴露的域，一处定义。
 */
export const AGENT_SCORE_DOMAINS = ["code", "reasoning", "writing", "longContext", "toolUse"];

/**
 * 能力基线（手写，会过期）。宿主的 llm 服务只给 provider/model/contextWindow，
 * 不给「谁最强」；这张表是唯一的领域判断依据，用户可用
 * `~/.dsh/storages/calibration-models.json` 覆盖。
 *
 * `cost`（v3.4.0）是**相对代价序**，不是真实单价：宿主拿不到价格，只能人工排序。
 * 1 = 最便宜，5 = 最贵；只在同分时用来判「性价比」。可逐条覆盖。
 */
export const CAPABILITIES = {
  families: [
    { match: "claude-opus", code: 9, reasoning: 10, writing: 9, longContext: 9, toolUse: 9, tier: "high", cost: 5 },
    { match: "claude-sonnet", code: 8, reasoning: 8, writing: 8, longContext: 8, toolUse: 8, tier: "mid", cost: 3 },
    { match: "claude-fable", code: 7, reasoning: 7, writing: 7, longContext: 7, toolUse: 7, tier: "mid", cost: 3 },
    { match: "deepseek-v4", code: 8, reasoning: 8, writing: 7, longContext: 7, toolUse: 8, tier: "mid", cost: 1 },
    { match: "deepseek-flash", code: 7, reasoning: 7, writing: 6, longContext: 6, toolUse: 7, tier: "low", cost: 1 },
    { match: "grok", code: 7, reasoning: 8, writing: 8, longContext: 9, toolUse: 6, tier: "high", cost: 4 },
  ],
  fallback: { code: 5, reasoning: 5, writing: 5, longContext: 5, toolUse: 5, tier: "unknown", cost: 3 },
};

/**
 * 免费线 provider：第三方插件注册的免额度通道（`dsh-our-free-model` 的 WorkBuddy 入口及其渠道）。
 * 不要钱，但额度与连通性不稳——实测「启动成功、跑一半静默失败、无收尾消息」。
 * 只在**同分**时降权（排在非免费线之后），不改能力分；手动点名不受影响；
 * `calibration-models.json` 里写 `{ models: { "provider/model": { free: true|false } } }` 可单条覆盖。
 * 只列名字够独特的渠道；`minimax` / `gemini` / `zcode` 这类可能与正规 provider 撞名，故意不收。
 */
export const FREE_LINE_PROVIDERS = [
  "buddy",
  "workbuddy",
  "workbuddy-ai",
  "our-free-model",
  "our-free-model-region",
  "codearts",
  "lobsterai",
  "qoder",
  "qodercn",
  "trae",
  "cline",
  "loomy",
  "raccoon",
];

// 给测试用：保证客户端兜底文案与宿主表一致。
export const TIER_LABELS = LABELS;
export const TIER_TITLES = TITLES;
export const TIER_ROUTE_LABELS = LABELS.route;
export const TIER_ROUTE_TITLES = TITLES.route;
export const TIER_AGENT_LABELS = LABELS.agent;
export const TIER_AGENT_TITLES = TITLES.agent;

/** 检索开关的对外快照：关着时 plan 为 null，且 label 报「本地」（与轮换格显示一致）。 */
export function routePlan(on, level) {
  const enabled = on === true;
  const lv = ROUTE_LEVELS.includes(level) ? level : DEFAULT_ROUTE.level;
  return { on: enabled, level: lv, label: LABELS.route[enabled ? lv : "off"], plan: enabled ? ROUTE_PLAN[lv] : null };
}

/** 代理开关的对外快照：关着时只回 on=false，不占每步字。 */
export function agentPlan(on, profile, extra = {}) {
  const enabled = on === true;
  const pf = AGENT_PROFILES.includes(profile) ? profile : DEFAULT_AGENT.profile;
  if (!enabled) return { on: false };
  const plan = AGENT_PLAN[pf];
  return {
    on: true,
    profile: pf,
    label: LABELS.agent[pf],
    maxChildren: plan.maxChildren,
    counterAttacks: plan.counterAttacks,
    isolation: plan.isolation,
    reviewRounds: plan.reviewRounds,
    domains: { ...AGENT_DOMAINS },
    ...extra,
  };
}

/**
 * 「对抗」是独立开关，不是档位：开/关记在会话的 counter 上，密度随档位走。
 * - 思考模式：动手前审方案 + 交付前审改动（scope=plan+delivery）
 * - 循环模式：每轮审改动（scope=round-changes）
 * v3.0.0：对抗默认走独立子代理（异 provider），审者模型与主模型隔离。
 */
export const COUNTER_ATTACKS = { off: 3, high: 3, max: 5 };

export function counterPlan(mode, level, enabled) {
  const on = Boolean(enabled);
  const inLoop = mode === "loop";
  return {
    enabled: on,
    maxAttacks: on ? COUNTER_ATTACKS[level] || COUNTER_ATTACKS.high : 0,
    scope: inLoop ? "round-changes" : "plan+delivery",
    isolation: on ? "subagent-preferred" : "none",
    // v3.7.0：对抗也有可执行清单——审什么、怎么收口、回执长什么样
    steps: on
      ? inLoop
        ? [
            "每轮只审本轮改动，不审历史",
            "三态收口：接受 / 驳回 / 转边界（每条给触发条件、后果、检查方法）",
          ]
        : [
            "动手前审方案：权威性（来源）/ 真实性（数字引语可点）/ 全面性（漏掉的坏场景）",
            "交付前再审改动，只看证据不看解释",
            "三态收口：接受 / 驳回 / 转边界（每条给触发条件、后果、检查方法）",
          ]
      : [],
    ledger: "",
    receipt: on ? "对抗回执：{mode} · {attacks} 条 · 接受 {accepted} · 驳回 {rejected} · 边界 {bounds}" : "",
    receiptWhen: on ? "本轮真提出 ≥1 条对抗条目" : "",
    guard: on ? "审者与主模型同族不算真隔离；代理关着就标「隔离度：低」" : "对抗关：不做额外审查",
  };
}

export const PORT = Number(process.env.DSH_CALIBRATION_PORT || process.env.DSH_CLARIFY_TIER_PORT || 43871);
export const PORT_SPAN = 10; // 43871..43880；两套 DSH 同时开着时靠这段区间避让
export const DSH_HOME = process.env.DSH_HOME || join(homedir(), ".dsh");
export const STATE_FILE = join(DSH_HOME, "storages", "calibration.json");
/** 旧名状态文件：新文件不存在时读它做一次性迁移 */
export const LEGACY_STATE_FILE = join(DSH_HOME, "storages", "clarify-tier.json");
export const MODELS_FILE = join(DSH_HOME, "storages", "calibration-models.json");
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
