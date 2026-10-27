#!/usr/bin/env node
// 版本升级：改 VERSION.md、根 package.json，并在 CHANGELOG 顶部插入一条。

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const [kind, ...rest] = process.argv.slice(2);
const message = rest.join(" ").trim();

if (!["patch", "minor", "major"].includes(kind) || message === "") {
  console.log("用法：node scripts/bump.mjs patch|minor|major \"一句话说明\"");
  process.exit(1);
}

const versionFile = path.join(root, "VERSION.md");
const current = readFileSync(versionFile, "utf8").match(/`(\d+\.\d+\.\d+)`/)?.[1] ?? "0.1.0";
const [major, minor, patch] = current.split(".").map(Number);
const next =
  kind === "major" ? `${major + 1}.0.0` : kind === "minor" ? `${major}.${minor + 1}.0` : `${major}.${minor}.${patch + 1}`;

// VERSION.md：只改第一个数字版本号
writeFileSync(versionFile, readFileSync(versionFile, "utf8").replace(`\`${current}\``, `\`${next}\``), "utf8");

// 根 package.json
const pkgFile = path.join(root, "package.json");
const pkg = JSON.parse(readFileSync(pkgFile, "utf8"));
pkg.version = next;
writeFileSync(pkgFile, `${JSON.stringify(pkg, null, 2)}\n`, "utf8");

// CHANGELOG 顶部插入
const changelogFile = path.join(root, "CHANGELOG.md");
const changelog = readFileSync(changelogFile, "utf8");
const heading = "## ";
const index = changelog.indexOf(heading);
const entry = `## ${next}\n\n- ${message}\n\n`;
writeFileSync(changelogFile, `${changelog.slice(0, index)}${entry}${changelog.slice(index)}`, "utf8");

console.log(`版本已升级：${current} → ${next}`);
console.log("下一步：node scripts/check.mjs 确认结构仍完整");
