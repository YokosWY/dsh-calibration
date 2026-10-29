import { test } from "node:test";
import assert from "node:assert/strict";
import { FANOUT_RULES, FANOUT_NEVER, fanoutLine, fanoutPlan } from "../lib/fanout.js";

test("fanoutLine：带上限，缺省回 2，异常值兜底", () => {
  assert.match(fanoutLine({ maxChildren: 3 }), /<=3 块/);
  assert.match(fanoutLine(), /<=2 块/);
  assert.match(fanoutLine({ maxChildren: 0 }), /<=2 块/);
  assert.match(fanoutLine({ maxChildren: "3" }), /<=3 块/);
  assert.match(fanoutLine({ maxChildren: -1 }), /<=2 块/);
});

test("fanoutPlan：结构化快照、条数与副本语义", () => {
  const p = fanoutPlan({ maxChildren: 2 });
  assert.equal(p.maxBlocks, 2);
  assert.equal(p.rules.length, FANOUT_RULES.length);
  assert.equal(p.never.length, FANOUT_NEVER.length);
  assert.ok(p.rules.every((x) => typeof x === "string" && x.length > 0));
  // 快照必须是副本：改它不影响常量
  const before = FANOUT_RULES.length;
  p.rules.push("x");
  assert.equal(FANOUT_RULES.length, before);
});

test("fanoutLine：只给一行，不灌全文", () => {
  const line = fanoutLine({ maxChildren: 3 });
  assert.ok(line.length < 120, `一行应短，实际 ${line.length}`);
  assert.ok(!line.includes("\n"));
  // 判据全文只在 fanoutPlan 里，注入行不该出现公式
  assert.ok(!line.includes("ceil"));
});
