/**
 * dsh-clarify-tier — 宿主半边
 *
 * 每个对话各用各的档位（v0.7.0）：
 *   { schema: 6, sessions: { "<sessionId>": { mode, level, updatedAt } } }
 *   - mode=think：level 是思考档（关闭 / 严格 / 极限）
 *   - mode=loop ：level 是循环档（轻量 / 交付 / 极限）
 *
 * 会话键来源：
 *   - 客户端：插槽 inject 给到的 sessionId，走 `?session=` 传到桥
 *   - 工具：`exec.agent.session.id`（DSH 工具执行上下文），读不到才落到 default
 *
 * 档名、悬停、轮次表只在本文件定义一次，客户端通过 GET /state 的 labels / titles 取文案。
 *
 * 安全：回环桥只接受本机页面写入（Origin 白名单），POST 必须 application/json。
 * 数据安全：坏 JSON / 未知 schema / 字段坏一律只读兜底，不覆写；迁移前 .bak；tmp+rename 原子写；写失败 500。
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
const SCHEMA = 6;
const DEFAULT_SESSION = "default";
const SESSION_LIMIT = 100;

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

// 给测试用：保证客户端兜底文案与宿主表一致。
export const TIER_LABELS = LABELS;
export const TIER_TITLES = TITLES;

const PORT = Number(process.env.DSH_CLARIFY_TIER_PORT || 43871);
const DSH_HOME = process.env.DSH_HOME || join(homedir(), ".dsh");
const STATE_FILE = join(DSH_HOME, "storages", "clarify-tier.json");
const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

export function originAllowed(origin) {
  if (!origin) return true;
  try {
    const url = new URL(origin);
    // Web 客户端的真实 Origin 是自定义协议 dsh-app://app，不是 127.0.0.1
    if (url.protocol === "dsh-app:") return true;
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
    return LOCAL_HOSTS.has(url.hostname);
  } catch {
    return false;
  }
}

export function sanitizeSession(id) {
  if (typeof id !== "string") return DEFAULT_SESSION;
  const trimmed = id.trim().slice(0, 128);
  return trimmed || DEFAULT_SESSION;
}

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

/** 老 schema 的全局档位（tier/forge 或 mode/level）迁移成 default 会话。 */
function migrateLegacy(data) {
  const forge = data.forge;
  if (forge === "std" || forge === "max") {
    return { mode: "loop", level: forge === "std" ? "high" : "max" };
  }
  if (MODES.includes(data.mode) && LEVELS.includes(data.level)) {
    return { mode: data.mode, level: data.level };
  }
  const tier = data.tier;
  if (tier === "max") return { mode: "think", level: "max" };
  if (tier === "off") return { mode: "think", level: "off" };
  return { mode: DEFAULT_MODE, level: DEFAULT_LEVEL };
}

function normalizeTurn(turn) {
  if (!turn || typeof turn !== "object" || Array.isArray(turn)) return null;
  if (!MODES.includes(turn.mode) || !LEVELS.includes(turn.level)) return null;
  return {
    id: typeof turn.id === "string" ? turn.id : null,
    mode: turn.mode,
    level: turn.level,
    at: turn.at || null,
  };
}

function normalizeEntry(entry) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
  if (!MODES.includes(entry.mode) || !LEVELS.includes(entry.level)) return null;
  return {
    mode: entry.mode,
    level: entry.level,
    updatedAt: entry.updatedAt || null,
    turn: normalizeTurn(entry.turn),
  };
}

function defaults(extra = {}) {
  return { mode: DEFAULT_MODE, level: DEFAULT_LEVEL, updatedAt: null, ...extra };
}

/**
 * 读整个 store。只有「认识的旧结构」才迁移落盘；坏文件与未知 schema 只读兜底。
 * 返回 { sessions, corrupt?, unsupported? }
 */
function readStore() {
  const raw = readRaw();
  if (raw.missing) return { sessions: {} };
  if (raw.corrupt) return { sessions: {}, corrupt: true };

  const data = raw.data;
  if (data.schema === SCHEMA && data.sessions && typeof data.sessions === "object") {
    const sessions = {};
    for (const [id, entry] of Object.entries(data.sessions)) {
      const normalized = normalizeEntry(entry);
      if (normalized) sessions[sanitizeSession(id)] = normalized;
    }
    return { sessions };
  }

  // 只有「没有 schema」或「schema 小于当前版本」的老文件才迁移；
  // 未来版本（如 schema:9）哪怕带着旧字段也不许降级覆盖
  const knownLegacySchema = data.schema === undefined || (Number.isInteger(data.schema) && data.schema < SCHEMA);
  const looksLegacy =
    knownLegacySchema &&
    ("tier" in data || "forge" in data || "mode" in data || "level" in data || "sessions" in data);
  if (looksLegacy) {
    const migrated = migrateLegacy(data);
    const store = { sessions: { [DEFAULT_SESSION]: { ...migrated, updatedAt: data.updatedAt || null } } };
    const saved = writeStore(store, { backup: true });
    if (saved.ok) return store;
    return { ...store, readOnly: true };
  }

  return { sessions: {}, unsupported: true };
}

/** 当前会话的值；没有就用 default 会话，再没有就用内置默认（不写盘）。 */
function sessionState(store, id) {
  const entry = store.sessions[id];
  if (entry) {
    return {
      mode: entry.mode,
      level: entry.level,
      updatedAt: entry.updatedAt || null,
      turn: entry.turn || null,
    };
  }
  const base = store.sessions[DEFAULT_SESSION];
  if (base) {
    return { mode: base.mode, level: base.level, updatedAt: base.updatedAt || null, turn: null, inherited: true };
  }
  return defaults({ inherited: true, turn: null });
}

function atomicWrite(payload) {
  const tmp = `${STATE_FILE}.tmp`;
  try {
    mkdirSync(dirname(STATE_FILE), { recursive: true });
    writeFileSync(tmp, JSON.stringify(payload, null, 2), "utf8");
    renameSync(tmp, STATE_FILE);
    return { ok: true };
  } catch (error) {
    try {
      writeFileSync(tmp, "", "utf8");
    } catch {
      /* 清理临时文件失败可忽略 */
    }
    return { ok: false, error: String(error && error.message ? error.message : error) };
  }
}

function writeStore(store, options = {}) {
  const payload = { schema: SCHEMA, sessions: store.sessions, updatedAt: new Date().toISOString() };
  if (options.backup && existsSync(STATE_FILE)) {
    try {
      copyFileSync(STATE_FILE, `${STATE_FILE}.bak`);
    } catch {
      /* 备份失败不阻断迁移 */
    }
  }
  return atomicWrite(payload);
}

function writeSession(id, patch, options = {}) {
  const store = readStore();
  if (store.unsupported) return { ok: false, error: "unsupported schema" };
  const current = sessionState(store, id);
  const now = new Date().toISOString();
  const next = {
    mode: MODES.includes(patch && patch.mode) ? patch.mode : current.mode,
    level: LEVELS.includes(patch && patch.level) ? patch.level : current.level,
    updatedAt: now,
    turn: options.turn !== undefined ? normalizeTurn(options.turn) : current.turn || null,
  };
  store.sessions[id] = next;

  const ids = Object.keys(store.sessions);
  if (ids.length > SESSION_LIMIT) {
    ids
      .filter((key) => key !== DEFAULT_SESSION)
      .sort((a, b) => String(store.sessions[a].updatedAt).localeCompare(String(store.sessions[b].updatedAt)))
      .slice(0, ids.length - SESSION_LIMIT)
      .forEach((key) => delete store.sessions[key]);
  }

  const saved = writeStore(store);
  if (!saved.ok) return saved;
  return { ok: true, session: id, ...next };
}

export function publicState(sessionId) {
  const id = sanitizeSession(sessionId);
  const store = readStore();
  const state = sessionState(store, id);
  const pending = Boolean(state.turn && (state.turn.mode !== state.mode || state.turn.level !== state.level));
  return {
    session: id,
    ...state,
    pending,
    turnLocked: Boolean(state.turn),
    sessions: Object.keys(store.sessions).length,
    modes: MODES,
    levels: LEVELS,
    defaultMode: DEFAULT_MODE,
    defaultLevel: DEFAULT_LEVEL,
    labels: LABELS,
    titles: TITLES,
    schema: SCHEMA,
    ...(store.corrupt ? { corrupt: true } : {}),
    ...(store.unsupported ? { unsupported: true } : {}),
  };
}

/** 从工具执行上下文取本轮 id；取不到返回 null（此时不做轮内保护）。 */
export function turnIdFromExec(exec) {
  try {
    const turn = exec && exec.agent && exec.agent.session && exec.agent.session.turn;
    if (typeof turn === "string") return turn;
    if (turn && typeof turn === "object") {
      if (typeof turn.id === "string") return turn.id;
      if (turn.turn && typeof turn.turn.id === "string") return turn.turn.id;
    }
  } catch {
    /* 忽略 */
  }
  return null;
}

/**
 * 工具侧读状态：同一轮里用「本轮开工时」的快照，轮间点击只改下轮的值。
 * 轮 id 取不到时退回实时值（不做轮内保护，但功能不坏）。
 */
function turnState(sessionId, turnId) {
  const store = readStore();
  const current = sessionState(store, sessionId);
  if (!turnId) return { ...current, turnLocked: false, pending: false };
  if (current.turn && current.turn.id === turnId) {
    const pending = current.turn.mode !== current.mode || current.turn.level !== current.level;
    return { mode: current.turn.mode, level: current.turn.level, updatedAt: current.updatedAt, turnLocked: true, pending };
  }
  const snapshot = { id: turnId, mode: current.mode, level: current.level, at: new Date().toISOString() };
  const saved = writeSession(sessionId, {}, { turn: snapshot });
  if (saved.ok) {
    broadcaster(sessionId, {
      session: sessionId,
      mode: snapshot.mode,
      level: snapshot.level,
      pending: false,
      turnLocked: true,
      updatedAt: saved.updatedAt,
    });
  }
  return { mode: snapshot.mode, level: snapshot.level, updatedAt: saved.updatedAt || current.updatedAt, turnLocked: true, pending: false };
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

function startBridge(log) {
  /** session → Set<res>；只在同一会话的窗口之间同步。 */
  const streams = new Map();
  function broadcast(sessionId, state) {
    const bucket = streams.get(sessionId);
    if (!bucket) return;
    const frame = `data: ${JSON.stringify(state)}\n\n`;
    for (const client of bucket) {
      try {
        client.write(frame);
      } catch {
        bucket.delete(client);
      }
    }
  }
  broadcaster = broadcast;
  const heartbeat = setInterval(() => {
    for (const bucket of streams.values()) {
      for (const client of bucket) {
        try {
          client.write(": ping\n\n");
        } catch {
          bucket.delete(client);
        }
      }
    }
  }, 25000);
  if (typeof heartbeat.unref === "function") heartbeat.unref();

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

    let url;
    try {
      url = new URL(req.url, "http://127.0.0.1");
    } catch {
      res.writeHead(400, { ...headers, "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: "bad url" }));
      return;
    }
    const sessionId = sanitizeSession(url.searchParams.get("session"));

    if (req.method === "OPTIONS") {
      res.writeHead(204, headers);
      res.end();
      return;
    }
    if (url.pathname === "/events" && req.method === "GET") {
      res.writeHead(200, {
        ...headers,
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-store",
        connection: "keep-alive",
      });
      res.write("retry: 2000\n\n");
      res.write(`data: ${JSON.stringify(publicState(sessionId))}\n\n`);
      if (!streams.has(sessionId)) streams.set(sessionId, new Set());
      streams.get(sessionId).add(res);
      req.on("close", () => {
        const bucket = streams.get(sessionId);
        if (!bucket) return;
        bucket.delete(res);
        if (bucket.size === 0) streams.delete(sessionId);
      });
      return;
    }
    if (url.pathname === "/debug" && req.method === "POST") {
      let raw = "";
      req.on("data", (chunk) => {
        raw += chunk;
        if (raw.length > 8192) req.destroy();
      });
      req.on("end", () => {
        try {
          const line = `{"at":"${new Date().toISOString()}","body":${raw.slice(0, 4000)}}
`;
          writeFileSync(join(dirname(STATE_FILE), "clarify-tier-debug.jsonl"), line, { flag: "a" });
          log(`debug: ${raw.slice(0, 400)}`);
        } catch (error) {
          log(`debug 写入失败：${String(error)}`);
        }
        res.writeHead(204, headers);
        res.end();
      });
      return;
    }
    if (url.pathname === "/state" && req.method === "GET") {
      res.writeHead(200, { ...headers, "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(publicState(sessionId)));
      return;
    }
    if (url.pathname === "/state" && req.method === "POST") {
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
        let patch;
        try {
          patch = body.trim() === "" ? {} : JSON.parse(body);
        } catch {
          res.writeHead(400, { ...headers, "content-type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({ error: "invalid JSON" }));
          return;
        }
        const isObject = patch && typeof patch === "object" && !Array.isArray(patch);
        if (!isObject) {
          res.writeHead(400, { ...headers, "content-type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({ error: "body must be a JSON object" }));
          return;
        }
        const badKey =
          (("mode" in patch) && !MODES.includes(patch.mode)) ||
          (("level" in patch) && !LEVELS.includes(patch.level));
        if (badKey) {
          res.writeHead(400, { ...headers, "content-type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({ error: "invalid mode or level", modes: MODES, levels: LEVELS }));
          return;
        }
        const saved = writeSession(sessionId, patch);
        if (!saved.ok) {
          log(`落盘失败（${sessionId}）：${saved.error}`);
          res.writeHead(500, { ...headers, "content-type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({ error: "write failed", detail: saved.error }));
          return;
        }
        const current = sessionState(readStore(), sessionId);
        broadcast(sessionId, {
          session: sessionId,
          mode: saved.mode,
          level: saved.level,
          pending: Boolean(current.turn && (current.turn.mode !== saved.mode || current.turn.level !== saved.level)),
          turnLocked: Boolean(current.turn),
          updatedAt: saved.updatedAt,
        });
        res.writeHead(200, { ...headers, "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify(saved));
      });
      return;
    }
    res.writeHead(404, headers);
    res.end("not found");
  });
  server.on("error", (error) => log(`桥接端口 ${PORT} 不可用（控件会退化为只读）：${String(error)}`));
  server.on("close", () => {
    clearInterval(heartbeat);
    for (const bucket of streams.values()) {
      for (const client of bucket) {
        try {
          client.end();
        } catch {
          /* 忽略 */
        }
      }
    }
    streams.clear();
  });
  try {
    server.listen(PORT, "127.0.0.1", () => log(`桥接就绪 http://127.0.0.1:${PORT}/state`));
    if (typeof server.unref === "function") server.unref();
  } catch (error) {
    log(`桥接启动失败：${String(error)}`);
  }
  return server;
}

// 访问 ctx.tools 前必须声明注入，否则工具注册不上。
/** 由 startBridge 注入，供工具（解锁/加锁）主动广播。 */
let broadcaster = () => {};

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
          "读取当前对话的档位（思考模式：关闭/严格/极限；循环模式下返回 off，表示不叠加锚定）。开工前若本工具可用先调用；读不到按 high。不要复述结果。",
        parameters: { type: "object", properties: {}, additionalProperties: false },
        output: {
          schema: { type: "object", additionalProperties: true },
          render: (args, value) => [{ type: "text", text: String(value && value.text ? value.text : "") }],
        },
        execute: async (args, exec) => {
          const sessionId = sessionFromExec(exec);
          const state = turnState(sessionId, turnIdFromExec(exec));
          if (state.mode === "loop") {
            return {
              tier: "off",
              mode: state.mode,
              session: sessionId,
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
            turnLocked: state.turnLocked,
            pending: state.pending,
            updatedAt: state.updatedAt,
            text: `思考档位 = ${state.level}（${LABELS.think[state.level]}）；关闭表示不介入，严格为默认。`,
          };
        },
      });
      log("clarify_tier 工具已注册");

      ctx.tools.register({
        name: "forge_level",
        description:
          "读取当前对话的循环档位：未进循环模式返回 off；循环模式下返回 lite（3 轮）/ high（5 轮）/ max（8 轮）。跑 loop-forge 前先调用。不要复述结果。",
        parameters: { type: "object", properties: {}, additionalProperties: false },
        output: {
          schema: { type: "object", additionalProperties: true },
          render: (args, value) => [{ type: "text", text: String(value && value.text ? value.text : "") }],
        },
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
            session: sessionId,
            turnLocked: state.turnLocked,
            pending: state.pending,
            maxRounds: plan.maxRounds,
            review: plan.review,
            updatedAt: state.updatedAt,
            text: `循环档位 = ${plan.forge}（${LABELS.loop[state.level]}：上限 ${plan.maxRounds} 轮，${plan.review}）。`,
          };
        },
      });
      log("forge_level 工具已注册");

      ctx.tools.register({
        name: "debug_probe",
        description: "临时诊断：回传工具执行上下文的字段名，用于定位 turn id。",
        parameters: { type: "object", properties: {}, additionalProperties: false },
        output: {
          schema: { type: "object", additionalProperties: true },
          render: (args, value) => [{ type: "text", text: String(value && value.text ? value.text : "") }],
        },
        execute: async (args, exec) => {
          const keys = (obj) => (obj && typeof obj === "object" ? Object.keys(obj).slice(0, 30) : typeof obj);
          const agent = exec && exec.agent;
          const session = agent && agent.session;
          const turn = session && session.turn;
          const info = {
            exec: keys(exec),
            agent: keys(agent),
            session: keys(session),
            sessionId: session && session.id,
            agentId: agent && agent.id,
            phase: agent && agent.phase,
            attempt: agent && agent.assistantAttemptCounter,
            loopCtx: keys(agent && agent.loopCtx),
            loopCtxRaw: (() => {
              try {
                const lc = agent && agent.loopCtx;
                if (!lc) return null;
                const out = {};
                for (const k of Object.keys(lc)) {
                  const v = lc[k];
                  if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") out[k] = v;
                }
                return out;
              } catch {
                return "err";
              }
            })(),
            runtime: keys(agent && agent.runtimeContext),
            runtimeRaw: (() => {
              try {
                const rc = agent && agent.runtimeContext;
                if (!rc) return null;
                const out = {};
                for (const k of Object.keys(rc)) {
                  const v = rc[k];
                  if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") out[k] = v;
                }
                return out;
              } catch {
                return "err";
              }
            })(),
            callId: exec && exec.callId,
            rootCallId: exec && exec.rootCallId,
            turn: turn && typeof turn === "object" ? keys(turn) : typeof turn,
          };
          return { ...info, text: JSON.stringify(info) };
        },
      });
      log("debug_probe 工具已注册");

    } else {
      log("ctx.tools 不可用，工具未注册（档位仍可通过桥接读写）");
    }
  } catch (error) {
    log(`工具注册失败（模型将只能按默认档位）：${String(error)}`);
  }
}

export default { apply, inject };
