#!/usr/bin/env node
// 选路线：删掉不用的那条，只留一份骨架。删除前二次确认。

import { readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** 两条路线的元信息：目录、保留后的启动命令、端口。 */
const TRACKS = {
  pi: { dir: "track-pi", other: "track-cordis", start: "cd track-pi && npm start", port: 18150, label: "pi 三段式" },
  cordis: { dir: "track-cordis", other: "track-pi", start: "cd track-cordis && npm start", port: 18160, label: "Cordis 插件化" },
};

const [, , arg] = process.argv;
const choice = (arg ?? "").trim().toLowerCase();

if (!(choice in TRACKS)) {
  console.log("用法：node scripts/pick-track.mjs pi|cordis");
  console.log("");
  console.log("  pi      三段式，改一处立刻见效，三天冲刺推荐");
  console.log("  cordis  插件化，服务注册表与依赖注入，分层更清楚");
  console.log("");
  console.log("两条路线的差别见 docs/01-两条路线怎么选.md");
  process.exit(1);
}

const picked = TRACKS[choice];
const dropped = path.join(root, picked.other);

const rl = createInterface({ input: process.stdin, output: process.stdout });
const answer = await rl.question(`将保留 ${picked.label}，删除 ${picked.other}/，此操作不可恢复。输入 yes 继续：`);
rl.close();

if (answer.trim().toLowerCase() !== "yes") {
  console.log("已取消，什么都没有删。");
  process.exit(0);
}

rmSync(dropped, { recursive: true, force: true });
console.log(`已删除 ${picked.other}/`);

// 根 README 与 docs 里提到两条路线的地方，补一句「本项目已选定」。
const marker = `> 本项目已选定 **${picked.label}**，另一条路线已删除。启动：\`${picked.start}\`，端口 ${picked.port}。\n\n`;
const readmeFile = path.join(root, "README.md");
const readme = readFileSync(readmeFile, "utf8");
if (!readme.startsWith(marker)) {
  writeFileSync(readmeFile, `${marker}${readme}`, "utf8");
}

// CHANGELOG 记一笔，方便回溯。
const changelogFile = path.join(root, "CHANGELOG.md");
const changelog = readFileSync(changelogFile, "utf8");
const index = changelog.indexOf("## ");
const entry = `## 路线选定\n\n- 选择 ${picked.label}，删除 ${picked.other}/。\n\n`;
writeFileSync(changelogFile, `${changelog.slice(0, index)}${entry}${changelog.slice(index)}`, "utf8");

console.log("");
console.log("接下来：");
console.log(`  1. ${picked.start}`);
console.log(`  2. 浏览器打开 http://127.0.0.1:${picked.port}/`);
console.log("  3. 按 docs/02-三天怎么排.md 推进");
