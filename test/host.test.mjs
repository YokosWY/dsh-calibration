// 宿主半边（v0.7 每会话独立）：状态隔离、迁移、工具按 exec 会话读、安全边界、坏文件不覆写。
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
const NL = String.fromCharCode(10);

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
const exec = (session) => ({ agent: { session: { id: session } } });
const callTool = async (name, session) => tools.get(name).execute(undefined, exec(session));

test("空会话用内置默认：think/high，且 GET 不建文件", async () => {
  rmSync(statePath, { force: true });
  const s = await (await get("alpha")).json();
  assert.equal(s.mode, "think");
  assert.equal(s.level, "high");
  assert.equal(s.inherited, true);
  assert.equal(s.session, "alpha");
  assert.deepEqual(s.levels, ["off", "high", "max"]);
  assert.equal(s.schema, 6);
  assert.equal(existsSync(statePath), false);
});

test("每个对话各用各的：写 alpha 不影响 beta", async () => {
  await setSession("alpha", "loop", "max");
  let a = await (await get("alpha")).json();
  let b = await (await get("beta")).json();
  assert.equal(a.mode, "loop");
  assert.equal(a.level, "max");
  assert.equal(b.mode, "think", "beta 不该跟着 alpha 变");
  assert.equal(b.level, "high");
  await setSession("beta", "think", "off");
  a = await (await get("alpha")).json();
  b = await (await get("beta")).json();
  assert.equal(a.mode, "loop");
  assert.equal(b.level, "off");
});

test("同一会话内切模式不丢档位", async () => {
  await setSession("gamma", "think", "max");
  await post("gamma", { mode: "loop" });
  let s = await (await get("gamma")).json();
  assert.equal(s.mode, "loop");
  assert.equal(s.level, "max");
  await post("gamma", { level: "off" });
  s = await (await get("gamma")).json();
  assert.equal(s.mode, "loop");
  assert.equal(s.level, "off");
});

test("工具按 exec 里的会话读，不是全局", async () => {
  const a = await callTool("forge_level", "alpha");
  const b = await callTool("forge_level", "beta");
  const a2 = await callTool("clarify_tier", "alpha");
  assert.equal(a.forge, "max");
  assert.equal(a.session, "alpha");
  assert.equal(b.forge, "off", "beta 是思考模式，不该读成循环");
  assert.equal(a2.tier, "off");
});

test("工具拿不到 exec 会话时落 default", async () => {
  const f = await tools.get("forge_level").execute();
  assert.equal(f.session, "default");
});

test("非法值返回 400 且不落盘", async () => {
  await setSession("alpha", "loop", "high");
  const res = await post("alpha", { mode: "ultra", level: "low" });
  assert.equal(res.status, 400);
  const s = await (await get("alpha")).json();
  assert.equal(s.mode, "loop");
  assert.equal(s.level, "high");
});

test("老 schema 5 全局档位迁移成 default 会话", async () => {
  writeFileSync(statePath, JSON.stringify({ mode: "loop", level: "max", schema: 5 }), "utf8");
  const s = await (await get()).json();
  assert.equal(s.session, "default");
  assert.equal(s.mode, "loop");
  assert.equal(s.level, "max");
  const disk = JSON.parse(readFileSync(statePath, "utf8"));
  assert.equal(disk.schema, 6);
  assert.equal(disk.sessions.default.level, "max");
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
  const s = await (await get("alpha")).json();
  assert.equal(s.corrupt, true);
  assert.equal(s.mode, "think");
  assert.equal(readFileSync(statePath, "utf8"), "{oops");
});

test("未知 schema：只读兜底，不降级覆写", async () => {
  const future = JSON.stringify({ schema: 9, sessions: {}, forge: "max" });
  writeFileSync(statePath, future, "utf8");
  const s = await (await get()).json();
  assert.equal(s.unsupported, true);
  assert.equal(readFileSync(statePath, "utf8"), future);
  rmSync(statePath, { force: true }); // 后续用例从干净状态开始
});

test("标量 body 400，宿主不崩", async () => {
  for (const raw of ["5", "null", '"loop"', "[1,2]", "{bad"]) {
    const res = await fetch(BASE, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: raw,
    });
    assert.equal(res.status, 400, `body=${raw} 应被拒绝`);
  }
});

test("安全：跨站 Origin 读写预检全 403", async () => {
  await setSession("alpha", "think", "high");
  const evil = "https://evil.example";
  assert.equal((await post("alpha", { mode: "loop", level: "max" }, { Origin: evil })).status, 403);
  assert.equal((await get("alpha", { Origin: evil })).status, 403);
  assert.equal((await fetch(BASE, { method: "OPTIONS", headers: { Origin: evil } })).status, 403);
  assert.equal((await get("alpha", { Origin: "null" })).status, 403);
  assert.equal((await get("alpha", { Origin: "http://localhost.evil.com" })).status, 403);
  const s = await (await get("alpha")).json();
  assert.equal(s.mode, "think");
});

test("安全：本机 Origin 回显，非 *", async () => {
  const origin = "http://127.0.0.1:57408";
  const res = await get("alpha", { Origin: origin });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("access-control-allow-origin"), origin);
  const pre = await fetch(BASE, { method: "OPTIONS", headers: { Origin: origin } });
  assert.equal(pre.status, 204);
});

test("安全：POST 必须 application/json", async () => {
  const res = await fetch(BASE, {
    method: "POST",
    headers: { "content-type": "text/plain", Origin: "http://127.0.0.1:57408" },
    body: JSON.stringify({ mode: "loop" }),
  });
  assert.equal(res.status, 415);
});

test("写盘失败返回 500", async () => {
  await setSession("alpha", "loop", "max");
  const storages = dirname(statePath);
  rmSync(storages, { recursive: true, force: true });
  writeFileSync(storages, "not a directory", "utf8");
  try {
    const res = await post("alpha", { mode: "think" });
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
    const req = http.get({ host: "127.0.0.1", port: 43991, path, headers }, (res) => {
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

test("SSE 只推给同一会话：alpha 的改动不进 beta 的流", async () => {
  await setSession("alpha", "think", "high");
  await setSession("beta", "think", "high");
  const a = await openStream("alpha", { Origin: "http://127.0.0.1:57408" });
  const b = await openStream("beta");
  try {
    await waitFor(() => a.frames.length >= 1 && b.frames.length >= 1);
    assert.equal(a.frames.at(-1).session, "alpha");
    await post("alpha", { mode: "loop", level: "max" });
    await waitFor(() => a.frames.length >= 2);
    assert.equal(a.frames.at(-1).mode, "loop");
    assert.equal(b.frames.length, 1, "beta 不该收到 alpha 的广播");
  } finally {
    a.req.destroy();
    b.req.destroy();
  }
});

test("SSE 跨站 Origin 被拒", async () => {
  const res = await fetch("http://127.0.0.1:43991/events?session=alpha", {
    headers: { Origin: "https://evil.example" },
  });
  assert.equal(res.status, 403);
});
