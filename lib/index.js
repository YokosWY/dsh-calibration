/**
 * dsh-calibration-tier — 宿主入口（装配层）
 *
 * 这里只做三件事：起桥接、注册工具、把 dispose 挂到 ctx.effect 上。
 * 具体逻辑在同级模块：
 *   core.js    常量、档位表、会话键清洗、广播总线
 *   state.js   状态文件读写与迁移（坏文件只读兜底）
 *   bridge.js  回环桥（HTTP / SSE / 端口退让）
 *   tools.js   clarify_tier 与 forge_level（含轮内快照）
 *
 * 安全：回环桥只接受本机页面（Origin 白名单），POST 必须 application/json。
 * 数据安全：坏 JSON / 未知 schema / 字段坏一律只读兜底，不覆写；迁移前 .bak；tmp+rename 原子写；写失败 500。
 */
import { PACKAGE_ID } from "./core.js";
import { startBridge } from "./bridge.js";
import { registerTools } from "./tools.js";
import { registerDelegate } from "./delegate.js";

export {
  PACKAGE_ID,
  TIER_LABELS,
  TIER_TITLES,
  TIER_ROUTE_LABELS,
  TIER_ROUTE_TITLES,
  TIER_AGENT_LABELS,
  TIER_AGENT_TITLES,
  LABELS,
  TITLES,
  MODES,
  LEVELS,
  ROUTE_LEVELS,
  AGENT_PROFILES,
  AGENT_PLAN,
  ROUTE_PLAN,
  DEFAULT_MODE,
  DEFAULT_LEVEL,
  DEFAULT_ROUTE,
  DEFAULT_AGENT,
  routePlan,
  agentPlan,
  counterPlan,
} from "./core.js";
export { publicState, readStore, writeSession, sessionState } from "./state.js";
export { originAllowed } from "./bridge.js";
export { turnIdFromExec, sessionFromExec, turnState, readPhaseTurn, mainRouteFromExec, rootFromExec } from "./tools.js";
export { familyOf, scoreRoute, planRoutes, pickRoute, nearPeers, resolveRoutes, allowedRoutes, fingerprintOf } from "./agents.js";
export { verifyClaims, verifyOne, domainTier, anchorsOf } from "./verify.js";
export { registerDelegate, currentAgent } from "./delegate.js";

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
      registerTools(ctx, log);
    } else {
      log("ctx.tools 不可用，工具未注册（档位仍可通过桥接读写）");
    }
  } catch (error) {
    log(`工具注册失败（模型将只能按默认档位）：${String(error)}`);
  }

  // agent_delegate 需要 subagents 服务：等它出现再注册，缺了就只少一个工具，不影响其余档位
  try {
    if (ctx && typeof ctx.inject === "function") {
      ctx.inject(["subagents"], (sub) => {
        try {
          registerDelegate(sub, log);
        } catch (error) {
          log(`agent_delegate 注册失败：${String(error)}`);
        }
      });
    } else {
      log("ctx.inject 不可用，agent_delegate 未注册");
    }
  } catch (error) {
    log(`agent_delegate 注入失败：${String(error)}`);
  }
}

export default { apply, inject };
