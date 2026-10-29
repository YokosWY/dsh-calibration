/**
 * dsh-calibration-tier — 代理计划里的模型路由（v3.0.0）
 *
 * 只做三件事：
 *   1. 指纹：把宿主注册表里「有哪些 provider:model」压成一个短哈希，变了就重算；
 *   2. 路由：按能力基线 + 用户覆盖，给每个模块挑「效率档 / 性能档」各一条 route；
 *   3. 自检：注册表里没有的模型直接剔除，不编造可用性。
 *
 * 纪律：
 * - 不读凭据、不探测额度、不联网；只看 `llm.listProviders()/listModels()`。
 * - 宿主没有 llm 服务（官方旧版）时返回 `{ available:false }`，调用方据此隐藏代理格。
 * - 能力分是人工基线（core.js 的 CAPABILITIES），会过期；未知族一律 5 分并标 unknown。
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { createHash } from "node:crypto";
import { CAPABILITIES, AGENT_DOMAINS, AGENT_PLAN, AGENT_PROFILES, AGENT_LABELS, AGENT_SCORE_DOMAINS, MODELS_FILE, DSH_HOME, FREE_LINE_PROVIDERS } from "./core.js";
import { join } from "node:path";

const CACHE_FILE = join(DSH_HOME, "storages", "calibration-models.cache.json");
/** 缓存内存态：同一进程内避免每步都打一遍 listModels。 */
let memory = null;
let cachedAt = 0;
const CACHE_TTL_MS = 5 * 60 * 1000;

/** 测试 / 配置变更后强制重算。 */
export function invalidateRoutes() {
  memory = null;
  cachedAt = 0;
}

/** 从模型 id 找能力族；匹配不到给 fallback（5 分 + unknown）。 */
export function familyOf(modelId) {
  const id = String(modelId || "").toLowerCase();
  for (const fam of CAPABILITIES.families) {
    if (id.includes(fam.match)) return fam;
  }
  return { ...CAPABILITIES.fallback, match: null };
}

/** 用户覆盖：`{ models: { "provider/model": {code,reasoning,...} } }`，读不到就当没有。 */
export function readOverrides() {
  try {
    const raw = JSON.parse(readFileSync(MODELS_FILE, "utf8"));
    const models = raw && typeof raw === "object" && raw.models && typeof raw.models === "object" ? raw.models : {};
    return models;
  } catch {
    return {};
  }
}

/** 免费线名单缓存：按文件 mtime+size 失效，改配置不用重启。 */
let freeLineCache = { key: "none", set: null };

/**
 * 免费线名单：内置默认（core.js 的 `FREE_LINE_PROVIDERS`）+ `calibration-models.json` 顶层
 * `providers` 覆盖：`{ "providers": { "buddy": false, "my-free-channel": true } }`。
 * 宿主只暴露 provider 的 `id/name`，没有「免费/付费」元数据，所以只能靠名单 + 人工覆盖。
 */
export function readFreeLines() {
  let key = "none";
  let map = {};
  try {
    const st = statSync(MODELS_FILE);
    key = `${st.mtimeMs}:${st.size}`;
    const raw = JSON.parse(readFileSync(MODELS_FILE, "utf8"));
    map = raw && typeof raw === "object" && raw.providers && typeof raw.providers === "object" ? raw.providers : {};
  } catch {
    // 没有配置文件（或坏了）：key 保持 "none"，与「刚才读到的 mtime:size」不同 → 会重算
    if (freeLineCache.key === "none" && freeLineCache.set) return freeLineCache.set;
    map = {};
  }
  if (freeLineCache.key === key && freeLineCache.set) return freeLineCache.set;
  const set = new Set(FREE_LINE_PROVIDERS);
  for (const [id, on] of Object.entries(map)) {
    if (on === false) set.delete(id);
    else if (on === true) set.add(id);
  }
  freeLineCache = { key, set };
  return set;
}

/** 一条 route 的领域分：用户覆盖 > 族基线 > fallback。 */
export function scoreRoute(provider, model, overrides = readOverrides()) {
  const key = `${provider}/${model}`;
  const base = familyOf(model);
  const ov = overrides[key] && typeof overrides[key] === "object" ? overrides[key] : null;
  const merged = { ...base, ...(ov || {}) };
  const score = {};
  for (const domain of AGENT_SCORE_DOMAINS) {
    const n = Number(merged[domain]);
    score[domain] = Number.isFinite(n) ? n : 5;
  }
  return {
    provider,
    model,
    family: base.match || null,
    tier: merged.tier || "unknown",
    // 免费线标记：同分时排在后面（见 better()）；单条覆盖 > 名单
    free: typeof merged.free === "boolean" ? merged.free : readFreeLines().has(provider),
    overridden: Boolean(ov),
    score,
    // 相对代价序（v3.4.0）：同分时便宜者优先，用于效率档的「性价比」
    cost: Number.isFinite(Number(merged.cost)) ? Number(merged.cost) : 3,
    // 同分时按上下文窗口大者优先，再按 provider 名序稳定排序
    contextWindow: Number(merged.contextWindow) || 0,
  };
}

/** 指纹：排序后的 provider:model 列表。注册表没变就不重算。 */
export function fingerprintOf(list) {
  const flat = list
    .map((r) => `${r.provider}:${r.model}`)
    .sort()
    .join("|");
  return createHash("sha1").update(flat).digest("hex").slice(0, 12);
}

/**
 * 枚举宿主注册表。返回 `{ available, routes:[scoreRoute], fingerprint, error? }`。
 * `ctx.get("llm")` 在未声明注入时会抛，故整体 try/catch，失败即视为不可用。
 */
export async function resolveRoutes(ctx) {
  if (memory && Date.now() - cachedAt < CACHE_TTL_MS) {
    return { available: memory.routes.length > 0, routes: memory.routes, fingerprint: memory.fingerprint, cached: true };
  }
  let llm;
  try {
    llm = ctx && typeof ctx.get === "function" ? ctx.get("llm") : null;
  } catch {
    llm = null;
  }
  if (!llm || typeof llm.listProviders !== "function") {
    return { available: false, routes: [], fingerprint: "", error: "llm-unavailable" };
  }
  try {
    const providers = llm.listProviders() || [];
    const out = [];
    for (const p of providers) {
      let models = [];
      try {
        models = (await llm.listModels(p.id)) || [];
      } catch {
        models = [];
      }
      for (const m of models) {
        const route = scoreRoute(p.id, m.id, readOverrides());
        route.contextWindow = Number(m.contextWindow) || route.contextWindow;
        // 采集模型真正声明的推理等级：不采集就只能猜，猜错会被 resolveCallConfig 拒（v3.2.0 的坑）
        route.efforts = [];
        try {
          if (typeof llm.resolveModelInfo === "function") {
            const info = await llm.resolveModelInfo(p.id, m.id);
            const reasoning = info && info.reasoning;
            const list = reasoning && Array.isArray(reasoning.efforts) ? reasoning.efforts : [];
            route.efforts = list
              .filter((e) => e && e.id)
              .map((e) => ({ id: String(e.id), name: String(e.name || e.id), default: e.id === reasoning.defaultEffort }));
            // v3.3.1：pi-ai 的 listModels 不带 contextWindow，resolveModelInfo 可能带；
            // 有就补进 route —— 否则 better() 的「窗口大者优先」永远是 0 == 0。
            if (!(route.contextWindow > 0)) {
              const cw = Number(info && info.contextWindow);
              if (Number.isFinite(cw) && cw > 0) route.contextWindow = cw;
            }
          }
        } catch {
          route.efforts = [];
        }
        out.push(route);
      }
    }
    const fingerprint = fingerprintOf(out);
    memory = { fingerprint, routes: out, at: new Date().toISOString() };
    cachedAt = Date.now();
    writeCache(memory);
    return { available: out.length > 0, routes: out, fingerprint };
  } catch (error) {
    return { available: false, routes: [], fingerprint: "", error: String(error && error.message ? error.message : error) };
  }
}

function writeCache(payload) {
  try {
    mkdirSync(dirname(CACHE_FILE), { recursive: true });
    writeFileSync(CACHE_FILE, JSON.stringify(payload, null, 2), "utf8");
  } catch {
    /* 缓存写不了不影响主流程 */
  }
}

/** 读缓存（仅用于「宿主没变时快速返回」与调试；不参与判断）。 */
export function readCache() {
  if (memory) return memory;
  try {
    return JSON.parse(readFileSync(CACHE_FILE, "utf8"));
  } catch {
    return null;
  }
}

/** 同分排序：非免费线优先 > 分高 > contextWindow 大 > provider:model 字典序。 */
function better(a, b, domain) {
  if (a.score[domain] !== b.score[domain]) return a.score[domain] > b.score[domain];
  // 免费线只在同分时降权：同族同分时优先官方/自配，避免「启动成功、跑一半静默失败」
  if (Boolean(a.free) !== Boolean(b.free)) return !a.free;
  // 同分同免费线：代价低的优先（v3.4.0，效率档的「性价比」靠这一条）
  const ca = Number.isFinite(a.cost) ? a.cost : 3;
  const cb = Number.isFinite(b.cost) ? b.cost : 3;
  if (ca !== cb) return ca < cb;
  if (a.contextWindow !== b.contextWindow) return a.contextWindow > b.contextWindow;
  return `${a.provider}/${a.model}` < `${b.provider}/${b.model}`;
}

/** 推理等级：只在模型自己声明了 efforts 时才传。
 * 性能档（绝对质量）取声明里的最高档；效率档（强化一档）取模型默认档，
 * 不再额外砍到底——模型已经升了一档，推理强度留默认即可。
 */
function pickEffort(route, profile) {
  const list = Array.isArray(route.efforts) ? route.efforts.filter((e) => e && e.id) : [];
  if (list.length === 0) return "";
  if (profile === "efficiency") {
    // off/disabled 不是可跑档；默认落在它们身上时往后找中档
    const dead = new Set(["off", "disabled", "none"]);
    const usable = list.filter((e) => !dead.has(String(e.id).toLowerCase()));
    const pool = usable.length > 0 ? usable : list;
    const def = pool.find((e) => e.default);
    if (def) return def.id;
    for (const wanted of ["medium", "low", "minimal"]) {
      const hit = pool.find((e) => String(e.id).toLowerCase().includes(wanted));
      if (hit) return hit.id;
    }
    return pool[0].id;
  }
  for (const wanted of ["xhigh", "max", "high", "medium", "low"]) {
    const hit = list.find((e) => String(e.id).toLowerCase().includes(wanted));
    if (hit) return hit.id;
  }
  return list[list.length - 1].id;
}

/** 性能档比较：只看质量（分 → 非免费线 → 窗口大 → 名序），不比代价。 */
function betterQuality(a, b, domain) {
  if (a.score[domain] !== b.score[domain]) return a.score[domain] > b.score[domain];
  if (Boolean(a.free) !== Boolean(b.free)) return !a.free;
  if (a.contextWindow !== b.contextWindow) return a.contextWindow > b.contextWindow;
  return `${a.provider}/${a.model}` < `${b.provider}/${b.model}`;
}

/** 候选里挑最好：效率档带代价序，性能档只看质量。 */
function bestOf(list, domain, profile) {
  const cmp = profile === "efficiency" ? better : betterQuality;
  return [...list].sort((a, b) => (cmp(a, b, domain) ? -1 : 1))[0] || null;
}
/** 档位序：数字小 = 更便宜的一档；unknown 排最后（不知道就不当便宜货用）。 */
function tierRank(tier) {
  return tier === "low" ? 0 : tier === "mid" ? 1 : tier === "high" ? 2 : 3;
}

/** 基线（主会话模型）：主模型未知时返回 null，效率档此时退化成「不挑 high」。 */
function baselineOf(opts) {
  if (!opts || !opts.mainModel) return null;
  return scoreRoute(opts.mainProvider || "(main)", opts.mainModel);
}

/**
 * 效率档 = 「强化一档 + 性价比」（v3.4.0 定语义）：
 *   ① 候选只留分数**严格高于基线**的（比原本质量好）；
 *   ② 其中挑**档位最低**的那一档（够用就停，不跳级）；
 *   ③ 同档里分最高，同分按 better()（非免费线 → 代价低 → 窗口大 → 名序）。
 * 基线已是注册表上限时退到「同分但更便宜」；仍没有就沿用基线本身（upgraded:false）。
 * counter 不允许回落到基线（那等于自己对自己），由调用方退到候选里分最高的。
 */
function efficiencyChoice(candidates, domain, baseline, { allowBaseline = true } = {}) {
  const base = baseline ? baseline.score[domain] : null;
  let pool =
    base === null
      ? candidates.filter((r) => r.tier !== "high")
      : candidates.filter((r) => r.score[domain] > base);
  if (pool.length === 0 && base !== null) {
    pool = candidates.filter((r) => r.score[domain] === base && Number(r.cost || 0) < Number(baseline.cost || 0));
  }
  if (pool.length === 0) return allowBaseline && baseline ? { route: baseline, upgraded: false } : null;
  const cheapest = Math.min(...pool.map((r) => tierRank(r.tier)));
  const sameTier = pool.filter((r) => tierRank(r.tier) === cheapest);
  const best = bestOf(sameTier, domain, "efficiency");
  if (!best) return null;
  return { route: best, upgraded: base !== null && best.score[domain] > base };
}

/**
 * 给某模块挑 route。
 * @param routes  resolveRoutes().routes
 * @param module  executor|review|counter|research
 * @param profile efficiency|performance
 * @param opts    { mainProvider, mainModel } —— 强化基线，counter 的隔离依据
 */
export function pickRoute(routes, module, profile, opts = {}) {
  const domain =
    opts.domain && AGENT_SCORE_DOMAINS.includes(opts.domain)
      ? opts.domain
      : AGENT_DOMAINS[module] || "reasoning";
  if (!Array.isArray(routes) || routes.length === 0) return null;

  const hasMain = Boolean(opts.mainProvider);
  const baseline = baselineOf(opts);

  // counter：先保证隔离，再在同一份候选里按档位挑
  let candidates = routes;
  if (module === "counter" && hasMain) {
    const diffProvider = routes.filter((r) => r.provider !== opts.mainProvider);
    const diffModel = routes.filter((r) => r.provider === opts.mainProvider && r.model !== opts.mainModel);
    candidates = diffProvider.length > 0 ? diffProvider : diffModel.length > 0 ? diffModel : routes;
  }

  let best = null;
  let upgraded = false;
  if (profile === "efficiency") {
    const choice = efficiencyChoice(candidates, domain, baseline, { allowBaseline: module !== "counter" });
    if (choice) {
      best = choice.route;
      upgraded = choice.upgraded;
    } else {
      // counter 没有更强候选：隔离优先于强化，退到候选里分最高的
      best = bestOf(candidates, domain, profile);
    }
  } else {
    // 性能档 = 绝对质量：只比质量，同分不看代价
    best = bestOf(candidates, domain, profile);
  }
  if (!best) return null;

  const effort = pickEffort(best, profile);
  // v3.3.1：换 provider 但同族（deepseek-official ↔ deepseek-account）不是真隔离，
  // 只是同一模型的两个入口；只有异族才算 high，同族标 mid。
  const mainFamily = hasMain ? familyOf(opts.mainModel).match : null;
  const sameFamily = Boolean(mainFamily && best.family && mainFamily === best.family);
  const isolation =
    module !== "counter"
      ? "none"
      : !hasMain
        ? "unknown"
        : best.provider !== opts.mainProvider
          ? sameFamily
            ? "mid"
            : "high"
          : best.model !== opts.mainModel
            ? "mid"
            : "low";

  return {
    provider: best.provider,
    model: best.model,
    ...(effort ? { reasoningEffort: effort } : {}),
    isolation,
    tier: best.tier,
    score: best.score[domain],
    ...(profile === "efficiency" ? { upgraded } : {}),
  };
}

/**
 * 完整计划：四模块 × 当前档。返回给 clarify_tier 直接塞进 `agent` 字段。
 * 任何一个模块挑不到 route 时该模块为 null，调用方应显式说明「该模块不可用」。
 */
export function planRoutes(routes, profile, opts = {}) {
  const modules = {};
  for (const module of Object.keys(AGENT_DOMAINS)) {
    modules[module] = pickRoute(routes, module, profile, opts);
  }
  const plan = {
    available: routes.length > 0,
    profile,
    label: AGENT_LABELS[profile],
    maxChildren: (AGENT_PLAN[profile] || AGENT_PLAN.efficiency).maxChildren,
    isolation: (AGENT_PLAN[profile] || AGENT_PLAN.efficiency).isolation,
    modules,
    // 跨模块摘要：给模型一句能抄的派活口径
    text: describe(modules, profile),
  };
  // 三级回退：性能档 → 效率档 → 主模型自审（第三级由调用方执行，这里只给前两级）
  if (profile === "performance") {
    const fallback = {};
    for (const module of Object.keys(AGENT_DOMAINS)) {
      fallback[module] = pickRoute(routes, module, "efficiency", opts);
    }
    plan.fallback = { profile: "efficiency", label: AGENT_LABELS.efficiency, modules: fallback };
  }
  return plan;
}

function describe(modules, profile) {
  const parts = [];
  for (const [k, v] of Object.entries(modules)) {
    if (!v) parts.push(`${k}=不可用`);
    else parts.push(`${k}=${v.provider}/${v.model}${v.isolation !== "none" ? `（隔离${v.isolation}）` : ""}`);
  }
  return `${AGENT_LABELS[profile]}档：${parts.join("；")}`;
}

/** 允许写进 allowedModels 的去重 route 清单（两档都算），给安装脚本用。 */
export function allowedRoutes(routes) {
  const seen = new Set();
  const out = [];
  for (const profile of AGENT_PROFILES) {
    const plan = planRoutes(routes, profile);
    for (const v of Object.values(plan.modules)) {
      if (!v) continue;
      const key = `${v.provider}\0${v.model}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ provider: v.provider, model: v.model });
    }
  }
  return out;
}

export { existsSync as _existsSync };
