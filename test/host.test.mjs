// 宿主半边（v0.9 每轮快照）：会话隔离、轮内冻结、轮间生效、迁移、安全、坏文件不覆写。
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
const exec = (session, turn) => ({ agent: { id: session, session: { id: session }, phase: turn === undefined ? undefined : { turn } } });
const callTool = async (name, session, turn) => tools.get(name).execute(undefined, exec(session, turn));

test("空会话用内置默认：think/high，GET 不建文件", async () => {
  rmSync(statePath, { force: true });
  const s = await (await get("s-inherit")).json();
  assert.equal(s.mode, "think");
  assert.equal(s.level, "high");
  assert.equal(s.inherited, true);
  assert.equal(s.pending, false);
  assert.equal(s.schema, 6);
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
  // 用户在「我思考时」点成循环·极限
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
  const s = await (await get("s-x")).json();
  assert.equal(s.corrupt, true);
  assert.equal(readFileSync(statePath, "utf8"), "{oops");
});

test("未知 schema：只读兜底，不降级覆写", async () => {
  const future = JSON.stringify({ schema: 9, sessions: {}, forge: "max" });
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
