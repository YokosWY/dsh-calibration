/**
 * dsh-clarify-tier — 状态文件（读写、迁移、兜底）
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
  LABELS,
  TITLES,
  DEFAULT_MODE,
  DEFAULT_LEVEL,
  SCHEMA,
  DEFAULT_SESSION,
  SESSION_LIMIT,
  STATE_FILE,
  sanitizeSession,
} from "./core.js";

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
export function readStore() {
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
    knownLegacySchema && ("tier" in data || "forge" in data || "mode" in data || "level" in data || "sessions" in data);
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
export function sessionState(store, id) {
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

/** 给 HTTP 层与工具用的快照：含 pending（本轮快照与当前值不一致）与 turnLocked。 */
export function publicState(sessionId) {
  const id = sanitizeSession(sessionId);
  const store = readStore();
  const state = sessionState(store, id);
  const pending = Boolean(state.turn && (state.turn.mode !== state.mode || state.turn.level !== state.level));
  return {
    plugin: PACKAGE_ID,
    session: id,
    ...state,
    pending,
    turnLocked: Boolean(state.turn),
    // 本实例的状态文件里有没有这个会话：客户端靠它区分「两套 DSH 里哪个才是我」
    knownSession: Boolean(store.sessions[id]),
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
