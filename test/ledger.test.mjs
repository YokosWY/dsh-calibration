// 回执核对（v3.7.0）：回执里写的条目数，跟落盘文件里的表格数据行对不对得上。
// 起因：五模式都要求「收尾单起一行回执」，但回执是模型自己写的——不给机械核对手段，
// 就等于又回到「说了没做也看不出来」。
import test from "node:test";
import assert from "node:assert";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ledgerRows, verifyOne } from "../lib/verify.js";

const root = mkdtempSync(join(tmpdir(), "ct-ledger-"));
mkdirSync(join(root, "tmp"), { recursive: true });

const LEDGER = `# 候选表

| 名 | 来源 | 已装 | 星数 | 用途 |
|---|---|---|---|---|
| a | github | 否 | 120 | 文本处理 |
| b | github | 否 | 80 | 截图 |
| c | npm | 是 | 10 | 表单 |

查询记录：

- q1 site:github.com skill search
- q2 skill registry
`;

function writeLedger(name, body) {
  const path = join("tmp", name);
  writeFileSync(join(root, path), body, "utf8");
  return path;
}

test("ledgerRows：只数表格数据行，跳过表头与分隔行，正文竖线不算", () => {
  assert.equal(ledgerRows(LEDGER), 3);
  assert.equal(ledgerRows("没有表格\n"), 0);
  assert.equal(ledgerRows("| a | b |\n|---|---|\n| 1 | 2 |\n"), 1, "表头 + 1 数据行");
});

test("kind=ledger：回执数与文件行数一致 → 已核", () => {
  const path = writeLedger("ok.md", LEDGER);
  const r = verifyOne({ text: "候选 3 条", source: { kind: "ledger", path, expect: { candidates: 3 } } }, root);
  assert.equal(r.ok, true, r.reasons.join("；"));
  assert.equal(r.level, "ledger-verified");
  assert.match(r.reasons.join(""), /3 条/);
});

test("kind=ledger：对不上 → 未核，并把两个数都报出来", () => {
  const path = writeLedger("bad.md", LEDGER);
  const r = verifyOne({ text: "候选 8 条", source: { kind: "ledger", path, expect: { candidates: 8 } } }, root);
  assert.equal(r.ok, false);
  assert.match(r.reasons.join(""), /3 条.*8 条.*对不上/);
});

test("kind=ledger：min 模式与「只报数」模式", () => {
  const path = writeLedger("min.md", LEDGER);
  assert.equal(verifyOne({ text: "≥2", source: { kind: "ledger", path, expect: { min: 2 } } }, root).ok, true);
  assert.equal(verifyOne({ text: "≥5", source: { kind: "ledger", path, expect: { min: 5 } } }, root).ok, false);
  const bare = verifyOne({ text: "只报数", source: { kind: "ledger", path } }, root);
  assert.equal(bare.ok, true);
  assert.match(bare.reasons.join(""), /只报数/);
});

test("kind=ledger：文件不在工作区内 / 不存在 → 未核", () => {
  assert.equal(verifyOne({ text: "x", source: { kind: "ledger", path: "../outside.md" } }, root).ok, false);
  assert.equal(verifyOne({ text: "x", source: { kind: "ledger", path: "tmp/nope.md" } }, root).ok, false);
});
