/**
 * dsh-calibration-tier — 客户端半边
 *
 * 一根框、两个模式：
 *   思考模式：关 | 严 | 极   ‖ 循环
 *   循环模式：轻 | 交付 | 极致 ‖ 循环（亮起）
 * 右侧「循环」用一条隔离线与三档分开，它是模式开关，不是第四档。
 * 切到循环模式后，前面三格的含义从「问多深」变为「磨几轮」，配色由紫转绿；
 * 循环与对抗同开时，前三级条再转橙（红 + 绿 中和），一眼看出这一轮是「边磨边审」。
 *
 * ── 四条纪律 ───────────────────────────────────────────────────────────
 *  1. **fail-open**：插槽注册失败、桥接不可达，只让控件消失/只读，不连累输入框。
 *  2. **不碰官方 DOM**：不找、不改、不重排官方元素。
 *  3. **不注入消息**：状态只走宿主文件 + `clarify_tier` / `forge_level` 工具。
 *  4. **一格一义**：同一格在两种模式下含义不同，标签与提示必须同步切换，不能留旧标签。
 */
/*
 * id 必须是**包名**（含 @scope），因为 dsh-client-modules 用 package name 当浏览器模块身份。
 * 写成短名会 duplicate factory registration → web boot 失败 → 恢复模式。
 */
window.__ModuleLoader__.load({
  id: "dsh-calibration-tier",
  factory: function (require) {
    var module = { exports: {} };
    var exports = module.exports;

    var React = require("react");
    var hooks = React;

    var PACKAGE_ID = "dsh-calibration";
    var SLOT_NAME = "conversation.input.right";
    var ENTRY_ORDER = 10;
    var LEVELS = ["off", "high", "max"];
    var MODES = ["think", "loop"];
    // 「检索」一个轮换格（v3.5.0）：本地 = 不检索（= 原开关的关），增量/全量 = 开着的两档
    var ROUTE_LEVELS = ["high", "max"];
    var ROUTE_CYCLE = ["off"].concat(ROUTE_LEVELS);
    var DEFAULT_ROUTE_LEVEL = "high";
    // 「代理」一个轮换格（v3.5.0）：默认 = 不派子代理（= 原开关的关），效率/性能 = 开着的两档
    var AGENT_PROFILES = ["efficiency", "performance"];
    var AGENT_CYCLE = ["off"].concat(AGENT_PROFILES);
    var DEFAULT_AGENT_PROFILE = "efficiency";

    /*
     * 文案的唯一事实源在宿主（lib/index.js 的 LABELS / TITLES），客户端通过 GET /state 取。
     * 下面这份只在桥不可达时兜底，保证控件仍可用——不参与“改档名”的维护。
     */
    var FALLBACK_LABELS = {
      think: { off: "常规", high: "严格", max: "极致" },
      loop: { off: "轻量", high: "交付", max: "极致" },
      route: { off: "本地", high: "增量", max: "全量" },
      agent: { off: "默认", efficiency: "效率", performance: "性能" },
    };
    var FALLBACK_TITLES = {
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

    var STORAGE_KEY = "dsh-tier-mode";
    var DEFAULT_MODE = "think";
    var DEFAULT_LEVEL = "high";
    var DEFAULT_SESSION = "default";
    var PORT_BASE = 43871;
    var PORT_SPAN = 10; // 与宿主一致：43871..43880
    var PORT_KEY = "dsh-tier-port";
    var DEBUG_KEY = "dsh-tier-debug";
    var bridgePort = null;

    /*
     * 可调项（测试会改，也别有洞天）：
     * - portMissTtl：一轮 11 个端口全探空后，多久内不再重扫（避免每次点击都打 11 个 fetch）
     * - reconnectDelay / maxReconnects：SSE 判定断开后，隔多久重建、最多重建几次
     * - ownerCheckTtl：发现当前桥不认识本会话时，复核实例的最小间隔
     * - ownerPollMs / ownerPollTries：一直没认领上时，多久重试一次、最多几轮（约 1 分钟）
     * - debug：默认关。开着时每次启动会往宿主写 jsonl，文件没有轮转，别长期开
     */
    var CONFIG = {
      portMissTtl: 3000,
      reconnectDelay: 2000,
      maxReconnects: 3,
      ownerCheckTtl: 3000,
      ownerPollMs: 5000,
      ownerPollTries: 12,
      debug: false,
    };

