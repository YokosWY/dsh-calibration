// 宿主半边（v0.9 每轮快照）：会话隔离、轮内冻结、轮间生效、迁移、安全、坏文件不覆写。
// 运行：npm test
import test from "node:test";
import assert from "node:assert";
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import http from "node:http";
import net from "node:net";

const home = mkdtempSync(join(tmpdir(), "dsh-tier-test-"));
process.env.DSH_HOME = home;

// 端口不写死（修 flaky，2026-10-30）：写死 43991/43992 时，两个进程同时跑测试会互抢——
// 抢输的一方永远等不到「桥接就绪」，整份用例整块变红（单跑却全过）。
// 做法：让 OS 分配一个空闲端口并先占住它，再把这个端口告诉插件，插件往上扫一格就该绑 port+1；
// 真绑上的端口从「桥接就绪」日志里读，不假设。
async function bindBlocker() {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const server = http.createServer((req, res) => res.end("blocked"));
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    server.unref();
    const port = server.address().port;
    // 留出足够余量给「往上扫一格」，别贴 65535 边
    if (port > 65535 - 10) {
      await new Promise((r) => server.close(r));
      continue;
    }
    // 顺手确认 port+1 当下是空的：否则「退到 port+1」的断言会偶发不成立
    const probe = net.createServer();
    const free = await new Promise((resolve) => {
      probe.once("error", () => resolve(false));
      probe.listen(port + 1, "127.0.0.1", () => resolve(true));
    });
    if (free) await new Promise((r) => probe.close(r));
    if (free) return server;
    await new Promise((r) => server.close(r));
  }
  throw new Error("找不到可用的测试端口");
}

const blocker = await bindBlocker();
const blockedPort = blocker.address().port;
process.env.DSH_CLARIFY_TIER_PORT = String(blockedPort);

const mod = await import("../lib/index.js");

const tools = new Map();
const logs = [];
mod.apply({
  logger: () => ({ info: (message) => logs.push(String(message)) }),
  tools: { register: (t) => tools.set(t.name, t) },
  effect: () => {},
});

const statePath = join(home, "storages", "calibration.json");
const NL = String.fromCharCode(10);

// 真绑上的端口从「桥接就绪」日志里读（不假设 blockedPort + 1 一定成功）
async function waitBridgePort() {
  for (let i = 0; i < 200; i += 1) {
    const line = logs.find((l) => l.includes("桥接就绪 http://127.0.0.1:"));
    const match = line && line.match(/:(\d+)\/state/);
    if (match) return Number(match[1]);
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`bridge did not start；logs=${logs.join(" | ")}`);
}

const bridgePort = await waitBridgePort();
const BASE = `http://127.0.0.1:${bridgePort}/state`;

async function ready() {
  for (let i = 0; i < 60; i += 1) {
    try {
      const res = await fetch(BASE);
      if (res.ok || res.status === 403) return;
    } catch {
      /* 还没起来 */
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("bridge did not start");
}
await ready();

const withSession = (session) => (session ? `${BASE}?session=${encodeURIComponent(session)}` : BASE);
const get = async (session, headers = {}) => fetch(withSession(session), { headers });
const post = async (session, body, headers = {}) =>
  fetch(withSession(session), {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
const setSession = async (session, mode, level) => {
  const res = await post(session, { mode, level });
  assert.equal(res.status, 200);
};
const exec = (session, turn) => ({ agent: { id: session, session: { id: session }, phase: turn === undefined ? undefined : { turn } } });
const callTool = async (name, session, turn) => tools.get(name).execute(undefined, exec(session, turn));

test("端口被占时自动退到下一个，并在 /state 带 plugin 标记", async () => {
  const s = await (await get()).json();
  assert.equal(s.plugin, "dsh-calibration");
});

test("对抗审是独立开关：关=0 条；开之后密度随档位 3/5，scope 随模式", async () => {
  await setSession("s-counter", "loop", "high");
  const core = (c) => ({ enabled: c.enabled, maxAttacks: c.maxAttacks, scope: c.scope, isolation: c.isolation });
  let r = await callTool("forge_level", "s-counter", 1);
  assert.deepEqual(core(r.counter), { enabled: false, maxAttacks: 0, scope: "round-changes", isolation: "none" }, "默认关");

  // 打开对抗
  await post("s-counter", { counter: true });
  r = await callTool("forge_level", "s-counter", 2);
  assert.deepEqual(core(r.counter), {
    enabled: true,
    maxAttacks: 3,
    scope: "round-changes",
    isolation: "subagent-preferred",
  });

  // 极致档：5 条
  await post("s-counter", { level: "max" });
  r = await callTool("forge_level", "s-counter", 3);
  assert.deepEqual(core(r.counter), {
    enabled: true,
    maxAttacks: 5,
    scope: "round-changes",
    isolation: "subagent-preferred",
  });

  // 思考模式：scope 变成「动手前 + 交付前」
  await post("s-counter", { mode: "think" });
  const t = await callTool("clarify_tier", "s-counter", 4);
  assert.deepEqual(core(t.counter), {
    enabled: true,
    maxAttacks: 5,
    scope: "plan+delivery",
    isolation: "subagent-preferred",
  });
  assert.match(t.text, /对抗回执：/, "对抗开着的回执要写进输出");
});

test("knownSession 只认工具写过的会话（客户端写不算）", async () => {
  await setSession("s-known", "think", "high"); // 客户端写：不该认领
  assert.equal((await (await get("s-known")).json()).knownSession, false, "客户端写不应认领实例");
  await callTool("clarify_tier", "s-known", 3); // 工具写本轮快照：才认领
  assert.equal((await (await get("s-known")).json()).knownSession, true, "工具写过后才算本实例的会话");
  assert.equal((await (await get("s-not-here")).json()).knownSession, false, "没写过的会话应为 false");
});

test("工具认领后，客户端再改档不会把 owner 降回去", async () => {
  await callTool("clarify_tier", "s-keep", 1);
  await setSession("s-keep", "loop", "max");
  assert.equal((await (await get("s-keep")).json()).knownSession, true, "owner 只升不降");
});

test("退让成功时日志只报一次就绪，且报的是真绑上的端口", () => {
  const ready = logs.filter((line) => line.includes("桥接就绪"));
  assert.equal(ready.length, 1, `「桥接就绪」应只有一条，实际：${ready.join(" | ")}`);
  assert.equal(bridgePort, blockedPort + 1, `桥接应退到 ${blockedPort + 1}，实际 ${bridgePort}`);
  assert.ok(ready[0].includes(`:${bridgePort}/state`), `就绪日志应写真绑上的端口：${ready[0]}`);
  assert.ok(
    !logs.some((line) => line.includes(String(blockedPort)) && line.includes("退化为只读")),
    "单个端口被占不该说成「控件会退化为只读」",
  );
});

test("POST 响应直接带 pending / turnLocked（客户端少发一次 GET）", async () => {
  const first = await (await post("s-post", { level: "max" })).json();
  assert.equal(first.ok, true);
  assert.equal(first.mode, "think");
  assert.equal(first.level, "max");
  assert.equal(first.pending, false);
  assert.equal(first.turnLocked, false);

  // 本轮已有快照（turn 5），再改档就是「下轮生效」
  await callTool("clarify_tier", "s-post", 5);
  const locked = await (await post("s-post", { level: "off" })).json();
  assert.equal(locked.level, "off");
  assert.equal(locked.turnLocked, true);
  assert.equal(locked.pending, true, "响应里要带 pending，客户端才能不补 GET");
});

test("空会话用内置默认：think/high，GET 不建文件", async () => {
  rmSync(statePath, { force: true });
  const s = await (await get("s-inherit")).json();
  assert.equal(s.mode, "think");
  assert.equal(s.level, "high");
  assert.equal(s.inherited, true);
  assert.equal(s.pending, false);
  assert.equal(s.schema, 9);
  assert.equal(s.agent.on, false, "代理默认关");
  assert.equal(s.agent.profile, "efficiency");
  assert.equal(existsSync(statePath), false);
});

test("每个对话各用各的：写 A 不影响 B", async () => {
  await setSession("s-iso-a", "loop", "max");
  await setSession("s-iso-b", "think", "off");
  const a = await (await get("s-iso-a")).json();
  const b = await (await get("s-iso-b")).json();
  assert.equal(a.mode, "loop");
  assert.equal(a.level, "max");
  assert.equal(b.mode, "think");
  assert.equal(b.level, "off");
});

test("同一会话内切模式不丢档位", async () => {
  await setSession("s-gamma", "think", "max");
  await post("s-gamma", { mode: "loop" });
  const s = await (await get("s-gamma")).json();
  assert.equal(s.mode, "loop");
  assert.equal(s.level, "max");
});

test("轮内冻结：同一轮里点了档，工具仍读开工时那份", async () => {
  await setSession("s-turn", "think", "high");
  const first = await callTool("forge_level", "s-turn", 1);
  assert.equal(first.turnLocked, true);
  assert.equal(first.forge, "off"); // 思考模式
  // 用户在「我思考时」点成循环·极致
  await setSession("s-turn", "loop", "max");
  const again = await callTool("forge_level", "s-turn", 1);
  assert.equal(again.mode, "think", "同一轮不该换档");
  assert.equal(again.pending, true, "应标记为下轮生效");
  const s = await (await get("s-turn")).json();
  assert.equal(s.mode, "loop", "存储值已经改了");
  assert.equal(s.pending, true);
});

test("轮间生效：下一轮用新档", async () => {
  const next = await callTool("forge_level", "s-turn", 2);
  assert.equal(next.mode, "loop");
  assert.equal(next.forge, "max");
  assert.equal(next.pending, false);
});

test("agent 是带注入校验的代理时，仍能取到 phase.turn", () => {
  const target = { phase: { turn: 7 }, session: { id: "s-proxy" }, id: "s-proxy" };
  const proxy = new Proxy(target, {
    get(obj, prop) {
      if (prop in obj) return obj[prop];
      throw new Error(`cannot get property "${String(prop)}" without inject`);
    },
  });
  assert.equal(mod.turnIdFromExec({ agent: proxy }), "7");
});

test("拿不到轮 id 时退回实时值，不报错", async () => {
  await setSession("s-noid", "think", "max");
  const r = await callTool("clarify_tier", "s-noid", null);
  assert.equal(r.tier, "max");
  assert.equal(r.turnLocked, false);
});

test("工具按 exec 会话读；拿不到会话落 default", async () => {
  const a = await callTool("forge_level", "s-iso-a", "t1");
  const b = await callTool("forge_level", "s-iso-b", "t1");
  assert.equal(a.forge, "max");
  assert.equal(b.forge, "off");
  const d = await tools.get("forge_level").execute();
  assert.equal(d.session, "default");
});

test("非法值 400 且不落盘", async () => {
  const res = await post("s-invalid", { mode: "ultra", level: "low" });
  assert.equal(res.status, 400);
});

test("老 schema 5 迁移成 default 会话", async () => {
  writeFileSync(statePath, JSON.stringify({ mode: "loop", level: "max", schema: 5 }), "utf8");
  const s = await (await get()).json();
  assert.equal(s.session, "default");
  assert.equal(s.mode, "loop");
  const disk = JSON.parse(readFileSync(statePath, "utf8"));
  assert.equal(disk.schema, 9);
  assert.equal(disk.sessions.default.level, "max");
  assert.deepEqual(disk.sessions.default.agent, { on: false, profile: "efficiency" });
  assert.ok(existsSync(`${statePath}.bak`));
});

test("老 schema 4（tier/forge）也能迁移", async () => {
  writeFileSync(statePath, JSON.stringify({ tier: "max", forge: "std", schema: 4 }), "utf8");
  const s = await (await get()).json();
  assert.equal(s.mode, "loop");
  assert.equal(s.level, "high");
});

test("坏 JSON：只读兜底，绝不覆写", async () => {
  writeFileSync(statePath, "{oops", "utf8");
  const s = await (await get("s-x")).json();
  assert.equal(s.corrupt, true);
  assert.equal(readFileSync(statePath, "utf8"), "{oops");
});

test("未知 schema：只读兜底，不降级覆写", async () => {
  const future = JSON.stringify({ schema: 10, sessions: {}, forge: "max" });
  writeFileSync(statePath, future, "utf8");
  const s = await (await get()).json();
  assert.equal(s.unsupported, true);
  assert.equal(readFileSync(statePath, "utf8"), future);
  rmSync(statePath, { force: true });
});

test("标量 body 400，宿主不崩", async () => {
  for (const raw of ["5", "null", '"loop"', "[1,2]", "{bad"]) {
    const res = await fetch(BASE, { method: "POST", headers: { "content-type": "application/json" }, body: raw });
    assert.equal(res.status, 400, `body=${raw} 应被拒绝`);
  }
});

test("安全：跨站 Origin 读写预检全 403", async () => {
  await setSession("s-sec", "think", "high");
  const evil = "https://evil.example";
  assert.equal((await post("s-sec", { mode: "loop", level: "max" }, { Origin: evil })).status, 403);
  assert.equal((await get("s-sec", { Origin: evil })).status, 403);
  assert.equal((await fetch(BASE, { method: "OPTIONS", headers: { Origin: evil } })).status, 403);
  assert.equal((await get("s-sec", { Origin: "null" })).status, 403);
  assert.equal((await get("s-sec", { Origin: "http://localhost.evil.com" })).status, 403);
});

test("安全：本机 Origin 回显，非 *", async () => {
  const origin = "http://127.0.0.1:61456";
  const res = await get("s-sec", { Origin: origin });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("access-control-allow-origin"), origin);
});

test("安全：POST 必须 application/json", async () => {
  const res = await fetch(BASE, {
    method: "POST",
    headers: { "content-type": "text/plain", Origin: "http://127.0.0.1:61456" },
    body: JSON.stringify({ mode: "loop" }),
  });
  assert.equal(res.status, 415);
});

test("写盘失败返回 500", async () => {
  const storages = dirname(statePath);
  rmSync(storages, { recursive: true, force: true });
  writeFileSync(storages, "not a directory", "utf8");
  try {
    const res = await post("s-wf", { mode: "think" });
    assert.equal(res.status, 500);
    const body = await res.json();
    assert.equal(body.error, "write failed");
  } finally {
    rmSync(storages, { force: true });
    mkdirSync(storages, { recursive: true });
  }
});

async function waitFor(fn, timeout = 4000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("timeout waiting for condition");
}

function openStream(session, headers = {}) {
  const path = `/events?session=${encodeURIComponent(session)}`;
  return new Promise((resolve, reject) => {
    const req = http.get({ host: "127.0.0.1", port: bridgePort, path, headers }, (res) => {
      const frames = [];
      let buf = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        buf += chunk;
        let idx;
        while ((idx = buf.indexOf(NL + NL)) >= 0) {
          const frame = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          const line = frame.split(NL).find((l) => l.startsWith("data: "));
          if (line) {
            try {
              frames.push(JSON.parse(line.slice(6)));
            } catch {
              /* 忽略坏帧 */
            }
          }
        }
      });
      resolve({ req, res, frames });
    });
    req.on("error", reject);
  });
}

test("SSE 只推同一会话，帧里带 pending/turnLocked", async () => {
  await setSession("s-sse-a", "think", "high");
  await setSession("s-sse-b", "think", "high");
  const a = await openStream("s-sse-a");
  const b = await openStream("s-sse-b");
  try {
    await waitFor(() => a.frames.length >= 1 && b.frames.length >= 1);
    await post("s-sse-a", { mode: "loop", level: "max" });
    await waitFor(() => a.frames.length >= 2);
    assert.equal(a.frames.at(-1).mode, "loop");
    assert.equal(typeof a.frames.at(-1).pending, "boolean");
    assert.equal(b.frames.length, 1, "b 不该收到 a 的广播");
  } finally {
    a.req.destroy();
    b.req.destroy();
  }
});

test("检索开关：默认关（显示「本地」），/state 带两档与标签", async () => {
  rmSync(statePath, { force: true });
  const s = await (await get("s-route-default")).json();
  assert.deepEqual(s.route, { on: false, level: "high" }, "默认关，档位记「增量」");
  assert.deepEqual(s.routeLevels, ["high", "max"], "可提交的检索档是两档；off = 本地，只是轮换格的显示名");
  assert.deepEqual(s.labels.route, { off: "本地", high: "增量", max: "全量" });
  assert.deepEqual(s.labels.agent, { off: "默认", efficiency: "效率", performance: "性能" });
  assert.deepEqual(s.defaultRoute, { on: false, level: "high" });
  assert.deepEqual(s.agentProfiles, ["efficiency", "performance"]);
  assert.deepEqual(s.defaultAgent, { on: false, profile: "efficiency" });
});

test("检索开关与档位分开写：开/关不动思考档，改档不动开关", async () => {
  await setSession("s-route-part", "think", "max");
  let res = await post("s-route-part", { route: { on: true } });
  assert.equal(res.status, 200);
  let s = await (await get("s-route-part")).json();
  assert.deepEqual(s.route, { on: true, level: "high" }, "开检索不影响思考档，档位保持默认增量");
  assert.equal(s.level, "max", "思考档没被串改");

  await post("s-route-part", { route: { level: "max" } });
  s = await (await get("s-route-part")).json();
  assert.deepEqual(s.route, { on: true, level: "max" });

  await post("s-route-part", { route: { on: false } });
  s = await (await get("s-route-part")).json();
  assert.deepEqual(s.route, { on: false, level: "max" }, "关掉后档位留着，再开不用重选");
});

test("检索：非法档位 400 且不落盘", async () => {
  const before = await (await get("s-route-bad")).json();
  const res = await post("s-route-bad", { route: { level: "ultra" } });
  assert.equal(res.status, 400);
  const after = await (await get("s-route-bad")).json();
  assert.deepEqual(after.route, before.route);
});

test("检索：route 不是对象也 400", async () => {
  const res = await post("s-route-shape", { route: "on" });
  assert.equal(res.status, 400);
});

test("检索也吃轮内快照：本轮点了，下一轮才生效", async () => {
  await setSession("s-route-turn", "think", "high");
  await post("s-route-turn", { route: { on: false } });
  let r = await callTool("clarify_tier", "s-route-turn", 21); // 建本轮快照：关
  assert.equal(r.route.on, false);
  await post("s-route-turn", { route: { on: true } });
  r = await callTool("clarify_tier", "s-route-turn", 21);
  assert.equal(r.route.on, false, "同一轮沿用开工快照");
  assert.equal(r.pending, true, "本轮有待生效改动");
  r = await callTool("clarify_tier", "s-route-turn", 22);
  assert.equal(r.route.on, true, "下一轮生效");
  assert.equal(r.pending, false);
});

test("clarify_tier 带检索计划：全量给联网与不设上限的口径，关着不给空表", async () => {
  await setSession("s-route-tool", "think", "high");
  await post("s-route-tool", { route: { on: true, level: "max" } });
  const r = await callTool("clarify_tier", "s-route-tool", 11);
  assert.equal(r.route.on, true);
  assert.equal(r.route.label, "全量");
  assert.equal(r.route.plan.network, true);
  assert.ok(r.route.plan.reads.includes("不设上限"), r.route.plan.reads);
  assert.ok(r.text.includes("检索=全量"), r.text);

  await post("s-route-tool", { route: { on: false } });
  const off = await callTool("clarify_tier", "s-route-tool", 12);
  assert.equal(off.route.on, false);
  assert.equal(off.route.plan, null, "关着时不给一张用不上的表");
  assert.ok(off.text.includes("检索：关"), off.text);
});

test("v7 状态文件跨两级迁移到 v9：补 route/agent 默认并留 .bak", async () => {
  writeFileSync(
    statePath,
    JSON.stringify({
      schema: 7,
      sessions: { default: { mode: "loop", level: "max", counter: true, updatedAt: "2026-10-20T00:00:00.000Z" } },
    }),
    "utf8",
  );
  const s = await (await get()).json();
  assert.deepEqual(s.route, { on: false, level: "high" });
  assert.deepEqual(s.agent, { on: false, profile: "efficiency" });
  const disk = JSON.parse(readFileSync(statePath, "utf8"));
  assert.equal(disk.schema, 9);
  assert.deepEqual(disk.sessions.default.route, { on: false, level: "high" });
  assert.deepEqual(disk.sessions.default.agent, { on: false, profile: "efficiency" });
  assert.ok(existsSync(`${statePath}.bak`), "迁移前要留 .bak");
  assert.equal(disk.sessions.default.counter, true, "老字段不能被迁移弄丢");
});

test("v8 状态文件的 route.level=off（旧「本地」）迁移到 high，不丢开关状态", async () => {
  writeFileSync(
    statePath,
    JSON.stringify({
      schema: 8,
      sessions: {
        default: {
          mode: "think",
          level: "high",
          counter: false,
          route: { on: true, level: "off" },
          updatedAt: "2026-10-27T00:00:00.000Z",
        },
      },
    }),
    "utf8",
  );
  const s = await (await get()).json();
  assert.deepEqual(s.route, { on: true, level: "high" }, "旧 off 归到增量，开关仍开");
  assert.deepEqual(s.agent, { on: false, profile: "efficiency" });
});

test("循环模式也返回思考强度：tier 不再恒为 off，think 与档位同源", async () => {
  await setSession("s-think-loop", "loop", "max");
  let r = await callTool("clarify_tier", "s-think-loop", 31);
  assert.equal(r.mode, "loop");
  assert.equal(r.tier, "max", "循环档的 tier 就是同档位映射，不再是 off");
  assert.equal(r.think.level, "max");
  assert.equal(r.think.intensity, 3);
  assert.equal(r.think.probes.length, 3);
  assert.ok(r.text.includes("思考强度"), r.text);

  await setSession("s-think-loop", "think", "max");
  r = await callTool("clarify_tier", "s-think-loop", 32);
  assert.equal(r.think.source, "think");
  assert.equal(r.think.axes.length, 6, "极致要列满 6 条覆盖轴");
  assert.ok(r.text.includes("思考档位"), r.text);
});

test("代理开关：默认关、POST 写回、/state 带两档、非法值 400", async () => {
  rmSync(statePath, { force: true });
  let s = await (await get("s-agent")).json();
  assert.deepEqual(s.agent, { on: false, profile: "efficiency" }, "默认关 + 效率档");

  let res = await post("s-agent", { agent: { on: true } });
  assert.equal(res.status, 200);
  s = await (await get("s-agent")).json();
  assert.deepEqual(s.agent, { on: true, profile: "efficiency" }, "开开关不改档位");

  res = await post("s-agent", { agent: { profile: "performance" } });
  assert.equal(res.status, 200);
  s = await (await get("s-agent")).json();
  assert.deepEqual(s.agent, { on: true, profile: "performance" });

  res = await post("s-agent", { agent: { profile: "ultra" } });
  assert.equal(res.status, 400, "非法档位直接 400");
  res = await post("s-agent", { agent: "on" });
  assert.equal(res.status, 400, "agent 必须是对象");
});

test("clarify_tier 代理关：只回 on:false，不占每步字", async () => {
  await setSession("s-agent-off", "think", "high");
  const r = await callTool("clarify_tier", "s-agent-off", 41);
  assert.deepEqual(r.agent, { on: false });
  assert.ok(r.text.includes("代理：关"), r.text);
});

test("clarify_tier 代理开但宿主没有 llm：available:false，不编造模型", async () => {
  await setSession("s-agent-on", "think", "high");
  await post("s-agent-on", { agent: { on: true, profile: "performance" } });
  const r = await callTool("clarify_tier", "s-agent-on", 42);
  assert.equal(r.agent.on, true);
  assert.equal(r.agent.profile, "performance");
  assert.equal(r.agent.available, false, "测试 ctx 没有 llm 服务");
  assert.ok(r.text.includes("注册表不可用"), r.text);
});

test("代理也吃轮内快照：本轮点了，下一轮才生效", async () => {
  await setSession("s-agent-turn", "think", "high");
  let r = await callTool("clarify_tier", "s-agent-turn", 51);
  assert.equal(r.agent.on, false);
  await post("s-agent-turn", { agent: { on: true, profile: "efficiency" } });
  r = await callTool("clarify_tier", "s-agent-turn", 51);
  assert.equal(r.agent.on, false, "同一轮沿用开工快照");
  assert.equal(r.pending, true);
  r = await callTool("clarify_tier", "s-agent-turn", 52);
  assert.equal(r.agent.on, true, "下一轮生效");
});

test("verify_claims 工具：文件命中、锚点不匹配、越界路径被拒", async () => {
  const tool = tools.get("verify_claims");
  assert.ok(tool, "verify_claims 必须注册");
  // 版本号会随发布变，别把字面量写进断言
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  const out = await tool.execute({
    claims: [
      { text: pkg.version, source: { kind: "file", path: "package.json", line: 3 } },
      { text: "9.9.9", source: { kind: "file", path: "package.json", line: 3 } },
      { text: "x", source: { kind: "file", path: "../../outside.txt" } },
      { text: "https://docs.python.org/3/", source: { kind: "url", url: "https://docs.python.org/3/" } },
    ],
  });
  assert.equal(out.total, 4);
  assert.equal(out.results[0].ok, true, `第 3 行确实是 ${pkg.version}`);
  assert.equal(out.results[1].ok, false);
  assert.equal(out.results[2].ok, false);
  assert.equal(out.results[2].reasons[0], "outside-workspace");
  assert.equal(out.results[3].level, "url-L1");
  assert.ok(out.text.includes("已核"), out.text);
});
