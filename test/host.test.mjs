// 宿主半边（v0.8 会话隔离 + 开始即锁）：隔离、锁定、409、解锁、迁移、安全、坏文件不覆写。
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

test("空会话用内置默认：think/high，GET 不建文件", async () => {
  rmSync(statePath, { force: true });
  const s = await (await get("s-inherit")).json();
  assert.equal(s.mode, "think");
  assert.equal(s.level, "high");
  assert.equal(s.inherited, true);
  assert.equal(s.locked, false);
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

test("第一次工具调用即冻结：GET 后未锁，工具后锁定", async () => {
  await setSession("s-lock", "loop", "high");
  let s = await (await get("s-lock")).json();
  assert.equal(s.locked, false, "还没开工，不该锁");
  const f = await callTool("forge_level", "s-lock");
  assert.equal(f.forge, "high");
  s = await (await get("s-lock")).json();
  assert.equal(s.locked, true);
  assert.ok(s.lockedAt);
});

test("锁定后误点被拒：409 且档位不变", async () => {
  const before = await (await get("s-lock")).json();
  const res = await post("s-lock", { mode: "think", level: "off" });
  assert.equal(res.status, 409);
  const body = await res.json();
  assert.equal(body.error, "locked");
  const after = await (await get("s-lock")).json();
  assert.equal(after.mode, before.mode);
  assert.equal(after.level, before.level);
  const t = await callTool("clarify_tier", "s-lock");
  assert.equal(t.tier, "off", "循环模式下思考档返回 off");
});

test("锁定只作用于本对话：别的会话照常可写", async () => {
  await setSession("s-other", "think", "high");
  const res = await post("s-other", { level: "max" });
  assert.equal(res.status, 200);
});

test("unlock_tier 解除锁定后可再改", async () => {
  const u = await callTool("unlock_tier", "s-lock");
  assert.equal(u.ok, true);
  const res = await post("s-lock", { mode: "think", level: "high" });
  assert.equal(res.status, 200);
  const s = await (await get("s-lock")).json();
  assert.equal(s.locked, false);
  assert.equal(s.mode, "think");
});

test("工具按 exec 会话读；拿不到落 default 且 default 不锁", async () => {
  const a = await callTool("forge_level", "s-iso-a");
  const b = await callTool("forge_level", "s-iso-b");
  assert.equal(a.forge, "max");
  assert.equal(b.forge, "off");
  const d = await tools.get("forge_level").execute();
  assert.equal(d.session, "default");
  const res = await post(null, { mode: "think", level: "high" });
  assert.equal(res.status, 200, "default 不该被锁");
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

test("SSE 只推同一会话，且帧里带 locked", async () => {
  await setSession("s-sse-a", "think", "high");
  await setSession("s-sse-b", "think", "high");
  const a = await openStream("s-sse-a");
  const b = await openStream("s-sse-b");
  try {
    await waitFor(() => a.frames.length >= 1 && b.frames.length >= 1);
    await post("s-sse-a", { mode: "loop", level: "max" });
    await waitFor(() => a.frames.length >= 2);
    assert.equal(a.frames.at(-1).mode, "loop");
    assert.equal(typeof a.frames.at(-1).locked, "boolean");
    assert.equal(b.frames.length, 1, "b 不该收到 a 的广播");
  } finally {
    a.req.destroy();
    b.req.destroy();
  }
});
