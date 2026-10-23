// 宿主半边：状态模型、迁移、两个工具投影、安全边界、坏文件不覆写、写盘失败不谎报。
// 运行：npm test
import test from "node:test";
import assert from "node:assert";
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import http from "node:http";

const home = mkdtempSync(join(tmpdir(), "dsh-tier-test-"));
process.env.DSH_HOME = home;
process.env.DSH_CLARIFY_TIER_PORT = "43991";

const mod = await import("../lib/index.js");

const tools = new Map();
mod.apply({
  logger: () => ({ info: () => {} }),
  tools: { register: (t) => tools.set(t.name, t) },
  effect: () => {},
});

const BASE = "http://127.0.0.1:43991/state";
const statePath = join(home, "storages", "clarify-tier.json");

/** 等端口就绪，不用魔法睡眠。 */
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

const get = async (headers = {}) => fetch(BASE, { headers });
const post = async (body, headers = {}) =>
  fetch(BASE, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
const setState = async (mode, level) => {
  const res = await post({ mode, level });
  assert.equal(res.status, 200);
};

test("默认状态：think/high，字段齐全", async () => {
  rmSync(statePath, { force: true });
  const s = await (await get()).json();
  assert.equal(s.mode, "think");
  assert.equal(s.level, "high");
  assert.deepEqual(s.levels, ["off", "high", "max"]);
  assert.deepEqual(s.modes, ["think", "loop"]);
  assert.equal(s.schema, 5);
  assert.equal(existsSync(statePath), false, "只读 GET 不该凭空建文件");
});

test("/state 提供文案表（客户端不再自备一份）", async () => {
  const s = await (await get()).json();
  assert.equal(s.labels.loop.off, "轻量");
  assert.equal(s.labels.think.high, "严格");
  assert.match(s.titles.loop.max, /8 轮/);
});

test("切模式不丢档位（合并式写入）", async () => {
  await setState("loop", "max");
  await post({ mode: "think" });
  let s = await (await get()).json();
  assert.equal(s.mode, "think");
  assert.equal(s.level, "max");
  await post({ level: "off" });
  s = await (await get()).json();
  assert.equal(s.mode, "think");
  assert.equal(s.level, "off");
});

test("非法值返回 400 且不落盘", async () => {
  await setState("loop", "high");
  const res = await post({ mode: "ultra", level: "low" });
  assert.equal(res.status, 400);
  const s = await (await get()).json();
  assert.equal(s.mode, "loop");
  assert.equal(s.level, "high");
});

test("老 schema 迁移：forge=std → 循环/交付，并留 .bak", async () => {
  writeFileSync(statePath, JSON.stringify({ tier: "max", forge: "std", schema: 4 }), "utf8");
  const s = await (await get()).json();
  assert.equal(s.mode, "loop");
  assert.equal(s.level, "high");
  assert.equal(JSON.parse(readFileSync(statePath, "utf8")).schema, 5);
  assert.ok(existsSync(`${statePath}.bak`), "迁移前应留备份");
});

test("老 schema 迁移：tier=low → 思考/严格", async () => {
  writeFileSync(statePath, JSON.stringify({ tier: "low", forge: "off", schema: 4 }), "utf8");
  const s = await (await get()).json();
  assert.equal(s.mode, "think");
  assert.equal(s.level, "high");
});

test("坏 JSON：返回默认值，绝不覆写原文件", async () => {
  writeFileSync(statePath, "{oops", "utf8");
  const s = await (await get()).json();
  assert.equal(s.mode, "think");
  assert.equal(s.source, "corrupt");
  assert.equal(readFileSync(statePath, "utf8"), "{oops");
});

test("未知 schema（6）：只读兜底，不降级覆写", async () => {
  const future = JSON.stringify({ schema: 6, mode: "loop", level: "max" });
  writeFileSync(statePath, future, "utf8");
  const s = await (await get()).json();
  assert.equal(s.source, "unsupported");
  assert.equal(readFileSync(statePath, "utf8"), future);
});

test("未知 schema 即使带 tier/forge 也不许降级覆盖", async () => {
  const future = JSON.stringify({ schema: 6, forge: "max" });
  writeFileSync(statePath, future, "utf8");
  const s = await (await get()).json();
  assert.equal(s.source, "unsupported");
  assert.equal(readFileSync(statePath, "utf8"), future);
});

test("标量 body 返回 400，宿主不崩", async () => {
  for (const raw of ["5", "null", '"loop"', "[1,2]", "{bad"]) {
    const res = await fetch(BASE, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: raw,
    });
    assert.equal(res.status, 400, `body=${raw} 应被拒绝`);
  }
  const s = await (await get()).json();
  assert.ok(["think", "loop"].includes(s.mode), "宿主应仍可服务");
});

test("schema 5 但字段坏：保留能认的一半，不回写", async () => {
  const mixed = JSON.stringify({ schema: 5, mode: "loop", level: "bogus" });
  writeFileSync(statePath, mixed, "utf8");
  const s = await (await get()).json();
  assert.equal(s.mode, "loop");
  assert.equal(s.level, "high");
  assert.equal(s.sanitized, true);
  assert.equal(readFileSync(statePath, "utf8"), mixed);
});

test("工具投影：思考模式", async () => {
  await setState("think", "max");
  const c = await tools.get("clarify_tier").execute();
  const f = await tools.get("forge_level").execute();
  assert.equal(c.tier, "max");
  assert.equal(f.forge, "off");
  assert.equal(f.maxRounds, 0);
  assert.match(c.text, /极限/);
});

test("工具投影：循环三档", async () => {
  await setState("loop", "off");
  let f = await tools.get("forge_level").execute();
  assert.equal(f.forge, "lite");
  assert.equal(f.maxRounds, 3);
  await post({ level: "high" });
  f = await tools.get("forge_level").execute();
  assert.equal(f.forge, "high");
  assert.equal(f.maxRounds, 5);
  await post({ level: "max" });
  f = await tools.get("forge_level").execute();
  assert.equal(f.forge, "max");
  assert.equal(f.maxRounds, 8);
  const c = await tools.get("clarify_tier").execute();
  assert.equal(c.tier, "off");
});

test("安全：跨站 Origin 被拒（读、写、预检）", async () => {
  await setState("think", "high");
  const evil = "https://evil.example";
  assert.equal((await post({ mode: "loop", level: "max" }, { Origin: evil })).status, 403);
  assert.equal((await get({ Origin: evil })).status, 403);
  assert.equal((await fetch(BASE, { method: "OPTIONS", headers: { Origin: evil } })).status, 403);
  assert.equal((await get({ Origin: "null" })).status, 403);
  assert.equal((await get({ Origin: "http://localhost.evil.com" })).status, 403);
  const s = await (await get()).json();
  assert.equal(s.mode, "think", "跨站写入不应生效");
  assert.equal(s.level, "high");
});

test("安全：本机 Origin 放行且回显，不是 *", async () => {
  const origin = "http://127.0.0.1:60465";
  const res = await get({ Origin: origin });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("access-control-allow-origin"), origin);
  const pre = await fetch(BASE, { method: "OPTIONS", headers: { Origin: origin } });
  assert.equal(pre.status, 204);
});

test("安全：POST 必须是 application/json", async () => {
  const res = await fetch(BASE, {
    method: "POST",
    headers: { "content-type": "text/plain", Origin: "http://127.0.0.1:60465" },
    body: JSON.stringify({ mode: "loop" }),
  });
  assert.equal(res.status, 415);
});

test("写盘失败返回 500，不谎报成功", async () => {
  await setState("loop", "max");
  const storages = dirname(statePath);
  rmSync(storages, { recursive: true, force: true });
  writeFileSync(storages, "not a directory", "utf8"); // 让 mkdir 失败
  try {
    const res = await post({ mode: "think" });
    assert.equal(res.status, 500);
    const body = await res.json();
    assert.equal(body.error, "write failed");
  } finally {
    rmSync(storages, { force: true });
    mkdirSync(storages, { recursive: true });
  }
});

const NL = String.fromCharCode(10);

async function waitFor(fn, timeout = 4000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("timeout waiting for condition");
}

function openStream(headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: "127.0.0.1", port: 43991, path: "/events", headers }, (res) => {
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

test("SSE：连上先推当前状态，写入后广播给所有订阅者", async () => {
  await setState("think", "high");
  const a = await openStream({ Origin: "http://127.0.0.1:60465" });
  const b = await openStream();
  try {
    await waitFor(() => a.frames.length >= 1 && b.frames.length >= 1);
    assert.equal(a.frames.at(-1).mode, "think", "首帧应是当前状态");
    await post({ mode: "loop", level: "max" });
    await waitFor(() => a.frames.length >= 2 && b.frames.length >= 2);
    assert.equal(a.frames.at(-1).mode, "loop");
    assert.equal(a.frames.at(-1).level, "max");
    assert.deepEqual(b.frames.at(-1), a.frames.at(-1), "两个订阅者收到同一帧");
  } finally {
    a.req.destroy();
    b.req.destroy();
  }
});

test("SSE：跨站 Origin 被拒", async () => {
  const res = await fetch("http://127.0.0.1:43991/events", { headers: { Origin: "https://evil.example" } });
  assert.equal(res.status, 403);
});
