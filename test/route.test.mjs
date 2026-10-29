// 检索档位：可执行步骤 + 必交落盘 + 收尾回执（v3.6.0）
// 起因：v3.0.0 只给一句口径，切了档模型看不出要做什么、事后验不出做没做。
import test from "node:test";
import assert from "node:assert";
import { ROUTE_PLAN, routePlan } from "../lib/core.js";
import { routeLine } from "../lib/tools.js";

const DAY = new Date(2026, 9, 29); // 本地时区 2026-10-29

test("增量档：编号步骤 + 带日期的落盘 + 回执行", () => {
  const line = routeLine(routePlan(true, "high"), DAY);
  assert.match(line, /检索=增量/);
  assert.match(line, /1\) 本地先盘点/);
  assert.ok(line.includes("tmp\\skill-scan-20261029.md"), "候选表落盘路径要带当天日期");
  assert.match(line, /检索回执：增量/);
  assert.match(line, /没落盘就不许写这行/);
});

test("全量档：候选 ≥20、同组对比、判别卡落盘", () => {
  const line = routeLine(routePlan(true, "max"), DAY);
  assert.match(line, /检索=全量/);
  assert.match(line, /候选 ≥20/);
  assert.match(line, /组对比/);
  assert.ok(line.includes("tmp\\skill-scan-full-20261029.md"));
});

test("关着：只回一行「本地」，不带步骤与回执", () => {
  assert.equal(routeLine(routePlan(false, "high")), "检索：关（本地行为，按需 ls/read）");
});

test("plan 缺 ledger 时不留空落盘路径", () => {
  const line = routeLine(
    {
      on: true,
      label: "增量",
      plan: {
        scope: "local",
        network: true,
        queries: "≥3 组",
        reads: "≤3 篇",
        artifact: "候选表",
        receipt: "检索回执：增量 · {queries} 查询",
        guard: "只跑首轮",
      },
    },
    DAY,
  );
  assert.ok(!line.includes("落盘 "), "没有 ledger 就不该留「落盘 」尾巴");
  assert.ok(!/数字跟\s+里的/.test(line), "回执不该出现空路径");
  assert.match(line, /产出：候选表/);
});

test("两档都有 steps/ledger/receipt，防止回退成一句话", () => {
  for (const lv of ["high", "max"]) {
    const p = ROUTE_PLAN[lv];
    assert.ok(Array.isArray(p.steps) && p.steps.length >= 4, lv + " 至少 4 步");
    assert.ok(p.ledger.includes("<YYYYMMDD>"), lv + " 落盘路径要带日期占位");
    assert.ok(p.receipt.includes("{ledger}"), lv + " 回执要带落盘路径");
    assert.match(p.guard, /未落盘 = 未执行/, lv + " 守卫句要写死");
  }
});
