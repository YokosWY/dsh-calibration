/**
 * dsh-clarify-tier — 宿主半边
 *
 * 职责只有三件，全部 fail-open：
 *   1. 保存「本轮需求锚定档位」到 `$DSH_HOME/storages/clarify-tier.json`
 *   2. 在 127.0.0.1 上开一个只读+可写的小接口，让客户端滑条能读写同一个值
 *   3. 注册 `clarify_tier` 工具，让模型在开工时能读到当前档位
 *
 * 为什么用 loopback HTTP 当桥：客户端插件的状态默认只在 localStorage（浏览器侧），
 * 宿主读不到；DSH 的 Remote 服务面没有通用的「自定义 kv」通道。一个只绑 127.0.0.1
 * 的小 server 是唯一不依赖框架内部 API 的形状，且插件卸载即随进程关闭。
 */
import { createServer } from "node:http";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

const PACKAGE_ID = "dsh-clarify-tier";
const TIERS = ["off", "low", "high", "max"];
const DEFAULT_TIER = "low";
/** v4：删掉原 low（方向），其余降一级——旧 high→low、旧 max→high、旧 ultra→max。 */
const LEGACY_TIERS = { high: "low", max: "high", ultra: "max" };
const SCHEMA = 4;
const PORT = Number(process.env.DSH_CLARIFY_TIER_PORT || 43871);
const DSH_HOME = process.env.DSH_HOME || join(homedir(), ".dsh");
const STATE_FILE = join(DSH_HOME, "storages", "clarify-tier.json");

function readState() {
  try {
    const raw = readFileSync(STATE_FILE, "utf8");
    const parsed = JSON.parse(raw);
    let tier = TIERS.includes(parsed && parsed.tier) ? parsed.tier : null;
    // 老 schema：五档时代的 high/max/ultra 各降一级，再落盘成新 schema。
    if ((parsed && parsed.schema) !== SCHEMA) {
      if (tier === null || LEGACY_TIERS[tier] !== undefined) {
        tier = LEGACY_TIERS[parsed && parsed.tier] || DEFAULT_TIER;
      }
      writeState(tier);
      return { tier, updatedAt: new Date().toISOString(), migrated: true };
    }
    if (tier === null) tier = DEFAULT_TIER;
    return { tier, updatedAt: parsed && parsed.updatedAt ? parsed.updatedAt : null };
  } catch {
    return { tier: DEFAULT_TIER, updatedAt: null };
  }
}

function writeState(tier) {
  const safe = TIERS.includes(tier) ? tier : DEFAULT_TIER;
  const payload = { tier: safe, updatedAt: new Date().toISOString(), schema: SCHEMA };
  try {
    mkdirSync(dirname(STATE_FILE), { recursive: true });
    writeFileSync(STATE_FILE, JSON.stringify(payload, null, 2), "utf8");
  } catch {
    /* 落盘失败不影响内存里的值 */
  }
  return payload;
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
      res.end(JSON.stringify({ ...readState(), tiers: TIERS, defaultTier: DEFAULT_TIER }));
      return;
    }
    if (req.url === "/state" && req.method === "POST") {
      let body = "";
      req.on("data", (chunk) => {
        body += chunk;
        if (body.length > 4096) req.destroy();
      });
      req.on("end", () => {
        let tier = null;
        try {
          tier = JSON.parse(body || "{}").tier;
        } catch {
          /* 忽略坏 JSON */
        }
        const saved = writeState(tier);
        res.writeHead(200, { ...cors, "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify(saved));
      });
      return;
    }
    res.writeHead(404, cors);
    res.end("not found");
  });
  server.on("error", (error) => log(`桥接端口 ${PORT} 不可用（滑条会退化为只读）：${String(error)}`));
  try {
    server.listen(PORT, "127.0.0.1", () => log(`桥接就绪 http://127.0.0.1:${PORT}/state`));
  } catch (error) {
    log(`桥接启动失败：${String(error)}`);
  }
  return server;
}

// 访问 ctx.tools 前必须声明注入，否则抛 “cannot get property "tools" without inject”，
// clarify_tier 工具永远注册不上（宿主日志里只会留一条 info）。
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
          "读取当前锚定档位：关闭 / 常规 / 严格 / 极限。开工前若本工具可用先调用；读不到按 low。不要复述结果。",
        parameters: { type: "object", properties: {}, additionalProperties: false },
        output: {
          schema: { type: "object", additionalProperties: true },
          render: (args, value) => [{ type: "text", text: String(value && value.text ? value.text : "") }],
        },
        execute: async () => {
          const state = readState();
          return {
            tier: state.tier,
            updatedAt: state.updatedAt,
            text: `需求锚定档位 = ${state.tier}（off 表示不使用 clarify-needs；low 为默认）。`,
          };
        },
      });
      log("clarify_tier 工具已注册");
    } else {
      log("ctx.tools 不可用，clarify_tier 未注册（档位仍可通过桥接读写）");
    }
  } catch (error) {
    log(`工具注册失败（模型将只能按默认档位）：${String(error)}`);
  }
}

export default { apply, inject };
