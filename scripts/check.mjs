#!/usr/bin/env node
// 结构自检：必需文件、密钥泄漏、JSON 合法性。不过就退出码 1。

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** 必需文件清单：缺一个就不算完整。 */
const REQUIRED = [
  "README.md",
  "AGENTS.md",
  "VERSION.md",
  "CHANGELOG.md",
  "docs/00-从这里开始.md",
  "docs/01-两条路线怎么选.md",
  "docs/02-三天怎么排.md",
  "docs/03-架构与分层.md",
  "docs/04-渠道与交付.md",
  "docs/05-常见坑.md",
  "docs/06-零基础装环境.md",
  "docs/07-赛题对照.md",
  "prompts/01-选择路线.md",
  "prompts/02-三天冲刺.md",
  "prompts/03-交付自检.md",
  "prompts/04-完整实现.md",
  "agents/architect.md",
  "agents/backend.md",
  "agents/frontend.md",
  "agents/security.md",
  "agents/qa.md",
  "agents/reviewer.md",
  "review/code-review.md",
  "review/security-review.md",
  "review/ui-review.md",
  "review/release-gate.md",
  "skills/bank-intent/SKILL.md",
  "skills/risk-arbitration/SKILL.md",
  "skills/audit-chain/SKILL.md",
  "skills/im-channel/SKILL.md",
  "skills/prompt-engineering/SKILL.md",
  "mcp/servers.json",
  "mcp/_server.mjs",
  "mcp/fx-server.mjs",
  "mcp/risk-server.mjs",
  "mcp/catalog-server.mjs",
  "channels/wecom.mjs",
  "channels/generic-webhook.mjs",
  "channels/run-webhook.mjs",
  "shared/state.ts",
  "shared/rules.ts",
  "shared/mcp-client.ts",
  "shared/persist.ts",
  "shared/compensation.ts",
  "shared/bills.ts",
  "web/index.html",
  "web/src/main.ts",
  "web/src/styles.css",
  "scripts/check.mjs",
  "scripts/smoke.mjs",
  "scripts/verify-cases.mjs",
  "scripts/rules.test.mjs",
  "scripts/demo.mjs",
  "scripts/bump.mjs",
  "scripts/pick-track.mjs",
];

/** 路线专属文件：选完路线另一条会被删，所以只校验仓库里实际存在的那条。 */
const TRACK_FILES = {
  "track-pi": ["src/index.ts", "src/agent.ts", "src/transport.ts"],
  "track-cordis": [
    "src/index.ts",
    "src/kernel.ts",
    "src/plugins/state.ts",
    "src/plugins/transport.ts",
    "src/plugins/policy.ts",
    "src/plugins/agent.ts",
  ],
};

const activeTracks = Object.keys(TRACK_FILES).filter((dir) => existsSync(path.join(root, dir)));
if (activeTracks.length === 0) {
  console.log("未找到任何路线目录：track-pi 或 track-cordis 至少要存在一个");
  process.exit(1);
}
const expected = [...REQUIRED, ...activeTracks.flatMap((dir) => TRACK_FILES[dir].map((file) => `${dir}/${file}`))];

/** 密钥特征：命中即阻断。占位写法（your-、填写、xxx）不算泄漏。 */
const SECRET_PATTERNS = [
  { name: "OpenAI 风格密钥", pattern: /sk-[A-Za-z0-9]{16,}/ },
  { name: "DeepSeek 密钥赋值", pattern: /DEEPSEEK_API_KEY\s*=\s*["'](?!your-|填写|你的|xxx)[^"']{8,}["']/i },
  { name: "企业微信密钥赋值", pattern: /WECOM_SECRET\s*=\s*["'](?!your-|填写|你的|xxx)[^"']{8,}["']/i },
  { name: "私钥块", pattern: /-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
];

/** 扫描目录：跳过依赖与构建产物。 */
const SKIP = new Set(["node_modules", "dist", ".git", ".probe", ".vitest-cache"]);

function walk(dir, files = []) {
  for (const entry of readdirSync(dir)) {
    if (SKIP.has(entry)) continue;
    const absolute = path.join(dir, entry);
    if (statSync(absolute).isDirectory()) walk(absolute, files);
    else files.push(absolute);
  }
  return files;
}

const missing = expected.filter((item) => !existsSync(path.join(root, item)));
const leaks = [];
for (const file of walk(root)) {
  if (/\.(png|jpg|jpeg|gif|ico|woff2?)$/i.test(file)) continue;
  const text = readFileSync(file, "utf8");
  for (const { name, pattern } of SECRET_PATTERNS) {
    if (pattern.test(text)) leaks.push(`${path.relative(root, file)} 命中 ${name}`);
  }
}

const badJson = [];
for (const file of walk(root)) {
  if (!file.endsWith(".json")) continue;
  try {
    JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    badJson.push(`${path.relative(root, file)}：${error.message}`);
  }
}

const version = readFileSync(path.join(root, "VERSION.md"), "utf8").match(/`(\d+\.\d+\.\d+)`/)?.[1] ?? "";

console.log(`结构自检：${expected.length - missing.length}/${expected.length} 项就绪（路线：${activeTracks.join("、")}）`);
if (missing.length > 0) {
  console.log("缺失文件：");
  for (const item of missing) console.log(`  - ${item}`);
}
if (leaks.length > 0) {
  console.log("发现疑似密钥：");
  for (const item of leaks) console.log(`  - ${item}`);
}
if (badJson.length > 0) {
  console.log("JSON 不合法：");
  for (const item of badJson) console.log(`  - ${item}`);
}
console.log(`版本号：${version === "" ? "未识别" : version}`);

const failed = missing.length + leaks.length + badJson.length;
console.log("");
console.log(failed === 0 ? "结构自检通过" : `结构自检未通过，共 ${failed} 项问题`);
process.exit(failed === 0 ? 0 : 1);
