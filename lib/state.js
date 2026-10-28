/**
 * dsh-calibration-tier — 状态文件（读写、迁移、兜底）
 *
 * 一条纪律：坏文件与未知 schema **只读兜底、绝不覆写**；只有认得出是老结构时才迁移落盘。
 * 写盘一律临时文件 + rename，失败返回 `{ ok:false }`，让上层如实回 500。
 */
import { readFileSync, writeFileSync, mkdirSync, renameSync, copyFileSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import {
  PACKAGE_ID,
  MODES,
  LEVELS,
  ROUTE_LEVELS,
  AGENT_PROFILES,
  LABELS,
  TITLES,
  DEFAULT_MODE,
  DEFAULT_LEVEL,
  DEFAULT_ROUTE,
  DEFAULT_AGENT,
  SCHEMA,
  DEFAULT_SESSION,
  SESSION_LIMIT,
  STATE_FILE,
  LEGACY_STATE_FILE,
  sanitizeSession,
} from "./core.js";

function readRaw() {
  let text;
  try {
    text = readFileSync(STATE_FILE, "utf8");
  } catch (error) {
    if (error && error.code !== "ENOENT") return { corrupt: true };
    // 改名（clarify-tier → calibration）后的第一次读取：旧文件还在就迁过来
    try {
      text = readFileSync(LEGACY_STATE_FILE, "utf8");
      return { data: JSON.parse(text), legacyPath: LEGACY_STATE_FILE };
    } catch {
      return { missing: true };
    }
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

function normalizeRoute(route) {
  const src = route && typeof route === "object" && !Array.isArray(route) ? route : {};
  // v3.0.0 起只有「增量/全量」两档；旧值 off（本地）读进来一律归到 high，不再合法
  return {
    on: src.on === true,
    level: ROUTE_LEVELS.includes(src.level) ? src.level : DEFAULT_ROUTE.level,
  };
}

/** 「代理」开关（v9 新增）：关着时 profile 仍记着，来回切不用重选。 */
function normalizeAgent(agent) {
  const src = agent && typeof agent === "object" && !Array.isArray(agent) ? agent : {};
  return {
    on: src.on === true,
    profile: AGENT_PROFILES.includes(src.profile) ? src.profile : DEFAULT_AGENT.profile,
  };
}

function normalizeTurn(turn) {
  if (!turn || typeof turn !== "object" || Array.isArray(turn)) return null;
  if (!MODES.includes(turn.mode) || !LEVELS.includes(turn.level)) return null;
  return {
    id: typeof turn.id === "string" ? turn.id : null,
    mode: turn.mode,
    level: turn.level,
    counter: turn.counter === true,
    // v8 新增：检索开关与档位（关着时 level 仍记，来回切不用重选）
    route: normalizeRoute(turn.route),
    // v9 新增：代理开关与效率/性能档（同一轮里冻结，点一下下一轮生效）
    agent: normalizeAgent(turn.agent),
    at: turn.at || null,
  };
}

function normalizeEntry(entry) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
  if (!MODES.includes(entry.mode) || !LEVELS.includes(entry.level)) return null;
  return {
    mode: entry.mode,
    level: entry.level,
    // 「对抗」是独立开关（v7 新增）；老会话没有这个字段 = 关
    counter: entry.counter === true,
    // 「检索」是第三个开关（v8 新增）；老会话没有 = 关，档位取默认「增量」
    route: normalizeRoute(entry.route),
    // 「代理」是第四个开关（v9 新增）；老会话没有 = 关，档位默认「效率」
    agent: normalizeAgent(entry.agent),
    updatedAt: entry.updatedAt || null,
    turn: normalizeTurn(entry.turn),
    // 谁写的：'tool' 表示本实例的工具为这个会话落过盘（认领实例的唯一依据，客户端写改不了它）
    owner: entry.owner === "tool" ? "tool" : entry.owner === "client" ? "client" : null,
  };
}

function defaults(extra = {}) {
  return {
    mode: DEFAULT_MODE,
    level: DEFAULT_LEVEL,
    counter: false,
    route: normalizeRoute(DEFAULT_ROUTE),
    agent: normalizeAgent(DEFAULT_AGENT),
    updatedAt: null,
    ...extra,
  };
}

/**
 * 读整个 store。只有「认识的旧结构」才迁移落盘；坏文件与未知 schema 只读兜底。
 * 返回 { sessions, corrupt?, unsupported? }
 */
export function readStore() {
  const raw = readRaw();
  if (raw.missing) return { sessions: {} };
  if (raw.corrupt) return { sessions: {}, corrupt: true };

  const data = raw.data;
  const isCurrent = data.schema === SCHEMA;
  const isV8 = data.schema === 8; // v8 → v9：补 agent:{on:false,profile:"efficiency"}，并把 route.level 的 off 归 high
  const isV7 = data.schema === 7; // v7 → v9：再多一个 route
  const isV6 = data.schema === 6; // v6 → v9：再多一个 counter
  const fromLegacyFile = Boolean(raw.legacyPath); // 旧文件名（clarify-tier.json）读来的，要落到新名字
  if ((isCurrent || isV8 || isV7 || isV6) && data.sessions && typeof data.sessions === "object") {
    const sessions = {};
    for (const [id, entry] of Object.entries(data.sessions)) {
      const normalized = normalizeEntry(entry);
      if (normalized) sessions[sanitizeSession(id)] = normalized;
    }
    const store = { sessions };
    if (isV6 || isV7 || isV8 || fromLegacyFile) {
      const saved = writeStore(store, { backup: true });
      if (!saved.ok) return { ...store, readOnly: true };
    }
    return store;
  }

  // 只有「没有 schema」或「schema 小于当前版本」的老文件才迁移；
  // 未来版本（如 schema:9）哪怕带着旧字段也不许降级覆盖
  const knownLegacySchema = data.schema === undefined || (Number.isInteger(data.schema) && data.schema < SCHEMA);
  const looksLegacy =
    knownLegacySchema && ("tier" in data || "forge" in data || "mode" in data || "level" in data || "sessions" in data);
  if (looksLegacy) {
    const migrated = migrateLegacy(data);
    const entry = normalizeEntry({ ...migrated, updatedAt: data.updatedAt || null }) || defaults();
    const store = { sessions: { [DEFAULT_SESSION]: entry } };
    const saved = writeStore(store, { backup: true });
    if (saved.ok) return store;
    return { ...store, readOnly: true };
  }

  return { sessions: {}, unsupported: true };
}

/** 当前会话的值；没有就用 default 会话，再没有就用内置默认（不写盘）。 */
export function sessionState(store, id) {
  const entry = store.sessions[id];
  if (entry) {
    return {
      mode: entry.mode,
      level: entry.level,
      counter: entry.counter === true,
      route: normalizeRoute(entry.route),
      agent: normalizeAgent(entry.agent),
      updatedAt: entry.updatedAt || null,
      turn: entry.turn || null,
    };
  }
  const base = store.sessions[DEFAULT_SESSION];
  if (base) {
    return {
      mode: base.mode,
      level: base.level,
      counter: base.counter === true,
      route: normalizeRoute(base.route),
      agent: normalizeAgent(base.agent),
      updatedAt: base.updatedAt || null,
      turn: null,
      inherited: true,
    };
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

export function writeStore(store, options = {}) {
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

export function writeSession(id, patch, options = {}) {
  const store = readStore();
  if (store.unsupported) return { ok: false, error: "unsupported schema" };
  const current = sessionState(store, id);
  const currentEntry = store.sessions[id];
  const now = new Date().toISOString();
  const patchRoute = patch && patch.route && typeof patch.route === "object" && !Array.isArray(patch.route) ? patch.route : {};
  const patchAgent = patch && patch.agent && typeof patch.agent === "object" && !Array.isArray(patch.agent) ? patch.agent : {};
  const next = {
    mode: MODES.includes(patch && patch.mode) ? patch.mode : current.mode,
    level: LEVELS.includes(patch && patch.level) ? patch.level : current.level,
    counter: typeof (patch && patch.counter) === "boolean" ? patch.counter : current.counter === true,
    // 检索开关：只认显式传的字段，没传就沿用；档位一直记着，关掉再开不用重选
    route: {
      on: typeof patchRoute.on === "boolean" ? patchRoute.on : current.route.on,
      level: ROUTE_LEVELS.includes(patchRoute.level) ? patchRoute.level : current.route.level,
    },
    // 代理开关：同理，profile 记着，来回切不用重选
    agent: {
      on: typeof patchAgent.on === "boolean" ? patchAgent.on : current.agent.on,
      profile: AGENT_PROFILES.includes(patchAgent.profile) ? patchAgent.profile : current.agent.profile,
    },
    updatedAt: now,
    turn: options.turn !== undefined ? normalizeTurn(options.turn) : current.turn || null,
    // owner 只升不降：一旦本实例的工具认领过这个会话，客户端再写也改不掉
    owner:
      options.owner === "tool" || (currentEntry && currentEntry.owner === "tool")
        ? "tool"
        : options.owner === "client" || (currentEntry && currentEntry.owner === "client")
          ? "client"
          : null,
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

/** 给 HTTP 层与工具用的快照：含 pending（本轮快照与当前值不一致）与 turnLocked。 */
export function publicState(sessionId) {
  const id = sanitizeSession(sessionId);
  const store = readStore();
  const state = sessionState(store, id);
  const pending = Boolean(
    state.turn &&
      (state.turn.mode !== state.mode ||
        state.turn.level !== state.level ||
        state.turn.counter !== (state.counter === true) ||
        state.turn.route.on !== state.route.on ||
        state.turn.route.level !== state.route.level ||
        state.turn.agent.on !== state.agent.on ||
        state.turn.agent.profile !== state.agent.profile),
  );
  return {
    plugin: PACKAGE_ID,
    session: id,
    ...state,
    pending,
    turnLocked: Boolean(state.turn),
    // 只有本实例的**工具**为该会话落过盘才算「认识」：客户端写（owner=client）不算，
    // 否则连错实例后随便点一下就会把这个会话写进对方文件，认领信号被污染。
    knownSession: Boolean(store.sessions[id] && store.sessions[id].owner === "tool"),
    sessions: Object.keys(store.sessions).length,
    modes: MODES,
    levels: LEVELS,
    routeLevels: ROUTE_LEVELS,
    agentProfiles: AGENT_PROFILES,
    defaultMode: DEFAULT_MODE,
    defaultLevel: DEFAULT_LEVEL,
    defaultRoute: DEFAULT_ROUTE,
    defaultAgent: DEFAULT_AGENT,
    labels: LABELS,
    titles: TITLES,
    schema: SCHEMA,
    ...(store.corrupt ? { corrupt: true } : {}),
    ...(store.unsupported ? { unsupported: true } : {}),
  };
}
