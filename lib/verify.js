/**
 * dsh-calibration-tier — `verify_claims` 的机械校验（v3.0.0）
 *
 * 它只能证明「这条断言有一个对应的源」，**不能证明源本身真实**。
 * 所以输出分三态：ok / missing / weak，报告里必须分开写「已核 / 未核 / 核不了」。
 *
 * 安全：
 * - 只读，不联网，不写盘；
 * - 路径必须落在工作区根内（默认 process.cwd()），越界一律拒绝，不尝试「纠正」。
 */
import { readFileSync, statSync, realpathSync } from "node:fs";
import { resolve, relative, isAbsolute } from "node:path";

/** 域名分级：L1 一手/官方，L2 学术，L3 主流媒体，L4 其余。 */
const DOMAIN_TIERS = [
  { tier: "L1", patterns: [/(^|\.)gov$/, /(^|\.)edu$/, /^docs?\./, /(^|\.)w3\.org$/, /(^|\.)ietf\.org$/, /(^|\.)rfc-editor\.org$/, /(^|\.)mozilla\.org$/, /(^|\.)python\.org$/, /(^|\.)nodejs\.org$/, /(^|\.)github\.com$/] },
  { tier: "L2", patterns: [/(^|\.)arxiv\.org$/, /(^|\.)doi\.org$/, /(^|\.)nature\.com$/, /(^|\.)science\.org$/, /(^|\.)ieee\.org$/, /(^|\.)acm\.org$/, /(^|\.)pubmed\.ncbi\.nlm\.nih\.gov$/, /(^|\.)springer\.com$/, /(^|\.)sciencedirect\.com$/] },
  { tier: "L3", patterns: [/(^|\.)reuters\.com$/, /(^|\.)apnews\.com$/, /(^|\.)bbc\.com$/, /(^|\.)bbc\.co\.uk$/, /(^|\.)nytimes\.com$/, /(^|\.)theverge\.com$/, /(^|\.)techcrunch\.com$/, /(^|\.)wikipedia\.org$/] },
];

export function domainTier(hostname) {
  const host = String(hostname || "").toLowerCase();
  for (const group of DOMAIN_TIERS) {
    if (group.patterns.some((re) => re.test(host))) return group.tier;
  }
  return "L4";
}

/** 从断言里抽「可核对的锚点」：数字、引号内短语，都没有就取前 24 字。 */
export function anchorsOf(text) {
  const out = [];
  const nums = String(text).match(/\d+(?:[.,]\d+)?%?/g);
  if (nums) out.push(...nums.map((n) => n.replace(/,/g, "")));
  const quoted = String(text).match(/[「“"']([^」”"']{2,40})[」”"']/g);
  if (quoted) out.push(...quoted.map((q) => q.replace(/^[「“"']|[」”"']$/g, "")));
  if (out.length === 0) {
    const plain = String(text).trim().slice(0, 24);
    if (plain) out.push(plain);
  }
  return out;
}

function insideRoot(root, target) {
  const rel = relative(root, target);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function safeResolve(root, path) {
  const abs = resolve(root, String(path));
  if (!insideRoot(root, abs)) return { ok: false, reason: "outside-workspace" };
  try {
    return { ok: true, abs: realpathSync(abs) };
  } catch {
    return { ok: false, reason: "not-found" };
  }
}

/** 单条校验。返回 { ok, level, reasons[] }。 */
export function verifyOne(claim, root) {
  const text = claim && typeof claim.text === "string" ? claim.text : "";
  const source = claim && claim.source && typeof claim.source === "object" ? claim.source : null;
  if (!text) return { ok: false, level: "missing", reasons: ["claim.text 为空"] };
  if (!source) return { ok: false, level: "missing", reasons: ["未提供 source"] };

  if (source.kind === "file") {
    const resolved = safeResolve(root, source.path || "");
    if (!resolved.ok) return { ok: false, level: "missing", reasons: [resolved.reason] };
    let content;
    try {
      if (statSync(resolved.abs).isDirectory()) return { ok: false, level: "missing", reasons: ["path-is-directory"] };
      content = readFileSync(resolved.abs, "utf8");
    } catch {
      return { ok: false, level: "missing", reasons: ["read-failed"] };
    }
    const lines = content.split(/\r?\n/);
    const line = Number(source.line);
    if (!Number.isInteger(line) || line < 1 || line > lines.length) {
      return { ok: false, level: "missing", reasons: [`行号超出范围（文件共 ${lines.length} 行）`] };
    }
    const from = Math.max(0, line - 1 - 3);
    const to = Math.min(lines.length, line + 3);
    const window = lines.slice(from, to).join("\n").replace(/,/g, "");
    const anchors = anchorsOf(text);
    const hit = anchors.filter((a) => window.includes(a));
    if (hit.length === 0) {
      return { ok: false, level: "missing", reasons: [`第 ${line} 行 ±3 行内找不到锚点：${anchors.slice(0, 3).join(" / ")}`] };
    }
    return { ok: true, level: "file-verified", reasons: [`命中锚点 ${hit.length}/${anchors.length} 条（文件 ${resolved.abs}）`] };
  }

  if (source.kind === "url") {
    let url;
    try {
      url = new URL(String(source.url || ""));
    } catch {
      return { ok: false, level: "missing", reasons: ["URL 语法不合法"] };
    }
    if (!/^https?:$/.test(url.protocol)) return { ok: false, level: "missing", reasons: ["只接受 http/https"] };
    const tier = domainTier(url.hostname);
    return { ok: true, level: `url-${tier}`, reasons: [`域名 ${url.hostname} 判为 ${tier}`, "未联网核对内容（只验语法与域名）"] };
  }

  if (source.kind === "command") {
    const snippet = String(source.snippet || "").trim();
    if (!snippet) return { ok: false, level: "missing", reasons: ["command.snippet 为空"] };
    if (/(TODO|<[^>]*>|\.\.\.|…)/.test(snippet)) {
      return { ok: false, level: "weak", reasons: ["片段含占位符，视为未核"] };
    }
    return { ok: null, level: "weak", reasons: ["命令输出无法机械复现，仅确认片段非空"] };
  }

  // 回执核对（v3.7.0）：回执里写的条目数，跟落盘文件里实际的表格行数对不对得上。
  // 只数 Markdown 表格数据行（跳过表头与分隔行），不猜语义——「8 候选」就是 8 行。
  if (source.kind === "ledger") {
    const resolved = safeResolve(root, source.path || "");
    if (!resolved.ok) return { ok: false, level: "missing", reasons: [resolved.reason] };
    if (statSync(resolved.abs).isDirectory()) return { ok: false, level: "missing", reasons: ["path-is-directory"] };
    let content;
    try {
      content = readFileSync(resolved.abs, "utf8");
    } catch {
      return { ok: false, level: "missing", reasons: ["read-failed"] };
    }
    const rows = ledgerRows(content);
    const expect = source.expect && typeof source.expect === "object" ? source.expect : {};
    const want = Number(expect.candidates);
    const min = Number(expect.min);
    if (Number.isFinite(want)) {
      const same = rows === want;
      return {
        ok: same,
        level: same ? "ledger-verified" : "missing",
        reasons: [`表格数据行 ${rows} 条，回执写 ${want} 条${same ? "（一致）" : "（对不上）"}（${resolved.abs}）`],
      };
    }
    if (Number.isFinite(min)) {
      const enough = rows >= min;
      return {
        ok: enough,
        level: enough ? "ledger-verified" : "missing",
        reasons: [`表格数据行 ${rows} 条，回执要求 ≥${min} 条${enough ? "" : "（不够）"}（${resolved.abs}）`],
      };
    }
    return { ok: true, level: "ledger-verified", reasons: [`表格数据行 ${rows} 条（未给期望值，只报数）`] };
  }

  return { ok: false, level: "missing", reasons: [`未知 source.kind：${String(source.kind)}`] };
}

/**
 * 数 Markdown 表格的数据行：每个连续表格块减去表头，分隔行（|---|）跳过。
 * 导出给测试用；只认 `|` 开头的行，别把正文里的竖线算进去。
 */
export function ledgerRows(content) {
  const lines = String(content).split(/\r?\n/);
  let rows = 0;
  let inTable = false;
  let block = 0;
  const flush = () => {
    if (inTable) rows += Math.max(0, block - 1);
    inTable = false;
    block = 0;
  };
  for (const raw of lines) {
    const line = raw.trim();
    if (!line.startsWith("|")) {
      flush();
      continue;
    }
    if (!inTable) {
      inTable = true;
      block = 0;
    }
    if (/^\|[\s:|-]+\|?$/.test(line)) continue;
    block += 1;
  }
  flush();
  return rows;
}

/** 批量校验；root 默认工作区。 */
export function verifyClaims(claims, root = process.cwd()) {
  const list = Array.isArray(claims) ? claims : [];
  const results = list.map((claim, index) => ({ index, ...verifyOne(claim, root) }));
  const counts = { ok: 0, missing: 0, weak: 0 };
  for (const r of results) {
    if (r.ok === true) counts.ok += 1;
    else if (r.level === "weak") counts.weak += 1;
    else counts.missing += 1;
  }
  return { root, total: results.length, counts, results };
}
