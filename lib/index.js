/**
 * dsh-clarify-tier — 宿主半边
 *
 * 一个状态，两个投影：
 *   { mode: "think" | "loop", level: "off" | "high" | "max" }
 *   - mode=think：level 是思考档（关闭 / 严格 / 极限）
 *   - mode=loop ：level 是循环档（轻量 / 交付 / 极限）
 *
 * `clarify_tier` 与 `forge_level` 从同一状态派生；档名、悬停、轮次表只在本文件定义一次，
 * 客户端通过 GET /state 的 labels / titles 取文案。
 *
 * 安全：回环桥只接受本机页面写入（Origin 白名单），POST 必须 application/json。
 *
 * 数据安全：读不出来不覆写。
 *   - 文件不存在 → 用默认值，不建文件（等第一次显式写入）
 *   - 文件是坏 JSON → 返回默认值并标 corrupt，**不写盘**
 *   - 未知 schema（如未来的 6）→ 返回默认值并标 unsupported，**不写盘**
 *   - 只有认识的旧 schema（带 tier / forge）才迁移，迁移前存 .bak，落盘用临时文件 + rename 原子替换
 *   - 写盘失败 → POST 返回 500，不谎报 200
 */
import { createServer } from "node:http";
import { readFileSync, writeFileSync, mkdirSync, renameSync, copyFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

const PACKAGE_ID = "dsh-clarify-tier";
const MODES = ["think", "loop"];
const LEVELS = ["off", "high", "max"];
const DEFAULT_MODE = "think";
const DEFAULT_LEVEL = "high";
const SCHEMA = 5;

/** 唯一事实源：档名、悬停、轮次、评审方式。客户端通过 /state 读这两张表。 */
const LABELS = {
  think: { off: "关闭", high: "严格", max: "极限" },
  loop: { off: "轻量", high: "交付", max: "极限" },
};
const TITLES = {
  think: {
    off: "关闭：不锚定、不循环，直接执行",
    high: "严格：复述 + 2 确认点 + 回滚 + 验收 + 失败分支",
    max: "极限：严格之上再加反例与代价、对抗自检、对抗复审",
  },
  loop: {
    off: "轻量：3 轮纯自检，适合小修小补",
    high: "交付：5 轮，第 2 轮独立评审 + 收敛复核",
    max: "极限：8 轮，第 2 轮起每轮独立评审",
  },
};
const LOOP_PLAN = {
  off: { forge: "lite", maxRounds: 3, review: "纯自检，不做独立评审" },
  high: { forge: "high", maxRounds: 5, review: "第 2 轮一次独立评审 + 收敛轮复核" },
  max: { forge: "max", maxRounds: 8, review: "第 2 轮起每轮独立评审" },
};

// 给测试用：保证客户端兜底文案与宿主表一致（改一处不改另一处会红）。
export const TIER_LABELS = LABELS;
export const TIER_TITLES = TITLES;

const PORT = Number(process.env.DSH_CLARIFY_TIER_PORT || 43871);
const DSH_HOME = process.env.DSH_HOME || join(homedir(), ".dsh");
const STATE_FILE = join(DSH_HOME, "storages", "clarify-tier.json");
const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

/** 只放行本机页面；没有 Origin 的是非浏览器客户端（curl / 测试）。 */
export function originAllowed(origin) {
  if (!origin) return true;
  try {
    const url = new URL(origin);
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
    return LOCAL_HOSTS.has(url.hostname);
  } catch {
    return false;
  }
}

/** 读原始文件，区分「不存在 / 坏 JSON / 能解析」。 */
function readRaw() {
  let text;
  try {
    text = readFileSync(STATE_FILE, "utf8");
  } catch (error) {
    if (error && error.code === "ENOENT") return { missing: true };
    return { corrupt: true };
  }
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { corrupt: true };
    return { data: parsed };
  } catch {
    return { corrupt: true };
  }
}

function isLegacyShape(data) {
  return data.schema !== SCHEMA && (typeof data.tier === "string" || typeof data.forge === "string");
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
  // 旧 low / high 都落到「严格」：low 被删是因为收益太低，不是因为它该等于关闭
  return { mode: DEFAULT_MODE, level: DEFAULT_LEVEL };
}

function defaults(extra = {}) {
  return { mode: DEFAULT_MODE, level: DEFAULT_LEVEL, updatedAt: null, ...extra };
}

/**
 * 读状态。只有「认识的旧 schema」才迁移落盘；坏文件与未知 schema 一律只读，
 * 避免一次 GET 就把用户设置冲掉。
 */
function readState() {
  const raw = readRaw();
  if (raw.missing) return defaults({ source: "default" });
  if (raw.corrupt) return defaults({ source: "corrupt" });

  const data = raw.data;
  const validMode = MODES.includes(data.mode);
  const validLevel = LEVELS.includes(data.level);

  if (data.schema === SCHEMA) {
    if (validMode && validLevel) return { mode: data.mode, level: data.level, updatedAt: data.updatedAt || null };
    // schema 对但字段坏：保留能认的那一半，不回写（等用户拨一下再落盘）
    return {
      mode: validMode ? data.mode : DEFAULT_MODE,
      level: validLevel ? data.level : DEFAULT_LEVEL,
      updatedAt: data.updatedAt || null,
      sanitized: true,
    };
  }

  if (isLegacyShape(data)) {
    const migrated = migrate(data);
    const saved = writeState(migrated, { backup: true });
    if (saved.ok) return { mode: saved.mode, level: saved.level, updatedAt: saved.updatedAt, migrated: true };
    // 迁移写不进去就先用迁移值跑，不把状态卡死
    return { ...migrated, updatedAt: data.updatedAt || null, migrated: true, readOnly: true };
  }

  // 未知 schema（未来版本）或其他结构：只读兜底，绝不覆写
  return defaults({ updatedAt: data.updatedAt || null, source: "unsupported" });
}

/** 当前可识别值，不迁移、不落盘（给 writeState 合并用）。 */
function currentState() {
  const raw = readRaw();
  if (!raw.data) return {};
  const data = raw.data;
  return {
    ...(MODES.includes(data.mode) ? { mode: data.mode } : {}),
    ...(LEVELS.includes(data.level) ? { level: data.level } : {}),
  };
}

/** 原子写：临时文件 + rename；迁移前留 .bak。失败返回 ok:false。 */
function writeState(next, options = {}) {
  const current = currentState();
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
  const tmp = `${STATE_FILE}.tmp`;
  try {
    mkdirSync(dirname(STATE_FILE), { recursive: true });
    if (options.backup && existsSync(STATE_FILE)) {
      copyFileSync(STATE_FILE, `${STATE_FILE}.bak`);
    }
    writeFileSync(tmp, JSON.stringify(payload, null, 2), "utf8");
    renameSync(tmp, STATE_FILE);
  } catch (error) {
    try {
      writeFileSync(tmp, "", "utf8");
    } catch {
      /* 清理临时文件失败可忽略 */
    }
    return { ok: false, error: String(error && error.message ? error.message : error) };
  }
  return { ok: true, ...payload };
}

export function publicState() {
  const state = readState();
  return {
    ...state,
    modes: MODES,
    levels: LEVELS,
    defaultMode: DEFAULT_MODE,
    defaultLevel: DEFAULT_LEVEL,
    labels: LABELS,
    titles: TITLES,
    schema: SCHEMA,
  };
}

function startBridge(log) {
  const server = createServer((req, res) => {
    const origin = req.headers.origin;
    const allowed = originAllowed(origin);
    const headers = {
      ...(allowed && origin ? { "Access-Control-Allow-Origin": origin, Vary: "Origin" } : {}),
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "content-type",
      "Access-Control-Max-Age": "600",
      "Cache-Control": "no-store",
    };

    if (!allowed) {
      res.writeHead(403, { ...headers, "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: "origin not allowed" }));
      return;
    }

    if (req.method === "OPTIONS") {
      res.writeHead(204, headers);
      res.end();
      return;
    }
    if (req.url === "/state" && req.method === "GET") {
      res.writeHead(200, { ...headers, "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(publicState()));
      return;
    }
    if (req.url === "/state" && req.method === "POST") {
      const type = String(req.headers["content-type"] || "").toLowerCase();
      if (!type.startsWith("application/json")) {
        res.writeHead(415, { ...headers, "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: "content-type must be application/json" }));
        return;
      }
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
        const badKey =
          (("mode" in patch) && !MODES.includes(patch.mode)) ||
          (("level" in patch) && !LEVELS.includes(patch.level));
        if (badKey) {
          res.writeHead(400, { ...headers, "content-type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({ error: "invalid mode or level", modes: MODES, levels: LEVELS }));
          return;
        }
        const saved = writeState(patch);
        if (!saved.ok) {
          log(`落盘失败：${saved.error}`);
          res.writeHead(500, { ...headers, "content-type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({ error: "write failed", detail: saved.error }));
          return;
        }
        res.writeHead(200, { ...headers, "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify(saved));
      });
      return;
    }
    res.writeHead(404, headers);
    res.end("not found");
  });
  server.on("error", (error) => log(`桥接端口 ${PORT} 不可用（控件会退化为只读）：${String(error)}`));
  try {
    server.listen(PORT, "127.0.0.1", () => log(`桥接就绪 http://127.0.0.1:${PORT}/state`));
    // 测试进程不该被这条桥挂住；DSH 宿主进程本身常驻，无影响
    if (typeof server.unref === "function") server.unref();
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
          "读取当前档位（思考模式：关闭/严格/极限；循环模式下返回 off，表示不叠加锚定）。开工前若本工具可用先调用；读不到按 high。不要复述结果。",
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
            text: `思考档位 = ${state.level}（${LABELS.think[state.level]}）；关闭表示不介入，严格为默认。`,
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
            label: LABELS.loop[state.level],
            maxRounds: plan.maxRounds,
            review: plan.review,
            updatedAt: state.updatedAt,
            text: `循环档位 = ${plan.forge}（${LABELS.loop[state.level]}：上限 ${plan.maxRounds} 轮，${plan.review}）。`,
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
