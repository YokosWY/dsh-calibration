// 生成 dsh-calibration-tier 的 docs/demo.svg（v3.5.0：末尾两个轮换格，且两格恒亮）
import { writeFileSync } from "node:fs";

const W = 760;
const H = 400;
const CELL_W = 62;
const CELL_H = 28;
const GAP = 4;
const SEP = 16;
const X0 = 84;

const COLORS = {
  think: "#877be3",
  loop: "#66ae7c",
  counter: "#da7f7f",
  mix: "#cf8a4a",
  route: "#3a9ad9",
  agent: "#24543f",
};

const out = [];

function cell(x, y, label, color, on) {
  const fill = on ? color : "none";
  out.push(
    `    <rect x="${x}" y="${y}" width="${CELL_W}" height="${CELL_H}" rx="14" fill="${fill}"` +
      (on ? "" : ` stroke="${color}" stroke-opacity=".45"`),
    `/>`,
  );
  out.push(
    `    <text class="cell${on ? " on" : ""}" x="${x + CELL_W / 2}" y="${y + 18}" text-anchor="middle">${label}</text>`,
  );
}

function sep(x, y) {
  out.push(`    <rect x="${x}" y="${y + 5}" width="1" height="18" fill="#7f7f8a" fill-opacity=".38"/>`);
}

// tokens：cell 或 sep；末尾两个轮换格恒亮（route/agent 永远 on）
function row(label, y, spec) {
  out.push(`  <text class="sub" x="32" y="${y + 18}">${label}</text>`);
  let x = X0;
  const tokens = [
    ["cell", ...spec.levels[0]],
    ["cell", ...spec.levels[1]],
    ["cell", ...spec.levels[2]],
    ["sep"],
    ["cell", "循环", "loop", spec.loopOn],
    ["sep"],
    ["cell", "对抗", "counter", spec.counterOn],
    ["sep"],
    ["cell", spec.route, "route", true],
    ["sep"],
    ["cell", spec.agent, "agent", true],
  ];
  for (const t of tokens) {
    if (t[0] === "sep") {
      sep(x + SEP / 2, y);
      x += SEP;
      continue;
    }
    cell(x, y, t[1], COLORS[t[2]], t[3]);
    x += CELL_W + GAP;
  }
}

row("思考", 92, {
  levels: [
    ["常规", "think", false],
    ["严格", "think", true],
    ["极致", "think", false],
  ],
  loopOn: false,
  counterOn: false,
  route: "本地",
  agent: "默认",
});

row("循环+对抗", 148, {
  levels: [
    ["轻量", "mix", false],
    ["交付", "mix", true],
    ["极致", "mix", false],
  ],
  loopOn: true,
  counterOn: true,
  route: "本地",
  agent: "默认",
});

row("检索·全量", 204, {
  levels: [
    ["常规", "think", false],
    ["严格", "think", true],
    ["极致", "think", false],
  ],
  loopOn: false,
  counterOn: false,
  route: "全量",
  agent: "默认",
});

row("代理·性能", 260, {
  levels: [
    ["常规", "think", false],
    ["严格", "think", true],
    ["极致", "think", false],
  ],
  loopOn: false,
  counterOn: false,
  route: "本地",
  agent: "性能",
});

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="dsh-calibration-tier 同框五模式演示：思考 / 循环 / 对抗 / 检索 / 代理；检索与代理各是一个轮换格，排在选项条末尾且恒亮">
  <defs>
    <style>
      .title { font: 600 18px/1.2 "Segoe UI", "Microsoft YaHei", sans-serif; fill: #e8e8ef; }
      .sub { font: 400 12px/1.2 "Segoe UI", "Microsoft YaHei", sans-serif; fill: #9aa0b4; }
      .cell { font: 500 12px/1 "Segoe UI", "Microsoft YaHei", sans-serif; fill: #c9c9d6; }
      .on { fill: #ffffff; font-weight: 600; }
      .foot { font: 400 11px/1.2 "Segoe UI", "Microsoft YaHei", sans-serif; fill: #8f94a8; }
    </style>
  </defs>
  <rect width="${W}" height="${H}" fill="#14151c"/>
  <text class="title" x="32" y="40">dsh-calibration-tier · 同框五模式</text>
  <text class="sub" x="32" y="62">思考 ⇄ 循环 互斥切换；「对抗」可叠加；检索与代理各一格，排在最后，点一下走一档</text>
${out.join("\n")}

  <text class="foot" x="32" y="330">常规 / 严格 / 极致 = 问多深   ·   轻量 / 交付 / 极致 = 磨几轮（3 / 5 / 8）   ·   本地 / 增量 / 全量 = 找多宽   ·   默认 / 效率 / 性能 = 派谁</text>
  <text class="foot" x="32" y="354">检索格：本地 → 增量 → 全量 → 本地；代理格：默认 → 效率 → 性能 → 默认（v3.5.0 各一格，排在选项条末尾）</text>
  <text class="foot" x="32" y="378">两格恒亮：本地也天蓝 #3a9ad9、默认也墨绿 #24543f；循环 + 对抗 同开时等级格转橙 #cf8a4a</text>
</svg>
`;

writeFileSync(process.argv[2] || "docs/demo.svg", svg, "utf8");
console.log("written", svg.length, "bytes");
