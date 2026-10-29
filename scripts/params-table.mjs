#!/usr/bin/env node
/**
 * 参数对照表生成器：把 shared/params.ts 的声明回源码逐条核对，再输出 markdown。
 *
 * 三种用法：
 *   node scripts/params-table.mjs                 打印表格到终端
 *   node scripts/params-table.mjs --write         写入 docs/08-金融参数与依据对照表.md
 *   node scripts/params-table.mjs --check         只校验，不打印（供 CI 或提交前跑）
 *
 * 校验三件事，任何一条不过就退出码 1：
 *   1) codeRefs 里的文件存在；
 *   2) 锚点在该文件里**只命中一处** —— 命中多处说明锚点选得太松，得挑更精确的一行；
 *   3) 锚点那一行里确实出现声明的值 —— 防止「表格写 1000、代码改成 800」这种静默漂移。
 *
 * 行号不写死在 params.ts 里，由本脚本搜锚点算出来，所以文件上半部分插几行也不会误报。
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { BASIS_LABEL, GROUP_TITLE, PARAM_CATALOG } from "../shared/params.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const OUT_FILE = path.join(root, "docs", "08-金融参数与依据对照表.md");

const args = new Set(process.argv.slice(2));
const write = args.has("--write");
const checkOnly = args.has("--check");

/** 千分位：120000 → "120,000"。 */
const group = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");

/** 值 → 展示文本。分一律换算成元，避免读者自己去数零。 */
function display(entry) {
  const { value, unit } = entry;
  if (typeof value === "string") return value;
  switch (unit) {
    case "cents":
      return `${group(value / 100)} 元`;
    case "pct":
      return `${Number((value * 100).toFixed(2))}%`;
    case "days":
      return `${value} 天`;
    case "minutes":
      return `${value} 分钟`;
    case "seconds":
      return `${value} 秒`;
    case "count":
      return String(value);
    default:
      return String(value);
  }
}

/** 正则转义：值里有小数点（0.05）时必须转义，否则 . 会匹配任意字符。 */
const escapeRe = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * 解析一处 codeRef：返回真实行号与该行原文。
 * 锚点必须唯一命中 —— 命中多处时宁可报错，也不猜用户指的是哪一处。
 */
function resolveRef(ref) {
  const abs = path.join(root, ref.file);
  if (!existsSync(abs)) {
    return { error: `文件不存在：${ref.file}` };
  }
  const lines = readFileSync(abs, "utf8").split(/\r?\n/);
  const hits = lines
    .map((text, index) => ({ text, line: index + 1 }))
    .filter((item) => item.text.includes(ref.anchor));
  if (hits.length === 0) {
    return { error: `${ref.file} 里找不到锚点「${ref.anchor}」` };
  }
  if (hits.length > 1) {
    const where = hits.map((item) => item.line).join(", ");
    return { error: `${ref.file} 里锚点「${ref.anchor}」命中 ${hits.length} 处（行 ${where}），请换更精确的锚点` };
  }
  return { file: ref.file, line: hits[0].line, text: hits[0].text };
}

/** 校验一行里是否真的出现声明的数字。text 类型的条目不做数字校验。 */
function valueAppears(entry, text) {
  if (typeof entry.value !== "number" || entry.unit === "text" || entry.unit === "level") {
    return true;
  }
  const pattern = new RegExp(`(^|[^0-9.])${escapeRe(String(entry.value))}($|[^0-9])`);
  return pattern.test(text);
}

const problems = [];
const resolved = new Map();

for (const entry of PARAM_CATALOG) {
  const refs = [];
  for (const ref of entry.codeRefs) {
    const hit = resolveRef(ref);
    if (hit.error !== undefined) {
      problems.push(`[${entry.id}] ${hit.error}`);
      continue;
    }
    if (!valueAppears(entry, hit.text)) {
      problems.push(
        `[${entry.id}] ${hit.file}:${hit.line} 里没有出现声明的值 ${JSON.stringify(entry.value)} —— 锚点对上了但数字对不上，表格与代码已经漂移`,
      );
      continue;
    }
    refs.push(hit);
  }
  resolved.set(entry.id, refs);
  if (refs.length !== entry.codeRefs.length) {
    problems.push(`[${entry.id}] 声明了 ${entry.codeRefs.length} 处代码位置，只有 ${refs.length} 处校验通过`);
  }
}

/**
 * 位置列：把一组条目的代码位置按文件合并。
 * 分档参数要传整组（三个档位三行），否则只会显示第一档的行号，看起来像三档共用一处定义。
 */
function refsTextOf(entries) {
  const byFile = new Map();
  for (const entry of entries) {
    for (const ref of resolved.get(entry.id) ?? []) {
      const list = byFile.get(ref.file) ?? [];
      list.push(ref.line);
      byFile.set(ref.file, list);
    }
  }
  if (byFile.size === 0) return "—";
  return [...byFile.entries()]
    .map(([file, lines]) => {
      const sorted = [...new Set(lines)].sort((a, b) => a - b);
      const contiguous = sorted.every((line, index) => index === 0 || line === sorted[index - 1] + 1);
      const span = sorted.length === 1 ? String(sorted[0]) : contiguous ? `${sorted[0]}-${sorted.at(-1)}` : sorted.join(",");
      return `\`${file}:${span}\``;
    })
    .join(" ");
}

const refsText = (entry) => refsTextOf([entry]);

const now = new Date();
const stamp = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")} ${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;

const total = PARAM_CATALOG.length;
/** 组数按 compareKey 算：分档的五个参数各算一组，而不是按三条记录算三组。 */
const groupCount = new Set(PARAM_CATALOG.map((entry) => entry.compareKey ?? entry.id)).size;
const passed = PARAM_CATALOG.filter((entry) => (resolved.get(entry.id) ?? []).length === entry.codeRefs.length).length;
const refCount = PARAM_CATALOG.reduce((sum, entry) => sum + entry.codeRefs.length, 0);
const drift = PARAM_CATALOG.filter((entry) => !entry.singleSource);

/** 按 group 收口，保持 GROUP_TITLE 里定义的顺序。 */
function grouped() {
  const order = Object.keys(GROUP_TITLE);
  const buckets = new Map(order.map((key) => [key, []]));
  for (const entry of PARAM_CATALOG) {
    buckets.get(entry.group).push(entry);
  }
  return [...buckets.entries()].filter(([, list]) => list.length > 0);
}

/** 分档参数横向成表：一行看三档，比三行叠着更容易看出「档位怎么放宽」。 */
function tierTable(entries) {
  const byKey = new Map();
  for (const entry of entries) {
    const key = entry.compareKey ?? entry.id;
    const list = byKey.get(key) ?? [];
    list.push(entry);
    byKey.set(key, list);
  }
  const lines = ["| 参数 | 普通客户 | 金卡客户 | 私行客户 | 依据 | 代码位置 |", "|---|---|---|---|---|---|"];
  for (const list of byKey.values()) {
    const pick = (tier) => {
      const hit = list.find((entry) => entry.tier === tier);
      return hit === undefined ? "—" : display(hit);
    };
    const head = list[0];
    lines.push(
      `| ${head.name} | ${pick("standard")} | ${pick("gold")} | ${pick("private")} | ${BASIS_LABEL[head.basis]} | ${refsTextOf(list)} |`,
    );
  }
  return lines;
}

function flatTable(entries) {
  const lines = ["| 参数 | 取值 | 依据 | 代码位置 |", "|---|---|---|---|"];
  for (const entry of entries) {
    lines.push(`| ${entry.name} | ${display(entry)} | ${BASIS_LABEL[entry.basis]} | ${refsText(entry)} |`);
  }
  return lines;
}

/** 依据说明：表格里只放标签，全文放表下来了，宁可多占几行，也不省略「为什么」。 */
function basisNotes(entries) {
  const seen = new Set();
  const out = [];
  for (const entry of entries) {
    const key = entry.compareKey ?? entry.id;
    if (seen.has(key)) continue;
    seen.add(key);
    // 不重复标类型：表格的「依据」列已经写了，正文再从「演示设定。」起头就啰嗦了。
    out.push(`- **${entry.name}**：${entry.source}`);
    if (entry.note !== undefined) out.push(`  - 备注：${entry.note}`);
  }
  return out;
}

function buildMarkdown() {
  const out = [];
  out.push("# 金融参数与依据对照表");
  out.push("");
  out.push("> 本文件由 `node scripts/params-table.mjs --write` 生成，**请勿手改**。");
  out.push("> 改参数请改代码里的常量，改依据请改 `shared/params.ts`，重跑一次即可。");
  out.push(">");
  out.push(`> 生成时间：${stamp}　｜　${groupCount} 组参数 / ${total} 条记录（分档参数按档展开）　｜　代码位置 ${refCount} 处`);
  out.push(`> 回源码校验：**${passed}/${total} 通过**${problems.length === 0 ? "，表格与代码一致" : `，**${problems.length} 条不一致**`}`);
  out.push("");
  out.push("## 怎么读这张表");
  out.push("");
  out.push("**依据分成三类，不混着写：**");
  out.push("");
  out.push("| 类型 | 含义 | 答辩时怎么说 |");
  out.push("|---|---|---|");
  out.push("| 监管条文 | 有明确文件与口径 | 「这条来自某某办法第几条」 |");
  out.push("| 行业惯例 | 通行做法或精算/会计口径 | 「业界普遍这样取，理由是同履约时效倒推」 |");
  out.push("| 演示设定 | 本项目自定，**不是监管数值** | 「这是我们为了让边界可触发而压低的值，不冒充合规要求」 |");
  out.push("");
  out.push("把所有阈值都说成「合规要求」是最容易翻车的做法 —— 评委问一句「哪个文件规定的 1000 元」就答不上。");
  out.push("所以本表把三类分开标注，**演示值就老实写演示值**。");
  out.push("");

  let index = 0;
  for (const [groupKey, entries] of grouped()) {
    index += 1;
    out.push(`## ${["一", "二", "三", "四", "五", "六"][index - 1] ?? index}、${GROUP_TITLE[groupKey]}`);
    out.push("");
    const tiered = entries.filter((entry) => entry.tier !== undefined);
    if (tiered.length > 0) {
      out.push(...tierTable(tiered));
    }
    const flat = entries.filter((entry) => entry.tier === undefined);
    if (flat.length > 0) {
      if (tiered.length > 0) out.push("");
      out.push(...flatTable(flat));
    }
    out.push("");
    out.push("**依据说明**");
    out.push("");
    out.push(...basisNotes(entries));
    out.push("");
  }

  out.push("## 待收敛：同一含义在多处定义");
  out.push("");
  if (drift.length === 0) {
    out.push("无。所有参数都只有一处定义。");
  } else {
    out.push("| 参数 | 定义处 | 风险 |");
    out.push("|---|---|---|");
    for (const entry of drift) {
      const byFile = new Map();
      for (const ref of entry.codeRefs) {
        byFile.set(ref.file, (byFile.get(ref.file) ?? 0) + 1);
      }
      const where = [...byFile.entries()]
        .map(([file, count]) => (count === 1 ? `\`${file}\`` : `\`${file}\`（${count} 处）`))
        .join("、");
      // 跨文件时把「共几处」放前面，结尾追加会被读成最后一个文件的计数。
      const prefix = byFile.size > 1 ? `共 ${entry.codeRefs.length} 处：` : "";
      out.push(`| ${entry.name} | ${prefix}${where} | 改一处忘另一处即产生不一致，且不会有任何测试报错 |`);
    }
    out.push("");
    out.push("这几条是**已知缺陷**，列出来而不是藏起来：对照表的价值一半在「记了什么」，另一半在「承认哪里还没收敛」。");
  }
  out.push("");

  out.push("## 校验结论");
  out.push("");
  if (problems.length === 0) {
    out.push(`全部 ${total} 条参数的回源码校验通过：文件存在、锚点唯一命中、锚点所在行确实包含声明的值。`);
  } else {
    out.push(`有 ${problems.length} 条不一致，需修复后才能提交：`);
    out.push("");
    for (const item of problems) out.push(`- ${item}`);
  }
  out.push("");
  return out.join("\n");
}

if (!checkOnly) {
  const markdown = buildMarkdown();
  if (write) {
    mkdirSync(path.dirname(OUT_FILE), { recursive: true });
    writeFileSync(OUT_FILE, markdown, "utf8");
    console.log(`已生成 ${path.relative(root, OUT_FILE)}`);
  } else {
    console.log(markdown);
  }
}

if (problems.length === 0) {
  console.log(`参数对照表校验通过：${passed}/${total} 条，代码位置 ${refCount} 处`);
  process.exit(0);
}
console.error(`参数对照表校验失败：${problems.length} 条问题`);
for (const item of problems) console.error(`  - ${item}`);
process.exit(1);
