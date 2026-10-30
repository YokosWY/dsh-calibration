// 可移植性：别人机器上的新模型、图像模型、主模型形状（v3.8.0）
// 依赖 DSH_HOME：在 import 之前指到临时目录，并先写好覆盖配置。
import test from "node:test";
import assert from "node:assert";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "ct-portability-"));
process.env.DSH_HOME = home;
mkdirSync(join(home, "storages"), { recursive: true });
writeFileSync(
  join(home, "storages", "calibration-models.json"),
  JSON.stringify({
    families: [{ match: "acme-super", code: 9, reasoning: 9, writing: 9, longContext: 9, toolUse: 9, tier: "high", cost: 2 }],
    exclude: ["p-b/old-chat"],
    models: { "p-b/looks-like-image": { chat: true } },
  }),
);

const agents = await import("../lib/agents.js");
const tools = await import("../lib/tools.js");

test("families 覆盖：配置里的族排在内置表前面，新模型不用等升级", () => {
  const fam = agents.familyOf("acme-super-9");
  assert.equal(fam.code, 9);
  assert.equal(fam.match, "acme-super");
  // 内置族仍然可用
  assert.equal(agents.familyOf("claude-opus-5-5").reasoning, 10);
});

test("未识别模型仍是 5 分兜底，但带 derived 标记（方便 doctor 提示去覆盖）", () => {
  const fam = agents.familyOf("mystery-model-9");
  assert.equal(fam.code, 5);
  assert.equal(fam.derived, true);
});

test("非聊天模型按 id 剔除；覆盖里 chat:true 可以捞回来", () => {
  assert.equal(agents.isChatModel("grok-imagine-image-2.0"), false);
  assert.equal(agents.isChatModel("grok-imagine-video-1.5-preview"), false);
  assert.equal(agents.isChatModel("claude-opus-5-5"), true);
  assert.equal(agents.isChatModel("looks-like-image", { chat: true }), true);
});

test("resolveRoutes：非聊天与 exclude 都不进候选", async () => {
  agents.invalidateRoutes();
  const ctx = {
    get: () => ({
      listProviders: () => [{ id: "p-b" }],
      listModels: async () => [
        { id: "chat-1" },
        { id: "grok-imagine-image-2.0" },
        { id: "old-chat" },
        { id: "looks-like-image" },
      ],
    }),
  };
  const out = await agents.resolveRoutes(ctx);
  const ids = out.routes.map((r) => r.model).sort();
  assert.deepEqual(ids, ["chat-1", "looks-like-image"], "图像模型与 exclude 都应被剔除，chat:true 的保留");
  agents.invalidateRoutes();
});

test("主模型读取：宿主不同版本暴露的形状都能读", () => {
  assert.deepEqual(tools.mainRouteFromExec({ agent: { model: { provider: "p1", id: "m1" } } }), { provider: "p1", model: "m1" });
  assert.deepEqual(tools.mainRouteFromExec({ model: { provider: "p2", id: "m2" } }), { provider: "p2", model: "m2" });
  assert.deepEqual(tools.mainRouteFromExec({ provider: "p3", model: "m3" }), { provider: "p3", model: "m3" });
  assert.deepEqual(tools.mainRouteFromExec({}), { provider: "", model: "" });
  assert.deepEqual(tools.mainRouteFromExec(null), { provider: "", model: "" });
});
