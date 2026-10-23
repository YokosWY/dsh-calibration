/**
 * dsh-clarify-tier — 宿主半边
 *
 * 一个状态，两个投影：
 *   { mode: "think" | "loop", level: "off" | "high" | "max" }
 *   - mode=think：level 是思考档（关 / 严 / 极）
 *   - mode=loop ：level 是循环档（轻 / 交付 / 极限）
 *
 * `clarify_tier` 与 `forge_level` 都从这个状态派生，技能侧不用改名字：
 *   - 思考模式下 clarify_tier 返回档位、forge_level 返回 off（不跑循环）
 *   - 循环模式下 clarify_tier 返回 off（不叠加锚定）、forge_level 返回 lite/high/max
 *
 * 职责：落盘、开回环桥、注册两个只读工具。全部 fail-open。
 */
import { createServer } from "node:http";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

const PACKAGE_ID = "dsh-clarify-tier";
const MODES = ["think", "loop"];
const LEVELS = ["off", "high", "max"];
const DEFAULT_MODE = "think";
const DEFAULT_LEVEL = "high";
const SCHEMA = 5;

const THINK_TITLE = { off: "关", high: "严", max: "极限" };
const LOOP_TITLE = { off: "轻", high: "交付", max: "极限" };
const LOOP_PLAN = {
  off: { forge: "lite", maxRounds: 3, review: "纯自检，不做独立评审" },
  high: { forge: "high", maxRounds: 5, review: "第 2 轮一次独立评审 + 收敛轮复核" },
  max: { forge: "max", maxRounds: 8, review: "第 2 轮起每轮独立评审" },
};

const PORT = Number(process.env.DSH_CLARIFY_TIER_PORT || 43871);
const DSH_HOME = process.env.DSH_HOME || join(homedir(), ".dsh");
const STATE_FILE = join(DSH_HOME, "storages", "clarify-tier.json");

function readRaw() {
  try {
    const parsed = JSON.parse(readFileSync(STATE_FILE, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

/** 老 schema（tier + forge 两个字段）迁移到一框双模式。 */
function migrate(parsed) {
  const forge = parsed.forge;
  if (forge === "std" || forge === "max") {
    return { mode: "loop", level: forge === "std" ? "high" : "max" };
  }
  const tier = parsed.tier;
  if (tier === "max") return { mode: "think", level: "max" };
  if (tier === "off") return { mode: "think", level: "off" };
  // 旧 low / high 都落到「严」：low 被删是因为收益太低，不是因为它该等于关闭
  return { mode: DEFAULT_MODE, level: DEFAULT_LEVEL };
}

function readState() {
  const parsed = readRaw();
  const modeOk = MODES.includes(parsed.mode);
  const levelOk = LEVELS.includes(parsed.level);
  if (parsed.schema === SCHEMA && modeOk && levelOk) {
    return { mode: parsed.mode, level: parsed.level, updatedAt: parsed.updatedAt || null };
  }
  const migrated = migrate(parsed);
  const saved = writeState(migrated);
  return { mode: saved.mode, level: saved.level, updatedAt: saved.updatedAt, migrated: true };
}

function writeState(next) {
  const current = readStateQuiet();
  const payload = {
    mode: MODES.includes(next && next.mode)
      ? next.mode
      : MODES.includes(current.mode)
        ? current.mode
        : DEFAULT_MODE,
    level: LEVELS.includes(next && next.level)
      ? next.level
      : LEVELS.includes(current.level)
        ? current.level
        : DEFAULT_LEVEL,
    updatedAt: new Date().toISOString(),
    schema: SCHEMA,
  };
  try {
    mkdirSync(dirname(STATE_FILE), { recursive: true });
    writeFileSync(STATE_FILE, JSON.stringify(payload, null, 2), "utf8");
  } catch {
    /* 落盘失败不影响内存值 */
  }
  return payload;
}

/** 读当前值但不触发迁移（避免 writeState 内部递归）。 */
function readStateQuiet() {
  const parsed = readRaw();
  if (parsed.schema === SCHEMA && MODES.includes(parsed.mode) && LEVELS.includes(parsed.level)) {
    return { mode: parsed.mode, level: parsed.level };
  }
  return migrate(parsed);
}

function startBridge(log) {
  const server = createServer((req, res) => {
    const cors = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "content-type",
      "Access-Control-Max-Age": "600",
      "Cache-Control": "no-store",
    };
    if (req.method === "OPTIONS") {
      res.writeHead(204, cors);
      res.end();
      return;
    }
    if (req.url === "/state" && req.method === "GET") {
      res.writeHead(200, { ...cors, "content-type": "application/json; charset=utf-8" });
      res.end(
        JSON.stringify({
          ...readState(),
          modes: MODES,
          levels: LEVELS,
          defaultMode: DEFAULT_MODE,
          defaultLevel: DEFAULT_LEVEL,
          schema: SCHEMA,
        }),
      );
      return;
    }
    if (req.url === "/state" && req.method === "POST") {
      let body = "";
      req.on("data", (chunk) => {
        body += chunk;
        if (body.length > 4096) req.destroy();
      });
      req.on("end", () => {
        let patch = {};
        try {
          patch = JSON.parse(body || "{}") || {};
        } catch {
          /* 忽略坏 JSON */
        }
        const saved = writeState({
          ...(typeof patch.mode === "string" ? { mode: patch.mode } : {}),
          ...(typeof patch.level === "string" ? { level: patch.level } : {}),
        });
        res.writeHead(200, { ...cors, "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify(saved));
      });
      return;
    }
    res.writeHead(404, cors);
    res.end("not found");
  });
  server.on("error", (error) => log(`桥接端口 ${PORT} 不可用（控件会退化为只读）：${String(error)}`));
  try {
    server.listen(PORT, "127.0.0.1", () => log(`桥接就绪 http://127.0.0.1:${PORT}/state`));
  } catch (error) {
    log(`桥接启动失败：${String(error)}`);
  }
  return server;
}

// 访问 ctx.tools 前必须声明注入，否则工具注册不上。
export const inject = ["tools"];

export function apply(ctx) {
  let log = () => {};
  try {
    const candidate = ctx && ctx.logger;
    const sink = typeof candidate === "function" ? candidate(PACKAGE_ID) : candidate;
    log = (message) => {
      try {
        if (sink && typeof sink.info === "function") sink.info(`[${PACKAGE_ID}] ${message}`);
        else console.info(`[${PACKAGE_ID}] ${message}`);
      } catch {
        /* 日志也不许抛 */
      }
    };
  } catch {
    /* 没有 logger 就静默 */
  }

  let server = null;
  try {
    server = startBridge(log);
  } catch (error) {
    log(`桥接未启动：${String(error)}`);
  }

  try {
    if (ctx && ctx.effect) {
      ctx.effect(() => () => {
        try {
          if (server) server.close();
        } catch {
          /* 关不掉也不影响退出 */
        }
      });
    }
  } catch {
    /* dispose 挂钩失败可忽略 */
  }

  try {
    if (ctx && ctx.tools && typeof ctx.tools.register === "function") {
      ctx.tools.register({
        name: "clarify_tier",
        description:
          "读取当前档位（思考模式：关/严/极限；循环模式下返回 off，表示不叠加锚定）。开工前若本工具可用先调用；读不到按 high。不要复述结果。",
        parameters: { type: "object", properties: {}, additionalProperties: false },
        output: {
          schema: { type: "object", additionalProperties: true },
          render: (args, value) => [{ type: "text", text: String(value && value.text ? value.text : "") }],
        },
        execute: async () => {
          const state = readState();
          if (state.mode === "loop") {
            return {
              tier: "off",
              mode: state.mode,
              updatedAt: state.updatedAt,
              text: "当前是循环模式：不叠加思考档（判据在循环第 1 步写）；需要强提问就先退回思考档。",
            };
          }
          return {
            tier: state.level,
            mode: state.mode,
            updatedAt: state.updatedAt,
            text: `思考档位 = ${state.level}（${THINK_TITLE[state.level]}）；off 表示不介入，high 为默认。`,
          };
        },
      });
      log("clarify_tier 工具已注册");

      ctx.tools.register({
        name: "forge_level",
        description:
          "读取循环档位：未进循环模式返回 off；循环模式下返回 lite（3 轮）/ high（5 轮）/ max（8 轮）。跑 loop-forge 前先调用。不要复述结果。",
        parameters: { type: "object", properties: {}, additionalProperties: false },
        output: {
          schema: { type: "object", additionalProperties: true },
          render: (args, value) => [{ type: "text", text: String(value && value.text ? value.text : "") }],
        },
        execute: async () => {
          const state = readState();
          if (state.mode !== "loop") {
            return {
              forge: "off",
              mode: state.mode,
              maxRounds: 0,
              review: "未进入循环模式",
              updatedAt: state.updatedAt,
              text: "未进入循环模式：交付后不自动打磨（要打磨就把模式拨到「循环」）。",
            };
          }
          const plan = LOOP_PLAN[state.level] || LOOP_PLAN.high;
          return {
            forge: plan.forge,
            mode: state.mode,
            level: state.level,
            label: LOOP_TITLE[state.level],
            maxRounds: plan.maxRounds,
            review: plan.review,
            updatedAt: state.updatedAt,
            text: `循环档位 = ${plan.forge}（${LOOP_TITLE[state.level]}：上限 ${plan.maxRounds} 轮，${plan.review}）。`,
          };
        },
      });
      log("forge_level 工具已注册");
    } else {
      log("ctx.tools 不可用，工具未注册（档位仍可通过桥接读写）");
    }
  } catch (error) {
    log(`工具注册失败（模型将只能按默认档位）：${String(error)}`);
  }
}

export default { apply, inject };
