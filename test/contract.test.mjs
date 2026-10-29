// 五模式统一契约（v3.7.0）：steps / ledger / receipt / guard 必须齐，渲染顺序固定。
// 起因：v3.6.0 只给检索补了可执行清单，think/loop/counter/agent 仍是一句口径，切了档看不出差别。
import test from "node:test";
import assert from "node:assert";
import { AGENT_PLAN, LOOP_PLAN, THINK_PLAN, counterPlan, routePlan, thinkPlan } from "../lib/core.js";
import { counterLineOf, loopLine, renderContract, thinkLine, routeLine } from "../lib/tools.js";

const DAY = new Date(2026, 9, 29); // 本地时区 2026-10-29

test("renderContract：头 → 编号步骤 → 提问 → 落盘 → 回执 → 守卫，顺序固定", () => {
  const out = renderContract(
    "头行",
    {
      steps: ["第一步 <LEDGER>", "第二步"],
      ledger: "tmp\\x-<YYYYMMDD>.md",
      ask: "只问会改变执行的分歧",
      artifact: "清单",
      receipt: "某回执：{queries} 查询 · {ledger}",
      guard: "守卫句",
    },
    DAY,
  );
  const lines = out.split("\n");
  assert.equal(lines[0], "头行");
  assert.equal(lines[1], "1) 第一步 tmp\\x-20261029.md", "步骤里的 <LEDGER> 要换成带日期的路径");
  assert.equal(lines[2], "2) 第二步");
  assert.match(out, /提问：只问会改变执行的分歧/);
  assert.match(out, /产出：清单；落盘 tmp\\x-20261029\.md/);
  assert.match(out, /收尾必须在回复末尾单起一行「某回执：<查询数> 查询 · tmp\\x-20261029\.md」/);
  assert.match(out, /没落盘就不许写这行/);
  assert.ok(out.trimEnd().endsWith("守卫句"), "守卫句收尾");
});

test("renderContract：缺 ledger 时不留空路径，回执降级成单句", () => {
  const out = renderContract("头", { steps: ["一步"], receipt: "回执：{checks}/{total}", guard: "g" }, DAY);
  assert.ok(!out.includes("落盘 "), out);
  assert.match(out, /数字跟实际条目一致/);
  assert.ok(!/数字跟\s+里/.test(out), "不该出现空路径");
});

test("思考档：off 无清单，high/max 有步骤与回执", () => {
  const off = thinkLine(thinkPlan("think", "off"), DAY);
  assert.ok(!off.includes("1)"), "常规档不排清单");
  assert.match(off, /按平时标准直接做/);
  for (const lv of ["high", "max"]) {
    const out = thinkLine(thinkPlan("think", lv), DAY);
    assert.match(out, /^思考档位 = /);
    assert.match(out, /1\) /, lv + " 要有编号步骤");
    assert.match(out, /思考回执：/);
    assert.ok(THINK_PLAN[lv].steps.length >= 4);
  }
  assert.match(THINK_PLAN.max.ledger, /<YYYYMMDD>/, "极致档要留证据文件");
  assert.equal(THINK_PLAN.high.ledger, "", "严格档不强制落盘");
});

test("循环档：每档都有步骤与回执，max 落盘单独一个文件", () => {
  for (const lv of ["off", "high", "max"]) {
    const out = loopLine(lv, DAY);
    assert.match(out, /^循环档位 = /);
    assert.match(out, /循环回执：/);
    assert.ok(LOOP_PLAN[lv].steps.length >= 2, lv + " 至少 2 步");
  }
  assert.ok(loopLine("high", DAY).includes("tmp\\forge-20261029.md"));
  assert.ok(loopLine("max", DAY).includes("tmp\\forge-full-20261029.md"));
});

test("对抗档：开着才有步骤，回执带三态收口", () => {
  const on = counterLineOf(counterPlan("think", "high", true), "think", DAY);
  assert.match(on, /^对抗审：开/);
  assert.match(on, /三态收口/);
  assert.match(on, /对抗回执：<模式>/, "回执占位符要保留可读中文名");
  assert.equal(counterLineOf(counterPlan("think", "high", false), "think", DAY), "对抗审：关");
});

test("代理档：两档都有派活步骤与回执", () => {
  for (const p of ["efficiency", "performance"]) {
    assert.ok(AGENT_PLAN[p].steps.length >= 4, p + " 至少 4 步");
    assert.match(AGENT_PLAN[p].receipt, /^代理回执：/);
    assert.match(AGENT_PLAN[p].guard, /赛马/);
  }
});

test("结构守卫：五个模式都带 steps/ledger/receipt/guard 四个字段", () => {
  const plans = [
    ...["off", "high", "max"].map((lv) => ["think:" + lv, THINK_PLAN[lv]]),
    ...["off", "high", "max"].map((lv) => ["loop:" + lv, LOOP_PLAN[lv]]),
    ...["efficiency", "performance"].map((p) => ["agent:" + p, AGENT_PLAN[p]]),
    ["route:high", routePlan(true, "high").plan],
    ["route:max", routePlan(true, "max").plan],
    ["counter:on", counterPlan("think", "high", true)],
  ];
  for (const [name, plan] of plans) {
    for (const key of ["steps", "ledger", "receipt", "guard"]) {
      assert.ok(key in plan, `${name} 缺 ${key}`);
    }
    assert.ok(Array.isArray(plan.steps), `${name}.steps 必须是数组`);
  }
  assert.match(routeLine(routePlan(true, "high"), DAY), /检索回执：增量/);
});
